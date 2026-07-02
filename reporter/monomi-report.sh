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
#   - hub 応答不能時はイベントを `$MONOMI_HOME/outbox/*.json` へ退避（AC-3）。
#   - 次回発火時、outbox 内の未送信分を occurred_at 昇順で先に再送してから
#     当該イベントを送る（AC-4）。
#
# 使い方（install-hooks が settings.json に登録するコマンド形）:
#   echo "$HOOK_JSON" | monomi-report.sh                 # 一般フック（event_type は stdin から）
#   echo "$HOOK_JSON" | monomi-report.sh --subtype permission_prompt   # Notification(matcher)
#
# 環境変数:
#   MONOMI_HOME       ~/.monomi 相当のルート（token / outbox の場所）。既定 $HOME/.monomi
#   MONOMI_HUB_URL    hub のベース URL を丸ごと上書き（例 http://127.0.0.1:47632）。最優先
#   MONOMI_PORT       待受ポートの上書き（MONOMI_HUB_URL 未指定時）
#   MONOMI_DISABLE_JQ 空でなければ jq を使わず bash フォールバック経路を使う（テスト用）
#   MONOMI_DEBUG      空でなければ診断ログを stderr に出す
#
# 重要: この reporter はフック起因で走るため **決してフックを壊さない**。
#       どんな失敗でも最終的に exit 0 する。

# フックを壊さないため set -e は使わない（git 等の想定内 non-zero で落ちないように）。
# 未初期化参照だけは早期に気づけるよう、全変数を明示初期化する。

MONOMI_DEFAULT_PORT=47632
TOOL_SUMMARY_MAX=200

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
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
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

# tool_input から要約に使う代表フィールドを取り出す（command→file_path→path→pattern→url）。
extract_tool_summary() {
  local json=$1
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

# hub のベース URL を解決する。
resolve_hub_url() {
  local config_file=$1
  if [ -n "${MONOMI_HUB_URL:-}" ]; then
    printf '%s' "${MONOMI_HUB_URL%/}"
    return 0
  fi
  local port=${MONOMI_PORT:-}
  if [ -z "$port" ]; then
    port=$(read_config_port "$config_file")
  fi
  if [ -z "$port" ]; then
    port=$MONOMI_DEFAULT_PORT
  fi
  printf 'http://127.0.0.1:%s' "$port"
}

# ファイルの中身を POST する。2xx かつ curl 成功なら 0、それ以外は 1。
#
# セキュリティ上の注意: Authorization ヘッダは `-H` の引数として渡さない。curl の
# コマンドライン引数はプロセス一覧（`ps aux` 等）から同一マシンの他ユーザーにも見える
# ため、そこに Bearer token をそのまま乗せると露出する。curl の `-K`（config ファイル）
# 経由で渡し、ファイルは 600 パーミッションの一時ファイルにして使用後は必ず削除する。
post_json() {
  local url=$1 token=$2 file=$3
  local curlrc
  curlrc=$(mktemp "${TMPDIR:-/tmp}/monomi-curlrc.XXXXXX") || return 1
  chmod 600 "$curlrc"
  {
    printf 'header = "Authorization: Bearer %s"\n' "$token"
    printf 'header = "Content-Type: application/json"\n'
  } >"$curlrc"

  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    --connect-timeout 2 --max-time 8 \
    -X POST \
    -K "$curlrc" \
    --data-binary @"$file" \
    "${url}/api/v1/events" 2>/dev/null)
  local curl_exit=$?
  rm -f "$curlrc"
  if [ "$curl_exit" -ne 0 ]; then
    log_debug "curl failed (exit=$curl_exit) for $url"
    return 1
  fi
  if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 300 ] 2>/dev/null; then
    return 0
  fi
  log_debug "hub returned HTTP $code for $url"
  return 1
}

# outbox 内の全ファイルを occurred_at 昇順で再送する。
# 送れたものは削除。1 件でも送信失敗したらそこで中断し 1 を返す（残りは次回に持ち越す）。
#
# 排他制御: 複数セッションが並行稼働すると、フック発火のたびに reporter プロセスが
# 独立に起動し同一 outbox を共有する。ロック無しだと「ファイル存在確認 → POST → rm」の
# 非原子性（TOCTOU）により、2 プロセスが同じファイルを二重送信しうる。`mkdir` はアトミック
# にディレクトリを作成でき（既存なら失敗する）、macOS 標準 bash（flock(1) 非搭載）でも
# 使える排他ロックとして widely 使われる手法。ロックを取れなければ「他プロセスが処理中」
# とみなし、待たずに今回は flush をスキップする（フックを絶対にブロックしないため）。
flush_outbox() {
  local outbox=$1 url=$2 token=$3
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

  local line file
  # tab 区切りの 2 列目（パス）を取り出して順に送る。
  while IFS=$'\t' read -r _ file; do
    [ -n "$file" ] || continue
    [ -e "$file" ] || continue
    any=1
    if post_json "$url" "$token" "$file"; then
      rm -f "$file"
      log_debug "flushed outbox file: $file"
    else
      log_debug "flush stopped at: $file (hub unreachable)"
      return 1
    fi
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
  tool_summary=$(extract_tool_summary "$hook_json")
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
        occurred_at: $occurred_at
      }' >"$body_file" 2>/dev/null
  else
    # bash フォールバックで JSON を手組み（null は無引用、文字列はエスケープ）。
    local j_remote j_branch j_common j_subtype j_toolname j_toolsummary
    if [ -n "$remote_url" ]; then j_remote="\"$(json_escape "$remote_url")\""; else j_remote='null'; fi
    if [ -n "$branch" ]; then j_branch="\"$(json_escape "$branch")\""; else j_branch='null'; fi
    if [ -n "$common_dir" ]; then j_common="\"$(json_escape "$common_dir")\""; else j_common='null'; fi
    if [ -n "$event_subtype" ]; then j_subtype="\"$(json_escape "$event_subtype")\""; else j_subtype='null'; fi
    if [ -n "$tool_name" ]; then j_toolname="\"$(json_escape "$tool_name")\""; else j_toolname='null'; fi
    if [ -n "$tool_summary" ]; then j_toolsummary="\"$(json_escape "$tool_summary")\""; else j_toolsummary='null'; fi
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
      printf '"occurred_at":"%s"' "$(json_escape "$occurred_at")"
      printf '}'
    } >"$body_file"
  fi

  # --- token 読み込み ------------------------------------------------------
  local token=''
  if [ -f "$token_file" ]; then
    token=$(tr -d '\n\r' <"$token_file")
  fi

  local hub_url
  hub_url=$(resolve_hub_url "$config_file")

  # --- 送信フロー: 先に outbox を流し切り、次に当該イベントを送る ----------
  mkdir -p "$outbox" 2>/dev/null
  flush_outbox "$outbox" "$hub_url" "$token"

  if post_json "$hub_url" "$token" "$body_file"; then
    log_debug 'event delivered'
  else
    save_to_outbox "$outbox" "$body_file" "$occurred_at"
  fi

  rm -f "$body_file"
  return 0
}

main "$@"
# reporter はフックを壊さない: 何があっても最終的に成功終了する。
exit 0
