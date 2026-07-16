#!/usr/bin/env bash
#
# monomi-report.sh - Monomi bash reporter (FR-02)
#
# Claude Code フックから発火し、稼働中の instance/session 情報を hub の
# `POST /api/v1/events` へ送る。macOS の bash 3.2 + curl + git を前提にし、
# jq は「あれば使う／無くても動く」（有無を吸収する）。
#
# 契約（§0.1 / §0.5 / src/hub/dto.ts の rawEventPayloadSchema と一致させること）:
#   - project_key の正規化は hub 側の一手（§0.1）。reporter は
#     `git remote get-url origin` の **生出力** をそのまま `instance.remote_url` に載せる。
#   - 時刻は ISO8601(Z)（§0.5）。hub が受信時に epoch ms へ変換する。
#   - hub 到達先は複数候補（config `hub_endpoints`）を優先順に試し、到達できた先へ POST（FR-04）。
#   - 全候補が応答不能なときのみイベントを `$MONOMI_HOME/outbox/*.json` へ退避（AC-3 / FR-04 AC-2）。
#   - 次回発火時、outbox 内の未送信分を occurred_at 昇順で先に再送してから
#     当該イベントを送る（AC-4）。
#   - `event_type=SessionEnd` は例外経路（release-7 FR-02）: outbox flush をスキップし、
#     先頭候補 hub のみへ connect-timeout=1s/max-time=2s で単発 POST する。セッション終了の
#     grace period 内で完了させるため。失敗時は他イベント種別と同じく outbox へ退避し、
#     次回いずれかのイベント発火時に再送される。SessionEnd 以外は従来の複数候補・最大8sのまま。
#   - ターミナル特定情報（release-23 FR-01）: 毎フックで `terminal`（tty/term_program/
#     tmux_pane/tmux_socket/wsl_distro/wt_session、取得不能は null）を `resolve_tty()` と
#     環境変数から捕捉しペイロードへ含める。`tmux_pane`/`tmux_socket` は `$TMUX` が
#     非空のときのみ設定する。旧 reporter との互換のため hub 側は `terminal` を optional
#     として扱う（reporter 側は常に送る）。
#
# 使い方（install-hooks が settings.json に登録するコマンド形）:
#   echo "$HOOK_JSON" | monomi-report.sh                 # 一般フック（event_type は stdin から）
#   echo "$HOOK_JSON" | monomi-report.sh --subtype permission_prompt   # Notification(matcher)
#
# 環境変数:
#   MONOMI_HOME       ~/.monomi 相当のルート（token / outbox の場所）。既定 $HOME/.monomi
#   MONOMI_HUB_URL    hub のベース URL を丸ごと上書き（例 http://127.0.0.1:47632）。最優先・単一
#   MONOMI_PORT       待受ポートの上書き（MONOMI_HUB_URL 未指定時。単一の loopback 宛）
#     ※ 上記いずれも未指定なら config.yml の `hub_endpoints`（複数候補）を順試行する（FR-04）
#   MONOMI_DISABLE_JQ 空でなければ jq を使わず bash フォールバック経路を使う（テスト用）
#   MONOMI_DEBUG      空でなければ診断ログを stderr に出す
#
# 重要: この reporter はフック起因で走るため **決してフックを壊さない**。
#       どんな失敗でも最終的に exit 0 する。

# フックを壊さないため set -e は使わない（git 等の想定内 non-zero で落ちないように）。
# 未初期化参照だけは早期に気づけるよう、全変数を明示初期化する。

MONOMI_DEFAULT_PORT=47632
TOOL_SUMMARY_MAX=200
# rejected/（4xx 永久エラーの隔離先）に貯める最大件数。超過分は最古から掃除する。
# MONOMI_REJECTED_MAX で上書き可（無限蓄積を防ぐ FR-07 の掃除ポリシー）。
MONOMI_REJECTED_MAX_DEFAULT=200

# 制御文字（U+0001〜U+001F、\n\r\t を除く）を \u00XX へ写す置換表を一度だけ構築する。
# jq 不在フォールバック時に生の制御文字が JSON 文字列へ紛れ込むと hub の JSON パースが
# 落ちて 400（poison-pill）になるため、ここで確実にエスケープする（FR-07 AC-2）。
# U+0000 は bash 変数に保持できず（コマンド置換で除去される）、そもそも到達しないため扱わない。
declare -a MONOMI_CTRL_FROM
declare -a MONOMI_CTRL_TO
_monomi_init_ctrl_escapes() {
  local i oct c hex
  for ((i = 1; i < 32; i++)); do
    # \n(10) \r(13) \t(9) は json_escape の名前付きエスケープで既に処理する。
    case "$i" in
      9 | 10 | 13) continue ;;
    esac
    printf -v oct '%o' "$i"
    printf -v c '%b' "\\0$oct"
    printf -v hex '%02x' "$i"
    MONOMI_CTRL_FROM[${#MONOMI_CTRL_FROM[@]}]=$c
    MONOMI_CTRL_TO[${#MONOMI_CTRL_TO[@]}]="\\u00$hex"
  done
}
_monomi_init_ctrl_escapes

log_debug() {
  if [ -n "${MONOMI_DEBUG:-}" ]; then
    printf 'monomi-report: %s\n' "$*" >&2
  fi
}

have_jq() {
  if [ -n "${MONOMI_DISABLE_JQ:-}" ]; then
    return 1
  fi
  command -v jq >/dev/null 2>&1
}

# JSON 文字列値としての最小エスケープ（bash フォールバック用）。
# バックスラッシュ → クォート → 名前付き制御文字（\n\r\t）→ 残る制御文字 U+0001〜U+001F
# を \u00XX の順で処理する。バックスラッシュを最初に二重化してから残りを足すことで、
# 後段が挿入する `\uXXXX` の先頭バックスラッシュを再エスケープしないようにする。
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  # 残る制御文字（U+0000〜U+001F のうち \n\r\t 以外）を \u00XX に置換（FR-07 AC-2）。
  local i n
  n=${#MONOMI_CTRL_FROM[@]}
  for ((i = 0; i < n; i++)); do
    s=${s//"${MONOMI_CTRL_FROM[$i]}"/${MONOMI_CTRL_TO[$i]}}
  done
  printf '%s' "$s"
}

# TTY 解決（FR-01 AC-1）: $$ から ppid チェーンを最大 15 段辿り、`ps -o tty=` が
# ??/空以外を返した最初の値に /dev/ を前置して返す（bash 3.2 互換、外部コマンドは ps のみ）。
# 非 TTY 実行（CI・デーモン化された祖先等、$$ 自身にも祖先にも制御端末が無い）では
# 何も出力せず失敗を返す（呼び出し元で null 化する）。
resolve_tty() {
  local pid=$$
  local depth tty ppid
  for ((depth = 0; depth < 15; depth++)); do
    [ -n "$pid" ] || break
    tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$tty" ] && [ "$tty" != '??' ]; then
      printf '/dev/%s' "$tty"
      return 0
    fi
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    case "$ppid" in
      '' | 0 | 1 | "$pid") break ;;
    esac
    pid=$ppid
  done
  return 1
}

# stdin JSON からトップレベル文字列フィールドを取り出す。
#   $1: JSON テキスト  $2: キー名
# jq があれば jq -r、無ければ sed の best-effort（エスケープ済みクォートは非対応）。
json_get_string() {
  local json=$1 key=$2
  if have_jq; then
    printf '%s' "$json" | jq -r --arg k "$key" '.[$k] // empty' 2>/dev/null
    return 0
  fi
  # フォールバック: "key" : "value" の最初の一致（値中のエスケープ無し前提）。
  printf '%s' "$json" | tr '\n' ' ' |
    sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# tool_input.<key> の文字列値を取り出す（jq 版。ネスト1段）。
_tool_input_get_jq() {
  local json=$1 key=$2
  printf '%s' "$json" | jq -r --arg k "$key" '(.tool_input // {})[$k] // empty' 2>/dev/null
}

# tool_input.<key> の文字列値を取り出す（jq 無しフォールバック、command/file_path と同じ
# best-effort: JSON 全文から `"key": "value"` の最初の一致を拾う。値中のエスケープは非対応）。
_tool_input_get_sed() {
  local json=$1 key=$2
  printf '%s' "$json" | tr '\n' ' ' |
    sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# Workflow ツールの表示名: name → scriptPath の basename（拡張子 .js 除去）→
# インライン script 内 `name:` の best-effort 抽出 → 固定文言 "workflow"。
# インライン script の抽出は jq 経路のみ（jq 無し版は AC-7 の対象外）。
extract_tool_summary_workflow() {
  local json=$1
  local name script_path base
  if have_jq; then
    name=$(_tool_input_get_jq "$json" 'name')
  else
    name=$(_tool_input_get_sed "$json" 'name')
  fi
  if [ -n "$name" ]; then
    printf '%s' "$name"
    return 0
  fi

  if have_jq; then
    script_path=$(_tool_input_get_jq "$json" 'scriptPath')
  else
    script_path=$(_tool_input_get_sed "$json" 'scriptPath')
  fi
  if [ -n "$script_path" ]; then
    base=$(basename "$script_path")
    printf '%s' "${base%.js}"
    return 0
  fi

  if have_jq; then
    local script_text meta_name
    script_text=$(printf '%s' "$json" | jq -r '(.tool_input // {}).script // empty' 2>/dev/null)
    if [ -n "$script_text" ]; then
      # script 先頭部の meta.name を想定した best-effort 抽出:
      # まず最初に現れる `name: '...'` / `name: "..."` の一致を grep -o で拾い（最初の一致
      # ＝ .* の貪欲マッチで末尾に流れないようにする）、その断片から値だけを sed で取り出す。
      meta_name=$(printf '%s' "$script_text" | tr '\n' ' ' |
        grep -oE "name:[[:space:]]*['\"][^'\"]*['\"]" | head -n 1 |
        sed -n "s/.*['\"]\\([^'\"]*\\)['\"].*/\\1/p")
      if [ -n "$meta_name" ]; then
        printf '%s' "$meta_name"
        return 0
      fi
    fi
  fi

  printf 'workflow'
}

# Task（Agent）ツールの表示名: "<subagent_type>: <description>"（片方欠落時は残る片方のみ、
# 両方欠落なら空文字）。
extract_tool_summary_task() {
  local json=$1
  local subagent desc
  if have_jq; then
    subagent=$(_tool_input_get_jq "$json" 'subagent_type')
    desc=$(_tool_input_get_jq "$json" 'description')
  else
    subagent=$(_tool_input_get_sed "$json" 'subagent_type')
    desc=$(_tool_input_get_sed "$json" 'description')
  fi
  if [ -n "$subagent" ] && [ -n "$desc" ]; then
    printf '%s: %s' "$subagent" "$desc"
  elif [ -n "$subagent" ]; then
    printf '%s' "$subagent"
  elif [ -n "$desc" ]; then
    printf '%s' "$desc"
  fi
}

# Skill ツールの表示名: tool_input.skill。
extract_tool_summary_skill() {
  local json=$1
  if have_jq; then
    _tool_input_get_jq "$json" 'skill'
  else
    _tool_input_get_sed "$json" 'skill'
  fi
}

# tool_input から要約に使う代表フィールドを取り出す。
#   $1: フック JSON全文  $2: tool_name
# tool_name が Workflow/Task(Agent)/Skill のときは専用抽出、それ以外は従来どおり
# command→file_path→path→pattern→url の優先順（回帰なし・AC-6）。
extract_tool_summary() {
  local json=$1 tool_name=$2
  case "$tool_name" in
    Workflow)
      extract_tool_summary_workflow "$json"
      return 0
      ;;
    Task | Agent)
      extract_tool_summary_task "$json"
      return 0
      ;;
    Skill)
      extract_tool_summary_skill "$json"
      return 0
      ;;
  esac

  if have_jq; then
    printf '%s' "$json" |
      jq -r '(.tool_input // {}) | (.command // .file_path // .path // .pattern // .url // empty)' 2>/dev/null
    return 0
  fi
  # フォールバック: tool_input 内の command / file_path を best-effort で。
  local v
  v=$(printf '%s' "$json" | tr '\n' ' ' |
    sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -z "$v" ]; then
    v=$(printf '%s' "$json" | tr '\n' ' ' |
      sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  fi
  printf '%s' "$v"
}

# outbox ファイル 1 件から occurred_at を読む（並べ替えキー用）。
read_occurred_at() {
  local file=$1
  if have_jq; then
    jq -r '.occurred_at // empty' "$file" 2>/dev/null
    return 0
  fi
  tr '\n' ' ' <"$file" |
    sed -n 's/.*"occurred_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# config.yml から port を読む（jq 不使用。単純な `port: NNN` 行）。
read_config_port() {
  local config_file=$1
  [ -f "$config_file" ] || return 0
  sed -n 's/^[[:space:]]*port[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$config_file" | head -n 1
}

# config.yml から device_id を読む（body の device_id 用。hub 側で上書きされるが体裁として送る）。
read_config_device_id() {
  local config_file=$1
  [ -f "$config_file" ] || return 0
  sed -n 's/^[[:space:]]*device_id[[:space:]]*:[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}.*/\1/p' \
    "$config_file" | head -n 1
}

# config.yml の `hub_endpoints` ブロックシーケンスを 1 行 1 URL で読む（jq 不使用・sed のみ）。
# 対象記法（config.ts のスキーマ注釈・config-writer が生成する形。フロー記法 `[a,b]` は非対応）:
#   hub_endpoints:
#     - http://192.168.1.100:47632
#     - http://100.64.0.1:47632
# 手順: `hub_endpoints:` 行から「次のトップレベルキー行（先頭が空白でも '-' でも '#' でもない行）」
# の手前までを範囲抽出し、その中の `- URL` 項目だけを取り出す（引用符の有無どちらも許容）。
read_config_endpoints() {
  local config_file=$1
  [ -f "$config_file" ] || return 0
  sed -n '/^[[:space:]]*hub_endpoints[[:space:]]*:/,/^[^[:space:]#-]/p' "$config_file" |
    sed -n 's/^[[:space:]]*-[[:space:]]*"\{0,1\}\([^"[:space:]]*\)"\{0,1\}.*/\1/p'
}

# hub のベース URL 候補を優先順に 1 行 1 URL で出力する（FR-04）。
# 解決順:
#   1. MONOMI_HUB_URL         — 最優先・単一（AC-3）。フル URL を丸ごと上書き。
#   2. MONOMI_PORT            — 単一 loopback（env 上書き。テスト／単一ポート運用）。
#   3. config の hub_endpoints — 複数候補（child。§0.2 / AC-1）。存在すれば順に試す。
#   4. config.yml の port     — 単一 loopback（hub 自身が自 localhost 宛に送る通常経路）。
#   5. 既定ポート             — 単一 loopback（最後の砦）。
# 3 を 4 の前に置くのは、`hub_endpoints` の存在が「このデバイスは child」という明確な信号であり、
# 万一 child config に古い `port:` 行が残っていてもマルチエンドポイントを無効化しないため。
# hub config は `hub_endpoints` を持たないので 4（loopback）にそのまま落ちる。
# いずれも末尾スラッシュを剥がして返す（POST 時に /api/v1/events を足すため）。
resolve_hub_url() {
  local config_file=$1
  if [ -n "${MONOMI_HUB_URL:-}" ]; then
    printf '%s\n' "${MONOMI_HUB_URL%/}"
    return 0
  fi
  if [ -n "${MONOMI_PORT:-}" ]; then
    printf 'http://127.0.0.1:%s\n' "$MONOMI_PORT"
    return 0
  fi
  local endpoints
  endpoints=$(read_config_endpoints "$config_file")
  if [ -n "$endpoints" ]; then
    local ep
    while IFS= read -r ep; do
      [ -n "$ep" ] || continue
      printf '%s\n' "${ep%/}"
    done <<EOF
$endpoints
EOF
    return 0
  fi
  local port
  port=$(read_config_port "$config_file")
  if [ -n "$port" ]; then
    printf 'http://127.0.0.1:%s\n' "$port"
    return 0
  fi
  printf 'http://127.0.0.1:%s\n' "$MONOMI_DEFAULT_PORT"
}

# ファイルの中身を POST する。戻り値で結果種別を返す（FR-07）:
#   0 = 2xx 成功
#   2 = 4xx 永久エラー（クライアント側の不正。再送しても直らない → rejected へ隔離）
#   1 = 5xx / 接続失敗 / タイムアウト等の一時エラー（後で再試行する）
# 4xx を 2xx/5xx と分けることで、壊れた 1 件（poison-pill）が outbox 全体を閉塞させない。
#
# セキュリティ上の注意: Authorization ヘッダは `-H` の引数として渡さない。curl の
# コマンドライン引数はプロセス一覧（`ps aux` 等）から同一マシンの他ユーザーにも見える
# ため、そこに Bearer token をそのまま乗せると露出する。curl の `-K`（config ファイル）
# 経由で渡し、ファイルは 600 パーミッションの一時ファイルにして使用後は必ず削除する。
post_json() {
  local url=$1 token=$2 file=$3
  # 第4/5引数省略時は既定 2s/8s（既存呼び出し・post_json_multi は無変更・後方互換）。
  # SessionEnd 高速経路（FR-02）は 1s/2s を明示的に渡す。
  local connect_timeout=${4:-2} max_time=${5:-8}
  local curlrc
  curlrc=$(mktemp "${TMPDIR:-/tmp}/monomi-curlrc.XXXXXX") || return 1
  chmod 600 "$curlrc"
  {
    printf 'header = "Authorization: Bearer %s"\n' "$token"
    printf 'header = "Content-Type: application/json"\n'
  } >"$curlrc"

  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout "$connect_timeout" --max-time "$max_time" \
    -X POST \
    -K "$curlrc" \
    --data-binary @"$file" \
    "${url}/api/v1/events" 2>/dev/null)
  local curl_exit=$?
  rm -f "$curlrc"
  if [ "$curl_exit" -ne 0 ]; then
    # 接続拒否・タイムアウト・DNS 失敗など。hub 側の一時的不達とみなし再試行させる。
    log_debug "curl failed (exit=$curl_exit) for $url"
    return 1
  fi
  if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 300 ] 2>/dev/null; then
    return 0
  fi
  if [ "$code" -ge 400 ] 2>/dev/null && [ "$code" -lt 500 ] 2>/dev/null; then
    # 400（不正 JSON / スキーマ不適合）・401（無効/失効トークン）など。再送しても直らない。
    log_debug "hub returned HTTP $code (client error, permanent) for $url"
    return 2
  fi
  # 5xx・3xx・その他 / code が数値でない（curl 成功だが応答異常）は一時エラー扱い。
  log_debug "hub returned HTTP $code (retryable) for $url"
  return 1
}

# 候補 URL 群に対して 1 ファイルを優先順に送る（FR-04 マルチエンドポイント順試行）。
# 最初に「到達」した候補の結果で確定し、戻り値を post_json と同じ意味論に集約する:
#   0 = いずれかの候補で 2xx 配信成功（そこで確定）
#   2 = いずれかの候補で 4xx（到達したが永久エラー → 隔離。他候補は試さない）
#   1 = 全候補が 5xx / 接続失敗（全滅。退避 or 次回再送）
# 5xx / 接続失敗はその候補が「不達」なので次候補へ回す。4xx は「hub には届いたがペイロードが
# 不正」であり、候補群は同一 hub への別経路（LAN / Tailscale 等）を指す前提のため、他候補でも
# 同じ結果になる。ゆえに 4xx は即隔離扱いとして候補ループを継続しない（FR-07 の post_json 戻り値と整合）。
post_json_multi() {
  local token=$1 file=$2
  shift 2
  local url rc
  for url in "$@"; do
    post_json "$url" "$token" "$file"
    rc=$?
    case "$rc" in
      0) return 0 ;;
      2) return 2 ;;
      *) ;; # 5xx / 接続失敗: この候補は不達。次候補へ。
    esac
  done
  return 1
}

# outbox 内の全ファイルを occurred_at 昇順で再送する（FR-07 で 4xx 隔離に対応）。
#   - 2xx 成功 → 削除して次へ。
#   - 4xx 永久エラー → rejected/ へ隔離して次へ（先頭の壊れた 1 件でキュー全体を止めない）。
#   - 5xx / 接続失敗 → そこで中断し 1 を返す（hub 不達。残りは次回へ持ち越す）。
#
# 排他制御: 複数セッションが並行稼働すると、フック発火のたびに reporter プロセスが
# 独立に起動し同一 outbox を共有する。ロック無しだと「ファイル存在確認 → POST → rm」の
# 非原子性（TOCTOU）により、2 プロセスが同じファイルを二重送信しうる。`mkdir` はアトミック
# にディレクトリを作成でき（既存なら失敗する）、macOS 標準 bash（flock(1) 非搭載）でも
# 使える排他ロックとして widely 使われる手法。ロックを取れなければ「他プロセスが処理中」
# とみなし、待たずに今回は flush をスキップする（フックを絶対にブロックしないため）。
flush_outbox() {
  local outbox=$1 token=$2
  shift 2
  # 残余引数は hub 到達先候補（優先順）。各ファイルを post_json_multi で順試行する（FR-04）。
  local -a flush_urls=("$@")
  local lockdir="$outbox/.flush.lock"
  mkdir -p "$outbox" 2>/dev/null
  if ! mkdir "$lockdir" 2>/dev/null; then
    log_debug "outbox flush lock held by another process; skipping flush this run"
    return 0
  fi
  # 関数を抜けるあらゆる経路（return 0/1、末尾到達）でロックを解放する。
  trap 'rmdir "$lockdir" 2>/dev/null' RETURN

  local any=0 f oc
  # occurred_at をキーにして安定ソート（ISO8601(Z) は辞書順＝時刻順）。
  local sorted
  sorted=$(
    for f in "$outbox"/*.json; do
      [ -e "$f" ] || continue
      oc=$(read_occurred_at "$f")
      printf '%s\t%s\n' "$oc" "$f"
    done | LC_ALL=C sort
  )
  [ -n "$sorted" ] || return 0

  local oc file rc
  # tab 区切り: 1 列目 = occurred_at（隔離時のファイル名生成に流用）, 2 列目 = パス。
  while IFS=$'\t' read -r oc file; do
    [ -n "$file" ] || continue
    [ -e "$file" ] || continue
    any=1
    post_json_multi "$token" "$file" "${flush_urls[@]}"
    rc=$?
    case "$rc" in
      0)
        rm -f "$file"
        log_debug "flushed outbox file: $file"
        ;;
      2)
        # 4xx 永久エラー: rejected/ へ隔離して先へ進む（キューを閉塞させない）。
        save_to_rejected "$outbox" "$file" "$oc"
        rm -f "$file"
        log_debug "quarantined 4xx outbox file: $file"
        ;;
      *)
        # 全候補が 5xx / 接続失敗: hub 不達。ここで中断し残りは次回に持ち越す。
        log_debug "flush stopped at: $file (all hub endpoints unreachable / 5xx)"
        return 1
        ;;
    esac
  done <<EOF
$sorted
EOF
  [ "$any" -eq 1 ] || return 0
  return 0
}

# 現在イベントの本文ファイルを outbox へ退避する。
save_to_outbox() {
  local outbox=$1 body_file=$2 occurred_at=$3
  mkdir -p "$outbox"
  local safe stamp name
  safe=$(printf '%s' "$occurred_at" | tr -c 'A-Za-z0-9' '-')
  stamp=$(date -u +%s 2>/dev/null)
  name="${safe}-${stamp}-$$-${RANDOM}.json"
  cp "$body_file" "$outbox/$name"
  log_debug "saved to outbox: $outbox/$name"
}

# 4xx 永久エラーの本文を rejected/ へ隔離退避する（save_to_outbox と対になる、FR-07）。
# outbox 本体（*.json）とは別ディレクトリに置くので再送対象にはならない。退避後は上限を
# 超えないよう prune_rejected で掃除する。
save_to_rejected() {
  local outbox=$1 body_file=$2 occurred_at=$3
  local rejected="$outbox/rejected"
  mkdir -p "$rejected"
  local safe stamp name
  safe=$(printf '%s' "$occurred_at" | tr -c 'A-Za-z0-9' '-')
  stamp=$(date -u +%s 2>/dev/null)
  name="${safe}-${stamp}-$$-${RANDOM}.json"
  cp "$body_file" "$rejected/$name"
  log_debug "quarantined to rejected: $rejected/$name"
  prune_rejected "$rejected"
}

# rejected/ の無限蓄積を防ぐ: 件数が上限を超えたら mtime 最古から超過分を削除する。
# 上限は MONOMI_REJECTED_MAX（未設定/非数値なら MONOMI_REJECTED_MAX_DEFAULT）。
prune_rejected() {
  local rejected=$1
  local max=${MONOMI_REJECTED_MAX:-$MONOMI_REJECTED_MAX_DEFAULT}
  case "$max" in
    '' | *[!0-9]*) max=$MONOMI_REJECTED_MAX_DEFAULT ;;
  esac
  local count remove f
  count=$(ls -1 "$rejected"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "$count" -gt "$max" ] 2>/dev/null || return 0
  remove=$((count - max))
  # -tr = mtime 昇順（最古が先頭）。超過分だけ先頭から削除する。
  ls -1tr "$rejected"/*.json 2>/dev/null | head -n "$remove" | while IFS= read -r f; do
    rm -f "$f"
  done
}

main() {
  # --- 引数解析（event_type / event_subtype の明示指定） -------------------
  local arg_event_type='' arg_subtype=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --subtype)
        arg_subtype=${2:-}
        shift 2 || shift
        ;;
      --subtype=*)
        arg_subtype=${1#--subtype=}
        shift
        ;;
      --event-type)
        arg_event_type=${2:-}
        shift 2 || shift
        ;;
      --event-type=*)
        arg_event_type=${1#--event-type=}
        shift
        ;;
      --help | -h)
        sed -n '2,40p' "$0"
        return 0
        ;;
      *)
        # 位置引数は subtype 指定の簡便形として受ける。
        if [ -z "$arg_subtype" ]; then
          arg_subtype=$1
        fi
        shift
        ;;
    esac
  done

  # --- パス解決 ------------------------------------------------------------
  local home="${MONOMI_HOME:-$HOME/.monomi}"
  local token_file="$home/token"
  local config_file="$home/config.yml"
  local outbox="$home/outbox"

  # --- stdin のフック JSON を読む ------------------------------------------
  local hook_json=''
  if [ ! -t 0 ]; then
    hook_json=$(cat)
  fi

  # --- フィールド抽出 ------------------------------------------------------
  local session_id event_type event_subtype tool_name tool_summary cwd message
  session_id=$(json_get_string "$hook_json" 'session_id')
  event_type=$(json_get_string "$hook_json" 'hook_event_name')
  cwd=$(json_get_string "$hook_json" 'cwd')
  tool_name=$(json_get_string "$hook_json" 'tool_name')
  message=$(json_get_string "$hook_json" 'message')

  # event_type は引数優先、無ければ stdin の hook_event_name。
  if [ -n "$arg_event_type" ]; then
    event_type=$arg_event_type
  fi

  # event_subtype の決定順:
  #   1) --subtype 引数（install-hooks が Notification matcher を渡す想定）
  #   2) stdin の matcher / notification_type フィールド（あれば）
  #   3) Notification のときは message から best-effort 推定
  event_subtype=$arg_subtype
  if [ -z "$event_subtype" ]; then
    event_subtype=$(json_get_string "$hook_json" 'matcher')
  fi
  if [ -z "$event_subtype" ]; then
    event_subtype=$(json_get_string "$hook_json" 'notification_type')
  fi
  if [ -z "$event_subtype" ] && [ "$event_type" = 'Notification' ] && [ -n "$message" ]; then
    case "$message" in
      *permission* | *Permission* | *approve* | *Approve*)
        event_subtype='permission_prompt'
        ;;
      *waiting* | *Waiting* | *idle* | *Idle*)
        event_subtype='idle_prompt'
        ;;
    esac
  fi

  # tool_summary（tool_input からの要約、切り詰め）。
  tool_summary=$(extract_tool_summary "$hook_json" "$tool_name")
  if [ -n "$tool_summary" ]; then
    tool_summary=${tool_summary:0:$TOOL_SUMMARY_MAX}
  fi

  # session_id は必須。取れないときは短命セッションとして扱わず、これ以上進めない。
  if [ -z "$session_id" ]; then
    log_debug 'no session_id in hook payload; nothing to report'
    return 0
  fi
  if [ -z "$event_type" ]; then
    log_debug 'no event_type resolved; nothing to report'
    return 0
  fi

  # --- git 解決（cwd 起点。remote は生出力のまま、正規化は hub 側 §0.1） ----
  local dir="${cwd:-$PWD}"
  local remote_url path_val branch is_git common_dir
  remote_url=$(git -C "$dir" remote get-url origin 2>/dev/null)
  path_val=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$path_val" ]; then
    path_val=$dir
  fi
  if [ "$(git -C "$dir" rev-parse --is-inside-work-tree 2>/dev/null)" = 'true' ]; then
    is_git='true'
  else
    is_git='false'
  fi
  # ブランチ: symbolic-ref はコミット前でも解決でき、detached HEAD では空を返す。
  branch=$(git -C "$dir" symbolic-ref --quiet --short HEAD 2>/dev/null)
  common_dir=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)
  case "$common_dir" in
    '') ;;
    /*) ;;
    *) common_dir="$dir/$common_dir" ;;
  esac

  # --- device_id（体裁。hub が Bearer から権威値で上書きする §0.3） --------
  local device_id
  device_id=$(read_config_device_id "$config_file")
  if [ -z "$device_id" ]; then
    device_id='local'
  fi

  # --- ターミナル特定情報の捕捉（FR-01） -----------------------------------
  # 毎フックで捕捉する（--resume で同一 session_id が別 TTY で再開しうるため
  # SessionStart 限定は不可）。コストは ps 最大数回 + 環境変数参照のみ（AC-4）。
  local term_tty term_program tmux_pane tmux_socket wsl_distro wt_session
  term_tty=$(resolve_tty)
  term_program="${TERM_PROGRAM:-}"
  tmux_pane=''
  tmux_socket=''
  if [ -n "${TMUX:-}" ]; then
    tmux_pane="${TMUX_PANE:-}"
    tmux_socket="${TMUX%%,*}"
  fi
  wsl_distro="${WSL_DISTRO_NAME:-}"
  wt_session="${WT_SESSION:-}"

  # --- occurred_at（ISO8601 Z、§0.5） -------------------------------------
  local occurred_at
  occurred_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # --- 本文 JSON を組み立てて一時ファイルへ -------------------------------
  local body_file
  body_file=$(mktemp "${TMPDIR:-/tmp}/monomi-evt.XXXXXX") || return 0

  if have_jq; then
    jq -n \
      --arg device_id "$device_id" \
      --arg session_id "$session_id" \
      --arg remote_url "$remote_url" \
      --arg path "$path_val" \
      --arg branch "$branch" \
      --argjson is_git_repo "$is_git" \
      --arg common_dir "$common_dir" \
      --arg event_type "$event_type" \
      --arg event_subtype "$event_subtype" \
      --arg tool_name "$tool_name" \
      --arg tool_summary "$tool_summary" \
      --arg occurred_at "$occurred_at" \
      --arg term_tty "$term_tty" \
      --arg term_program "$term_program" \
      --arg tmux_pane "$tmux_pane" \
      --arg tmux_socket "$tmux_socket" \
      --arg wsl_distro "$wsl_distro" \
      --arg wt_session "$wt_session" \
      '{
        device_id: $device_id,
        session_id: $session_id,
        instance: {
          remote_url: (if $remote_url == "" then null else $remote_url end),
          path: $path,
          branch: (if $branch == "" then null else $branch end),
          is_git_repo: $is_git_repo,
          common_dir: (if $common_dir == "" then null else $common_dir end)
        },
        event_type: $event_type,
        event_subtype: (if $event_subtype == "" then null else $event_subtype end),
        tool_name: (if $tool_name == "" then null else $tool_name end),
        tool_summary: (if $tool_summary == "" then null else $tool_summary end),
        occurred_at: $occurred_at,
        terminal: {
          tty: (if $term_tty == "" then null else $term_tty end),
          term_program: (if $term_program == "" then null else $term_program end),
          tmux_pane: (if $tmux_pane == "" then null else $tmux_pane end),
          tmux_socket: (if $tmux_socket == "" then null else $tmux_socket end),
          wsl_distro: (if $wsl_distro == "" then null else $wsl_distro end),
          wt_session: (if $wt_session == "" then null else $wt_session end)
        }
      }' >"$body_file" 2>/dev/null
  else
    # bash フォールバックで JSON を手組み（null は無引用、文字列はエスケープ）。
    local j_remote j_branch j_common j_subtype j_toolname j_toolsummary
    local j_term_tty j_term_program j_tmux_pane j_tmux_socket j_wsl_distro j_wt_session
    if [ -n "$remote_url" ]; then j_remote="\"$(json_escape "$remote_url")\""; else j_remote='null'; fi
    if [ -n "$branch" ]; then j_branch="\"$(json_escape "$branch")\""; else j_branch='null'; fi
    if [ -n "$common_dir" ]; then j_common="\"$(json_escape "$common_dir")\""; else j_common='null'; fi
    if [ -n "$event_subtype" ]; then j_subtype="\"$(json_escape "$event_subtype")\""; else j_subtype='null'; fi
    if [ -n "$tool_name" ]; then j_toolname="\"$(json_escape "$tool_name")\""; else j_toolname='null'; fi
    if [ -n "$tool_summary" ]; then j_toolsummary="\"$(json_escape "$tool_summary")\""; else j_toolsummary='null'; fi
    if [ -n "$term_tty" ]; then j_term_tty="\"$(json_escape "$term_tty")\""; else j_term_tty='null'; fi
    if [ -n "$term_program" ]; then j_term_program="\"$(json_escape "$term_program")\""; else j_term_program='null'; fi
    if [ -n "$tmux_pane" ]; then j_tmux_pane="\"$(json_escape "$tmux_pane")\""; else j_tmux_pane='null'; fi
    if [ -n "$tmux_socket" ]; then j_tmux_socket="\"$(json_escape "$tmux_socket")\""; else j_tmux_socket='null'; fi
    if [ -n "$wsl_distro" ]; then j_wsl_distro="\"$(json_escape "$wsl_distro")\""; else j_wsl_distro='null'; fi
    if [ -n "$wt_session" ]; then j_wt_session="\"$(json_escape "$wt_session")\""; else j_wt_session='null'; fi
    {
      printf '{'
      printf '"device_id":"%s",' "$(json_escape "$device_id")"
      printf '"session_id":"%s",' "$(json_escape "$session_id")"
      printf '"instance":{'
      printf '"remote_url":%s,' "$j_remote"
      printf '"path":"%s",' "$(json_escape "$path_val")"
      printf '"branch":%s,' "$j_branch"
      printf '"is_git_repo":%s,' "$is_git"
      printf '"common_dir":%s' "$j_common"
      printf '},'
      printf '"event_type":"%s",' "$(json_escape "$event_type")"
      printf '"event_subtype":%s,' "$j_subtype"
      printf '"tool_name":%s,' "$j_toolname"
      printf '"tool_summary":%s,' "$j_toolsummary"
      printf '"occurred_at":"%s",' "$(json_escape "$occurred_at")"
      printf '"terminal":{'
      printf '"tty":%s,' "$j_term_tty"
      printf '"term_program":%s,' "$j_term_program"
      printf '"tmux_pane":%s,' "$j_tmux_pane"
      printf '"tmux_socket":%s,' "$j_tmux_socket"
      printf '"wsl_distro":%s,' "$j_wsl_distro"
      printf '"wt_session":%s' "$j_wt_session"
      printf '}'
      printf '}'
    } >"$body_file"
  fi

  # --- token 読み込み ------------------------------------------------------
  local token=''
  if [ -f "$token_file" ]; then
    token=$(tr -d '\n\r' <"$token_file")
  fi

  # hub のベース URL 候補を優先順（1 行 1 URL）に取得して配列へ（FR-04）。
  local -a hub_urls=()
  local _u
  while IFS= read -r _u; do
    [ -n "$_u" ] || continue
    hub_urls[${#hub_urls[@]}]=$_u
  done <<EOF
$(resolve_hub_url "$config_file")
EOF

  # --- 送信フロー -----------------------------------------------------------
  # SessionEnd（FR-02）: セッション終了直後の短い grace period 内で確実に完了させたい
  # ため、outbox flush はスキップ（AC-1）し、先頭候補 1 件のみへ 1s/2s の短タイムアウトで
  # 送る（AC-2）。他候補への順試行はしない（複数候補×8s だと grace period を超えうる）。
  # SessionEnd 以外は従来通り、先に outbox を流し切ってから複数候補・最大8sで送る（AC-6）。
  mkdir -p "$outbox" 2>/dev/null
  # reporter は Node.js 側の ensureMonomiHome() を経由せず ~/.monomi を単独で作成しうる
  # （child デバイスで monomi pair 前に reporter が先に発火する等）。上の mkdir -p は umask
  # 既定パーミッション（通常 0o755）で親ディレクトリ $home を作ってしまうため、
  # ensureMonomiHome()（release-13 FR-01）と同じ 0o700 を無条件・毎回明示 chmod で揃える
  # （known-issues S1 と同じ不変条件: token/DB を格納する $home は常に 0o700 であること）。
  chmod 700 "$home" 2>/dev/null
  local send_rc
  if [ "$event_type" = 'SessionEnd' ]; then
    post_json "${hub_urls[0]:-}" "$token" "$body_file" 1 2
    send_rc=$?
  else
    flush_outbox "$outbox" "$token" "${hub_urls[@]}"
    post_json_multi "$token" "$body_file" "${hub_urls[@]}"
    send_rc=$?
  fi
  case "$send_rc" in
    0)
      log_debug 'event delivered'
      ;;
    2)
      # 4xx 永久エラー: outbox に入れても毎回失敗して閉塞するだけなので直接隔離する。
      save_to_rejected "$outbox" "$body_file" "$occurred_at"
      ;;
    *)
      # 5xx / 接続失敗: 次回フックで再送するため outbox へ退避。
      save_to_outbox "$outbox" "$body_file" "$occurred_at"
      ;;
  esac

  rm -f "$body_file"
  return 0
}

main "$@"
# reporter はフックを壊さない: 何があっても最終的に成功終了する。
exit 0
