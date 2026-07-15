#!/usr/bin/env bash
#
# monomi-report.test.sh - reporter/monomi-report.sh の shell テスト（FR-02 AC-1〜AC-4）
#
# 検証内容:
#   AC-1: 実 hub 起動下で Notification(permission_prompt) 発火 → events に 1 行
#   AC-2: `git remote get-url origin` の生出力がそのまま instance.remote_url で届く
#   AC-3: hub 応答不能時 → ~/.monomi/outbox/*.json に退避
#   AC-4: hub 復旧後 → outbox 内イベントが occurred_at 昇順で再送される
#   FR-07: 4xx 隔離 / 制御文字エスケープ / rejected 上限掃除
#   FR-04: hub_endpoints 順試行 / 全滅時のみ退避 / MONOMI_HUB_URL 最優先
#   FR-02 (release-7): SessionEnd 高速経路 — outbox flush スキップ(AC-1) /
#     先頭候補のみ短タイムアウトで送信(AC-2) / 4xx 隔離(AC-5) /
#     不達時 outbox 退避(AC-4) / ワースト実行時間 <3000ms(AC-7)
#   known-issues S1 (release-13 相当): reporter が ensureMonomiHome() を経由せず単独で
#     作る $MONOMI_HOME も、新規・既存(広い権限)の両方で 0700 に揃うこと
#
# 前提: macOS bash 3.2 / curl / git / node（実 hub と capture server 用）/ sqlite3 /
#       perl（Time::HiRes、SessionEnd のミリ秒精度タイミング計測用。$MONOMI_HOME の
#       権限ビット確認にも使う）。
#       jq はテストハーネス側では使用（reporter 本体は jq 有無を吸収する）。
#
# 使い方: bash reporter/monomi-report.test.sh
# 終了コード: 全 PASS で 0、1 件でも失敗で 1。

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
SCRIPT="$HERE/monomi-report.sh"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf 'ok   - %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL - %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '       %s\n' "$2"
  fi
}

assert_eq() {
  # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1" "expected [$2] got [$3]"
  fi
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/monomi-report-test.XXXXXX")
BG_PIDS=""

cleanup() {
  for p in $BG_PIDS; do
    kill "$p" >/dev/null 2>&1
  done
  # WAL 由来のロックが残らないよう少し待ってから消す。
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# tiny sleep（bash 3.2 に fractional sleep が無い環境の保険）。
nap() {
  sleep "$1" 2>/dev/null || perl -e "select(undef,undef,undef,$1)" 2>/dev/null || true
}

# --- ビルド（dist が無ければ tsc で用意） ---------------------------------
ensure_build() {
  if [ -f "$REPO/dist/hub/serve.js" ]; then
    return 0
  fi
  echo "# building dist ..." >&2
  if [ -x "$REPO/node_modules/.bin/tsc" ]; then
    (cd "$REPO" && "$REPO/node_modules/.bin/tsc" -p "$REPO/tsconfig.json") >&2
  else
    (cd "$REPO" && pnpm build) >&2
  fi
}

# capture server（受信ボディを 1 行ずつ CAP_LOG へ追記して 200 を返す）。
CAP_SERVER_JS="$WORK/capture-server.cjs"
cat >"$CAP_SERVER_JS" <<'JS'
const http = require('http');
const fs = require('fs');
const log = process.env.CAP_LOG;
const portFile = process.env.CAP_PORTFILE;
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8').replace(/\r?\n/g, ' ');
    fs.appendFileSync(log, body + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(srv.address().port));
});
JS

wait_for_file() {
  # $1=path $2=timeout_iterations(0.1s each)
  local path=$1 max=$2 i=0
  while [ "$i" -lt "$max" ]; do
    if [ -s "$path" ]; then
      return 0
    fi
    nap 0.1
    i=$((i + 1))
  done
  return 1
}

wait_for_grep() {
  # $1=file $2=pattern $3=timeout_iterations
  local file=$1 pat=$2 max=$3 i=0
  while [ "$i" -lt "$max" ]; do
    if [ -f "$file" ] && grep -q "$pat" "$file" 2>/dev/null; then
      return 0
    fi
    nap 0.1
    i=$((i + 1))
  done
  return 1
}

make_git_repo() {
  # $1=dir $2=remote_url
  mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" config user.email test@example.com
  git -C "$1" config user.name test
  git -C "$1" remote add origin "$2"
}

# ディレクトリの権限ビットを 4 桁 8 進数文字列で返す。macOS `stat -f` と GNU `stat -c` の
# オプション差異を避けるため perl 経由にする（perl は SessionEnd タイミング計測で既に前提）。
dir_mode() {
  perl -e 'printf "%04o\n", (stat($ARGV[0]))[2] & 07777' "$1" 2>/dev/null
}

hook_json() {
  # $1=event_type $2=cwd $3=message
  printf '{"session_id":"sess-1","hook_event_name":"%s","cwd":"%s","message":"%s"}' \
    "$1" "$2" "$3"
}

# tool_input 付き PreToolUse フック JSON（$4 は tool_input の生 JSON フラグメント。
# 値中にクォートを含めないシンプルなケース向け。複雑な値は tool_hook_json_node を使う）。
tool_hook_json() {
  # $1=session_id $2=cwd $3=tool_name $4=tool_input_json
  printf '{"session_id":"%s","hook_event_name":"PreToolUse","cwd":"%s","tool_name":"%s","tool_input":%s}' \
    "$1" "$2" "$3" "$4"
}

# tool_input 付き PreToolUse フック JSON を node の JSON.stringify で安全に組み立てる
# （script フィールドのようにクォート・改行を含む値向け）。
#   $1=session_id $2=cwd $3=tool_name $4=tool_input_key $5=tool_input_value
tool_hook_json_node() {
  node -e '
    const [sessionId, cwd, toolName, key, value] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      cwd,
      tool_name: toolName,
      tool_input: { [key]: value },
    }));
  ' "$1" "$2" "$3" "$4" "$5"
}

# =========================================================================
# Test 1 (AC-1): 実 hub 起動下で Notification → events に 1 行
# =========================================================================
test_real_hub_records_event() {
  local name='AC-1: real hub records Notification event (events table +1)'
  local hubhome="$WORK/t1-home"
  local repo="$WORK/t1-repo"
  mkdir -p "$hubhome"
  make_git_repo "$repo" "git@github.com:sumihiro/ProjectLens.git"

  # config スキーマは port>=1 を要求するため、OS から空きポートを 1 つ借りて使う。
  local port
  port=$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)));});' 2>/dev/null)
  if [ -z "$port" ]; then
    fail "$name" 'could not allocate a free port'
    return
  fi
  printf 'role: hub\nport: %s\n' "$port" >"$hubhome/config.yml"

  local hublog="$WORK/t1-hub.log"
  MONOMI_HOME="$hubhome" node "$REPO/dist/hub/serve.js" >"$hublog" 2>>"$WORK/t1-hub.err" &
  local hubpid=$!
  BG_PIDS="$BG_PIDS $hubpid"

  if ! wait_for_grep "$hublog" 'listening on' 100; then
    fail "$name" "hub did not start; log: $(cat "$hublog" "$WORK/t1-hub.err" 2>/dev/null)"
    return
  fi

  # reporter は hub と同じ MONOMI_HOME を使い token を共有する。
  local out
  out=$(hook_json 'Notification' "$repo" 'Claude needs your permission to use Bash' |
    MONOMI_HOME="$hubhome" MONOMI_HUB_URL="http://127.0.0.1:$port" \
      "$SCRIPT" --subtype permission_prompt 2>&1)

  # events テーブルを検証（WAL なので別プロセスの sqlite3 でも読める）。
  local db="$hubhome/monomi.db"
  local count etype esub
  count=$(sqlite3 "$db" 'SELECT COUNT(*) FROM events;' 2>/dev/null)
  etype=$(sqlite3 "$db" 'SELECT event_type FROM events LIMIT 1;' 2>/dev/null)
  esub=$(sqlite3 "$db" 'SELECT event_subtype FROM events LIMIT 1;' 2>/dev/null)

  assert_eq "$name (events count == 1)" '1' "$count"
  assert_eq "$name (event_type == Notification)" 'Notification' "$etype"
  assert_eq "$name (event_subtype == permission_prompt)" 'permission_prompt' "$esub"

  kill "$hubpid" >/dev/null 2>&1
}

# =========================================================================
# Test 2 (AC-2): 生 remote がそのまま instance.remote_url で届く
# =========================================================================
test_raw_remote_passthrough() {
  local name='AC-2: raw git remote passed through unchanged'
  local home="$WORK/t2-home"
  local repo="$WORK/t2-repo"
  local raw='git@github.com:sumihiro/ProjectLens.git'
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" "$raw"

  local caplog="$WORK/t2-cap.log"
  local capport="$WORK/t2-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # jq 経路と no-jq 経路の両方で生 remote 透過を確認する。
  local mode
  for mode in jq nojq; do
    : >"$caplog"
    if [ "$mode" = nojq ]; then
      hook_json 'PreToolUse' "$repo" '' |
        MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
          "$SCRIPT" >/dev/null 2>&1
    else
      hook_json 'PreToolUse' "$repo" '' |
        MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
          "$SCRIPT" >/dev/null 2>&1
    fi
    if ! wait_for_file "$caplog" 50; then
      fail "$name ($mode)" 'no request captured'
      continue
    fi
    local got
    got=$(jq -r '.instance.remote_url' "$caplog" 2>/dev/null | head -n 1)
    assert_eq "$name ($mode remote_url raw)" "$raw" "$got"
  done

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 3 (AC-3): hub 応答不能時 → outbox にファイル生成
# =========================================================================
test_outbox_on_hub_down() {
  local name='AC-3: unreachable hub saves event to outbox'
  local home="$WORK/t3-home"
  local repo="$WORK/t3-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 誰も listen していないポートへ向ける（接続拒否）。
  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" MONOMI_HUB_URL='http://127.0.0.1:59991' \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  local n
  n=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (outbox file count == 1)" '1' "$n"

  # 退避ファイルの中身が有効な JSON で当該イベントであること。
  local f et
  f=$(ls -1 "$home"/outbox/*.json 2>/dev/null | head -n 1)
  if [ -n "$f" ]; then
    et=$(jq -r '.event_type' "$f" 2>/dev/null)
    assert_eq "$name (outbox event_type == Notification)" 'Notification' "$et"
  else
    fail "$name (outbox event_type)" 'no outbox file'
  fi
}

# =========================================================================
# Test 4 (AC-4): 復旧後、outbox を occurred_at 昇順で再送してから当該イベント
# =========================================================================
test_outbox_resend_order() {
  local name='AC-4: outbox resent in occurred_at order on recovery'
  local home="$WORK/t4-home"
  local repo="$WORK/t4-repo"
  mkdir -p "$home/outbox"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # outbox 2 件を仕込む。ファイル名の辞書順（aaa→bbb）と occurred_at の時刻順を
  # わざと逆にして、reporter が「ファイル名順」ではなく「occurred_at の中身順」で
  # 再送することを厳密に検証する:
  #   aaa.json = 08:00（新しい） / bbb.json = 06:00（古い）
  #   期待再送順は 06:00(bbb) → 08:00(aaa)。過去日付にして当該イベントより必ず古くする。
  cat >"$home/outbox/aaa.json" <<'JSON'
{"device_id":"local","session_id":"outbox-new","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T08:00:00Z"}
JSON
  cat >"$home/outbox/bbb.json" <<'JSON'
{"device_id":"local","session_id":"outbox-old","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T06:00:00Z"}
JSON

  # capture server を起動（=hub 復旧）。
  local caplog="$WORK/t4-cap.log"
  local capport="$WORK/t4-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # 次回フック発火（当該イベント= now, outbox の 2 件より新しい）。
  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  # 3 件受信を待つ。
  local i=0
  while [ "$i" -lt 50 ]; do
    if [ "$(wc -l <"$caplog" 2>/dev/null | tr -d ' ')" = '3' ]; then
      break
    fi
    nap 0.1
    i=$((i + 1))
  done

  local total
  total=$(wc -l <"$caplog" 2>/dev/null | tr -d ' ')
  assert_eq "$name (received 3 events)" '3' "$total"

  # 先頭 2 件が outbox 由来で occurred_at 昇順（06:00 → 08:00）＝ ファイル名順ではなく
  # 中身の occurred_at 順で再送されたこと。3 件目が当該（今回発火）イベントであること。
  local first second third
  first=$(sed -n '1p' "$caplog" | jq -r '.occurred_at' 2>/dev/null)
  second=$(sed -n '2p' "$caplog" | jq -r '.occurred_at' 2>/dev/null)
  third=$(sed -n '3p' "$caplog" | jq -r '.session_id' 2>/dev/null)
  assert_eq "$name (1st resent == oldest outbox 06:00)" '2020-01-01T06:00:00Z' "$first"
  assert_eq "$name (2nd resent == newer outbox 08:00)" '2020-01-01T08:00:00Z' "$second"
  assert_eq "$name (3rd == current fired event)" 'sess-1' "$third"

  # 再送済み outbox が空になっていること。
  local left
  left=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (outbox drained)" '0' "$left"

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 5 (security fix): Bearer token が curl のコマンドライン引数に乗らない
# =========================================================================
test_token_not_exposed_in_curl_args() {
  local name='security fix: Bearer token not passed as a curl command-line argument'
  local home="$WORK/t5-home"
  local repo="$WORK/t5-repo"
  mkdir -p "$home"
  local token='sekrit-token-abc123'
  printf '%s' "$token" >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # PATH 先頭にダミー curl を置き、実際に渡された引数を記録してから本物の curl へ委譲する。
  # これで「curl のプロセス引数（ps で他ユーザーにも見える）に token 平文が乗っていないか」
  # を確定的に検証できる（capture server のリクエストボディでは分からない）。
  local fakebin="$WORK/t5-bin"
  mkdir -p "$fakebin"
  local argslog="$WORK/t5-curl-args.log"
  : >"$argslog"
  local real_curl
  real_curl=$(command -v curl)
  cat >"$fakebin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$argslog"
exec "$real_curl" "\$@"
EOF
  chmod +x "$fakebin/curl"

  # 誰も listen していないポートへ向け、post_json を確実に一度は呼ばせる（成否は無関係）。
  hook_json 'PreToolUse' "$repo" '' |
    PATH="$fakebin:$PATH" MONOMI_HOME="$home" MONOMI_HUB_URL='http://127.0.0.1:59992' \
      "$SCRIPT" >/dev/null 2>&1

  if [ ! -s "$argslog" ]; then
    fail "$name" 'curl was not invoked; nothing captured'
    return
  fi

  if grep -qF "$token" "$argslog"; then
    fail "$name (token must not appear in curl argv)" "$(cat "$argslog")"
  else
    pass "$name (token must not appear in curl argv)"
  fi

  if grep -q -- '-K' "$argslog"; then
    pass "$name (headers passed via -K config file)"
  else
    fail "$name (headers passed via -K config file)" "$(cat "$argslog")"
  fi
}

# =========================================================================
# Test 6 (bug fix): 並行 flush_outbox が同一 outbox ファイルを二重送信しない
# =========================================================================
test_outbox_concurrent_flush_no_duplicate() {
  local name='bug fix: concurrent flush_outbox does not double-send the same outbox file'
  local home="$WORK/t6-home"
  local repo="$WORK/t6-repo"
  mkdir -p "$home/outbox"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  cat >"$home/outbox/only.json" <<'JSON'
{"device_id":"local","session_id":"outbox-concurrent","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T06:00:00Z"}
JSON

  # 遅延付き capture server（各リクエストを 300ms 待ってから 200 を返す）。
  # 遅延によって「2 プロセスがほぼ同時に flush_outbox に入る」時間窓を作り、
  # ロック無しなら TOCTOU で二重送信が再現する条件を整える。
  local caplog="$WORK/t6-cap.log"
  local capport="$WORK/t6-cap.port"
  : >"$caplog"
  local slow_server="$WORK/slow-capture-server.cjs"
  cat >"$slow_server" <<'JS'
const http = require('http');
const fs = require('fs');
const log = process.env.CAP_LOG;
const portFile = process.env.CAP_PORTFILE;
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8').replace(/\r?\n/g, ' ');
    setTimeout(() => {
      fs.appendFileSync(log, body + '\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, 300);
  });
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(srv.address().port));
});
JS
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$slow_server" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # ほぼ同時に 2 つの reporter プロセスを起動する。両方が同じ outbox を見る。
  hook_json 'PreToolUse' "$repo" '' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1 &
  local p1=$!
  hook_json 'PreToolUse' "$repo" '' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1 &
  local p2=$!
  wait "$p1" "$p2" 2>/dev/null
  nap 0.2

  # outbox 由来イベント（session_id=outbox-concurrent）がちょうど 1 回だけ届くこと
  # （ロックが効いていれば片方はスキップし二重送信しない）。
  local dup_count
  dup_count=$(grep -c 'outbox-concurrent' "$caplog" 2>/dev/null)
  assert_eq "$name (outbox event delivered exactly once)" '1' "$dup_count"

  # ロックディレクトリが最終的に残っていない（両プロセスとも解放できている）こと。
  if [ -d "$home/outbox/.flush.lock" ]; then
    fail "$name (lock released after use)" 'lock directory still present'
  else
    pass "$name (lock released after use)"
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 7 (FR-07 AC-3): 先頭 4xx が後続を閉塞せず、正常が配信され rejected 残存
# =========================================================================
# 選択的 capture server: body に marker を含めば 400（永久エラー）を返す。それ以外は
# CAP_LOG へ追記して 200。「4xx の 1 件がキュー先頭にあっても後続正常が配信されるか」を検証。
test_outbox_head_4xx_does_not_block() {
  local name='FR-07 AC-3: head-of-queue 4xx quarantined, subsequent normal delivered'
  local home="$WORK/t7-home"
  local repo="$WORK/t7-repo"
  mkdir -p "$home/outbox"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 先頭（最古 06:00）に永久エラー(poison-4xx)、後続（07:00）に正常イベントを仕込む。
  cat >"$home/outbox/poison.json" <<'JSON'
{"device_id":"local","session_id":"poison-4xx","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T06:00:00Z"}
JSON
  cat >"$home/outbox/good.json" <<'JSON'
{"device_id":"local","session_id":"outbox-good","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T07:00:00Z"}
JSON

  local selective_server="$WORK/selective-server.cjs"
  cat >"$selective_server" <<'JS'
const http = require('http');
const fs = require('fs');
const log = process.env.CAP_LOG;
const portFile = process.env.CAP_PORTFILE;
const marker = process.env.CAP_REJECT_MARKER || 'poison';
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8').replace(/\r?\n/g, ' ');
    if (body.includes(marker)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_payload"}');
      return;
    }
    fs.appendFileSync(log, body + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(srv.address().port));
});
JS

  local caplog="$WORK/t7-cap.log"
  local capport="$WORK/t7-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" CAP_REJECT_MARKER='poison-4xx' \
    node "$selective_server" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # 当該イベント（08:00 相当・session sess-1）を発火。
  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  # 後続正常(outbox-good) と当該(sess-1) の 2 件が配信されるのを待つ。
  wait_for_grep "$caplog" 'sess-1' 50 >/dev/null 2>&1

  if grep -q 'outbox-good' "$caplog" 2>/dev/null; then
    pass "$name (subsequent normal outbox event delivered)"
  else
    fail "$name (subsequent normal outbox event delivered)" "caplog: $(cat "$caplog" 2>/dev/null)"
  fi
  if grep -q 'sess-1' "$caplog" 2>/dev/null; then
    pass "$name (current fired event delivered)"
  else
    fail "$name (current fired event delivered)" "caplog: $(cat "$caplog" 2>/dev/null)"
  fi
  # 4xx イベントは配信されない（rejected 行きで CAP_LOG には現れない）。
  if grep -q 'poison-4xx' "$caplog" 2>/dev/null; then
    fail "$name (4xx event NOT delivered)" 'poison-4xx unexpectedly present in caplog'
  else
    pass "$name (4xx event NOT delivered)"
  fi

  # rejected に隔離ファイルが 1 件残り、当該が poison-4xx であること。
  local rn rf rsid
  rn=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (rejected file count == 1)" '1' "$rn"
  rf=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | head -n 1)
  if [ -n "$rf" ]; then
    rsid=$(jq -r '.session_id' "$rf" 2>/dev/null)
    assert_eq "$name (rejected file is the 4xx event)" 'poison-4xx' "$rsid"
  else
    fail "$name (rejected file is the 4xx event)" 'no rejected file'
  fi

  # outbox 本体（rejected を除く）は空になっていること。
  local left
  left=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (outbox drained)" '0' "$left"

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 8 (FR-07 AC-2): 制御文字が \u00XX にエスケープされ 400 化せず配信される
# =========================================================================
# 厳格 JSON server: 受信ボディを JSON.parse し、失敗なら 400。生の制御文字が escape され
# ずに混じると JSON.parse が落ちて 400（poison-pill）になる。jq 不在フォールバック経路
# （MONOMI_DISABLE_JQ=1）で制御文字入りイベントを送り、正常配信されることを検証する。
test_control_char_escaped_no_400() {
  local name='FR-07 AC-2: control char escaped by json_escape (no 400, delivered)'
  local home="$WORK/t8-home"
  local repo="$WORK/t8-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local strict_server="$WORK/strict-json-server.cjs"
  cat >"$strict_server" <<'JS'
const http = require('http');
const fs = require('fs');
const log = process.env.CAP_LOG;
const portFile = process.env.CAP_PORTFILE;
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      JSON.parse(raw);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_json"}');
      return;
    }
    fs.appendFileSync(log, raw.replace(/\r?\n/g, ' ') + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(srv.address().port));
});
JS

  local caplog="$WORK/t8-cap.log"
  local capport="$WORK/t8-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$strict_server" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'strict server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # tool_input.command に生の制御文字 0x01 を仕込む（printf の \001）。nojq 経路を強制。
  local ctrl_hook
  printf -v ctrl_hook \
    '{"session_id":"sess-ctrl","hook_event_name":"PreToolUse","cwd":"%s","tool_name":"Bash","tool_input":{"command":"a\001b"}}' \
    "$repo"
  printf '%s' "$ctrl_hook" |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
      "$SCRIPT" >/dev/null 2>&1

  wait_for_grep "$caplog" 'sess-ctrl' 50 >/dev/null 2>&1

  # 配信された = 制御文字が正しく escape され有効な JSON だった（JSON.parse 成功）。
  if grep -q 'sess-ctrl' "$caplog" 2>/dev/null; then
    pass "$name (event with control char delivered, not 400)"
  else
    fail "$name (event with control char delivered, not 400)" "caplog: $(cat "$caplog" 2>/dev/null)"
  fi
  # 制御文字は \u00XX として送られ、jq でデコードすると元の 0x01 に戻ること。
  local got expected
  got=$(jq -r '.tool_summary' "$caplog" 2>/dev/null | head -n 1)
  printf -v expected 'a\001b'
  assert_eq "$name (tool_summary round-trips through \\u0001)" "$expected" "$got"

  # 有効 JSON なので outbox / rejected どちらにも退避されないこと。
  local ob rj
  ob=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  rj=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (not saved to outbox)" '0' "$ob"
  assert_eq "$name (not quarantined to rejected)" '0' "$rj"

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 9 (FR-07): rejected の上限を超えたら最古から掃除され無限蓄積しない
# =========================================================================
test_rejected_cap_prunes_oldest() {
  local name='FR-07: rejected quarantine is capped (oldest pruned)'
  local home="$WORK/t9-home"
  local repo="$WORK/t9-repo"
  mkdir -p "$home/outbox"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 3 件の永久エラー(poison-*)を outbox に仕込む（occurred_at 06/07/08:00）。
  local i
  for i in a b c; do
    local hh
    case "$i" in a) hh='06' ;; b) hh='07' ;; c) hh='08' ;; esac
    cat >"$home/outbox/poison-$i.json" <<JSON
{"device_id":"local","session_id":"poison-$i","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T${hh}:00:00Z"}
JSON
  done

  local selective_server="$WORK/selective-server.cjs"
  if [ ! -f "$selective_server" ]; then
    cat >"$selective_server" <<'JS'
const http = require('http');
const fs = require('fs');
const log = process.env.CAP_LOG;
const portFile = process.env.CAP_PORTFILE;
const marker = process.env.CAP_REJECT_MARKER || 'poison';
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8').replace(/\r?\n/g, ' ');
    if (body.includes(marker)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_payload"}');
      return;
    }
    fs.appendFileSync(log, body + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(srv.address().port));
});
JS
  fi

  local caplog="$WORK/t9-cap.log"
  local capport="$WORK/t9-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" CAP_REJECT_MARKER='poison' \
    node "$selective_server" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # 当該正常イベントを発火。cap=2 を渡して flush 中の隔離で prune を走らせる。
  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_REJECTED_MAX=2 \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  wait_for_grep "$caplog" 'sess-1' 50 >/dev/null 2>&1

  # 3 件 4xx を隔離しても cap=2 で 2 件に抑えられる（最古から削除、無限蓄積しない）。
  local rn
  rn=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (rejected capped at 2)" '2' "$rn"

  # outbox 本体は空、当該イベントは配信されていること。
  local left
  left=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (outbox drained)" '0' "$left"
  if grep -q 'sess-1' "$caplog" 2>/dev/null; then
    pass "$name (current event still delivered)"
  else
    fail "$name (current event still delivered)" "caplog: $(cat "$caplog" 2>/dev/null)"
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 10 (FR-04 AC-1): hub_endpoints を順試行し、先頭が不達でも次候補で配信
# =========================================================================
test_multi_endpoint_ordered_failover() {
  local name='FR-04 AC-1: hub_endpoints tried in order (first down, second up delivers)'
  local home="$WORK/t10-home"
  local repo="$WORK/t10-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 2 番目の候補として capture server（=到達可能な hub）を起動する。
  local caplog="$WORK/t10-cap.log"
  local capport="$WORK/t10-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # config: 1 番目は誰も listen していない死んだポート、2 番目が live capture。
  # MONOMI_HUB_URL / MONOMI_PORT は付けず、hub_endpoints の順試行を強制する。
  cat >"$home/config.yml" <<EOF
role: child
device_id: laptop-t10
hub_endpoints:
  - http://127.0.0.1:59993
  - http://127.0.0.1:$port
EOF

  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  if wait_for_grep "$caplog" 'sess-1' 50; then
    pass "$name (delivered to 2nd endpoint after 1st refused)"
  else
    fail "$name (delivered to 2nd endpoint after 1st refused)" "caplog: $(cat "$caplog" 2>/dev/null)"
  fi
  # ちょうど 1 件だけ受信（候補ループが到達成功で確定＝二重送信しない）。
  local n
  n=$(grep -c 'sess-1' "$caplog" 2>/dev/null)
  assert_eq "$name (delivered exactly once)" '1' "$n"
  # 配信できたので outbox / rejected どちらにも退避されないこと。
  local ob rj
  ob=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  rj=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (not saved to outbox)" '0' "$ob"
  assert_eq "$name (not quarantined to rejected)" '0' "$rj"

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 11 (FR-04 AC-2): 全エンドポイント全滅時のみ outbox へ退避
# =========================================================================
test_multi_endpoint_all_down_saves_outbox() {
  local name='FR-04 AC-2: all hub_endpoints unreachable → event saved to outbox'
  local home="$WORK/t11-home"
  local repo="$WORK/t11-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 両候補とも誰も listen していない死んだポート（接続拒否＝全滅）。
  cat >"$home/config.yml" <<'EOF'
role: child
device_id: laptop-t11
hub_endpoints:
  - http://127.0.0.1:59994
  - http://127.0.0.1:59995
EOF

  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  local n
  n=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (outbox file count == 1)" '1' "$n"
  local f et
  f=$(ls -1 "$home"/outbox/*.json 2>/dev/null | head -n 1)
  if [ -n "$f" ]; then
    et=$(jq -r '.event_type' "$f" 2>/dev/null)
    assert_eq "$name (outbox event_type == Notification)" 'Notification' "$et"
  else
    fail "$name (outbox event_type)" 'no outbox file'
  fi
  # 全滅退避なので rejected（4xx 隔離）には入らないこと。
  local rj
  rj=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (not quarantined to rejected)" '0' "$rj"
}

# =========================================================================
# Test 12 (FR-04 AC-3): MONOMI_HUB_URL が hub_endpoints より最優先（単一）
# =========================================================================
# endpoints 側と override 側、2 つの live capture server を起動して受信先を区別する。
# MONOMI_HUB_URL が最優先なら override 側にだけ届き、config の hub_endpoints 側には
# 一切届かない（＝順試行にすら入らない）ことを厳密に検証する。
test_hub_url_overrides_endpoints() {
  local name='FR-04 AC-3: MONOMI_HUB_URL overrides hub_endpoints (single, highest priority)'
  local home="$WORK/t12-home"
  local repo="$WORK/t12-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog_ep="$WORK/t12-ep.log" capport_ep="$WORK/t12-ep.port"
  local caplog_ov="$WORK/t12-ov.log" capport_ov="$WORK/t12-ov.port"
  : >"$caplog_ep"
  : >"$caplog_ov"
  CAP_LOG="$caplog_ep" CAP_PORTFILE="$capport_ep" node "$CAP_SERVER_JS" &
  local ep_pid=$!
  BG_PIDS="$BG_PIDS $ep_pid"
  CAP_LOG="$caplog_ov" CAP_PORTFILE="$capport_ov" node "$CAP_SERVER_JS" &
  local ov_pid=$!
  BG_PIDS="$BG_PIDS $ov_pid"
  if ! wait_for_file "$capport_ep" 100 || ! wait_for_file "$capport_ov" 100; then
    fail "$name" 'capture servers did not start'
    return
  fi
  local ep_port ov_port
  ep_port=$(cat "$capport_ep")
  ov_port=$(cat "$capport_ov")

  # config は endpoints 側（live）を指すが、MONOMI_HUB_URL は override 側を指す。
  cat >"$home/config.yml" <<EOF
role: child
device_id: laptop-t12
hub_endpoints:
  - http://127.0.0.1:$ep_port
EOF

  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$ov_port" \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  if wait_for_grep "$caplog_ov" 'sess-1' 50; then
    pass "$name (delivered to MONOMI_HUB_URL target)"
  else
    fail "$name (delivered to MONOMI_HUB_URL target)" "ov log: $(cat "$caplog_ov" 2>/dev/null)"
  fi
  # hub_endpoints 側は最優先の MONOMI_HUB_URL に敗けて一切叩かれない。
  local ep_n
  ep_n=$(grep -c 'sess-1' "$caplog_ep" 2>/dev/null)
  assert_eq "$name (hub_endpoints NOT contacted)" '0' "$ep_n"
  # 到達できたので退避も隔離も無し。
  local ob
  ob=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (not saved to outbox)" '0' "$ob"

  kill "$ep_pid" "$ov_pid" >/dev/null 2>&1
}

# =========================================================================
# Test 13 (FR-02 AC-1 / AC-3): SessionEnd は outbox flush をスキップし直接配信
# =========================================================================
# outbox に既存の退避イベントを仕込んだ状態で SessionEnd を発火する。SessionEnd 経路は
# flush_outbox を呼ばないため、既存の outbox イベントは再送されず（capture server に届か
# ず）そのまま残り、当該 SessionEnd イベントだけが届くことを検証する。
test_session_end_skips_outbox_flush() {
  local name='FR-02 AC-1/AC-3: SessionEnd skips outbox flush, delivers directly'
  local home="$WORK/t13-home"
  local repo="$WORK/t13-repo"
  mkdir -p "$home/outbox"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  cat >"$home/outbox/stale.json" <<'JSON'
{"device_id":"local","session_id":"outbox-stale","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T06:00:00Z"}
JSON

  local caplog="$WORK/t13-cap.log"
  local capport="$WORK/t13-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  hook_json 'SessionEnd' "$repo" '' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1

  if ! wait_for_grep "$caplog" 'sess-1' 50; then
    fail "$name (SessionEnd event delivered)" "caplog: $(cat "$caplog" 2>/dev/null)"
  else
    pass "$name (SessionEnd event delivered)"
  fi

  # flush をスキップしたので outbox の既存イベントは再送されず、caplog には現れない。
  local n
  n=$(grep -c 'outbox-stale' "$caplog" 2>/dev/null)
  assert_eq "$name (stale outbox event NOT flushed)" '0' "$n"
  # caplog は SessionEnd の 1 行だけ。
  local total
  total=$(wc -l <"$caplog" 2>/dev/null | tr -d ' ')
  assert_eq "$name (caplog has exactly 1 line)" '1' "$total"
  # 未flushの outbox ファイルはそのまま残る。
  local left
  left=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (stale outbox file still present)" '1' "$left"

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 14 (FR-02 AC-2): SessionEnd は先頭候補 1 件のみへ送り、2 番目には一切届かない
# =========================================================================
# hub_endpoints に到達可能な capture server を「2つとも」起動する（test_hub_url_overrides_
# endpoints と同様の2サーバ構成）。通常イベントなら先頭が生きていればそこで確定するだけで
# 「2番目が生きていても叩かれない」ことまでは証明できないため、あえて両方 live にして
# 2番目の受信ログが 0 行のままであることを厳密に検証する。
test_session_end_single_candidate_only() {
  local name='FR-02 AC-2: SessionEnd contacts only the first of two live candidates'
  local home="$WORK/t14-home"
  local repo="$WORK/t14-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog1="$WORK/t14-cap1.log" capport1="$WORK/t14-cap1.port"
  local caplog2="$WORK/t14-cap2.log" capport2="$WORK/t14-cap2.port"
  : >"$caplog1"
  : >"$caplog2"
  CAP_LOG="$caplog1" CAP_PORTFILE="$capport1" node "$CAP_SERVER_JS" &
  local cap1pid=$!
  BG_PIDS="$BG_PIDS $cap1pid"
  CAP_LOG="$caplog2" CAP_PORTFILE="$capport2" node "$CAP_SERVER_JS" &
  local cap2pid=$!
  BG_PIDS="$BG_PIDS $cap2pid"
  if ! wait_for_file "$capport1" 100 || ! wait_for_file "$capport2" 100; then
    fail "$name" 'capture servers did not start'
    return
  fi
  local port1 port2
  port1=$(cat "$capport1")
  port2=$(cat "$capport2")

  cat >"$home/config.yml" <<EOF
role: child
device_id: laptop-t14
hub_endpoints:
  - http://127.0.0.1:$port1
  - http://127.0.0.1:$port2
EOF

  hook_json 'SessionEnd' "$repo" '' |
    MONOMI_HOME="$home" "$SCRIPT" >/dev/null 2>&1

  if wait_for_grep "$caplog1" 'sess-1' 50; then
    pass "$name (delivered to 1st candidate)"
  else
    fail "$name (delivered to 1st candidate)" "1st caplog: $(cat "$caplog1" 2>/dev/null)"
  fi
  # 2 番目は生きていても一切叩かれない（受信ログは 0 行のまま）。
  local n2
  n2=$(wc -l <"$caplog2" 2>/dev/null | tr -d ' ')
  assert_eq "$name (2nd candidate never contacted)" '0' "$n2"
  # 1 件目で配信確定したので outbox には退避されない。
  local ob
  ob=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (delivered, not saved to outbox)" '0' "$ob"

  kill "$cap1pid" "$cap2pid" >/dev/null 2>&1
}

# =========================================================================
# Test 14b (FR-02 AC-4): 死んだポートへの SessionEnd は outbox へ1件退避される
# =========================================================================
# test_outbox_on_hub_down (Test 3) の SessionEnd 版。誰も listen していない単一の
# 死んだポートへ MONOMI_HUB_URL で直接向け、outbox/*.json に 1 件退避されることを見る。
test_session_end_dead_hub_saves_outbox() {
  local name='FR-02 AC-4: SessionEnd to unreachable hub saves event to outbox'
  local home="$WORK/t14b-home"
  local repo="$WORK/t14b-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 誰も listen していないポートへ向ける(接続拒否)。
  hook_json 'SessionEnd' "$repo" '' |
    MONOMI_HOME="$home" MONOMI_HUB_URL='http://127.0.0.1:59997' \
      "$SCRIPT" >/dev/null 2>&1

  local n
  n=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (outbox file count == 1)" '1' "$n"

  local f et
  f=$(ls -1 "$home"/outbox/*.json 2>/dev/null | head -n 1)
  if [ -n "$f" ]; then
    et=$(jq -r '.event_type' "$f" 2>/dev/null)
    assert_eq "$name (outbox event_type == SessionEnd)" 'SessionEnd' "$et"
  else
    fail "$name (outbox event_type)" 'no outbox file'
  fi
}

# =========================================================================
# Test 15 (FR-02 AC-5): SessionEnd の 4xx は既存通り rejected/ へ隔離される
# =========================================================================
test_session_end_4xx_quarantined() {
  local name='FR-02 AC-5: SessionEnd 4xx response is quarantined to rejected/'
  local home="$WORK/t15-home"
  local repo="$WORK/t15-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # Test 7 で定義済みの selective server を再利用する（無ければここで生成）。
  local selective_server="$WORK/selective-server.cjs"
  if [ ! -f "$selective_server" ]; then
    cat >"$selective_server" <<'JS'
const http = require('http');
const fs = require('fs');
const log = process.env.CAP_LOG;
const portFile = process.env.CAP_PORTFILE;
const marker = process.env.CAP_REJECT_MARKER || 'poison';
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8').replace(/\r?\n/g, ' ');
    if (body.includes(marker)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_payload"}');
      return;
    }
    fs.appendFileSync(log, body + '\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(srv.address().port));
});
JS
  fi

  local caplog="$WORK/t15-cap.log"
  local capport="$WORK/t15-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" CAP_REJECT_MARKER='sess-1' \
    node "$selective_server" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  hook_json 'SessionEnd' "$repo" '' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1

  local rn rf rsid
  rn=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (rejected file count == 1)" '1' "$rn"
  rf=$(ls -1 "$home"/outbox/rejected/*.json 2>/dev/null | head -n 1)
  if [ -n "$rf" ]; then
    rsid=$(jq -r '.session_id' "$rf" 2>/dev/null)
    assert_eq "$name (rejected file is the SessionEnd event)" 'sess-1' "$rsid"
  else
    fail "$name (rejected file is the SessionEnd event)" 'no rejected file'
  fi
  local ob
  ob=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (not left in outbox)" '0' "$ob"

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 16 (AC-7): SessionEnd のワースト実行時間は概ね3秒以内（<3000ms）に収まる
# =========================================================================
# 応答を返さず接続だけ保持する「死んだ hub」へ向け、SessionEnd の所要時間を実測する。
# bash 3.2 の `date` は %N（ナノ秒）に非対応なので秒単位の粒度しか取れない。ここでは
# perl の Time::HiRes（macOS/CI ともに標準搭載、nap() で既に使用実績あり）でミリ秒精度の
# epoch を取り、AC-7 が定める「概ね3秒以内」を文字通り <3000ms で判定する新パターンを使う
# （既存テストに前例なし）。short-timeout（connect-timeout=1s/max-time=2s）で頭打ちになる
# ため、旧来の複数候補×最大8sの経路には決して張り付かないことを実測で裏付ける。
test_session_end_fast_timeout() {
  local name='AC-7: SessionEnd worst-case wall time stays under 3000ms'
  local home="$WORK/t16-home"
  local repo="$WORK/t16-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 接続は受け付けるが応答を一切返さない TCP サーバ（max-time の頭打ちを誘発する）。
  local hang_server="$WORK/hang-server.cjs"
  cat >"$hang_server" <<'JS'
const net = require('net');
const fs = require('fs');
const portFile = process.env.CAP_PORTFILE;
const srv = net.createServer((_socket) => {
  // 接続は受けるが応答しない（curl を max-time まで張り付かせる）。
});
srv.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(srv.address().port));
});
JS
  local hangport="$WORK/t16-hang.port"
  CAP_PORTFILE="$hangport" node "$hang_server" &
  local hangpid=$!
  BG_PIDS="$BG_PIDS $hangpid"
  if ! wait_for_file "$hangport" 100; then
    fail "$name" 'hang server did not start'
    return
  fi
  local port
  port=$(cat "$hangport")

  local start_ms end_ms elapsed_ms
  start_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time()*1000')
  hook_json 'SessionEnd' "$repo" '' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  end_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time()*1000')
  elapsed_ms=$((end_ms - start_ms))

  if [ "$elapsed_ms" -lt 3000 ]; then
    pass "$name (elapsed ${elapsed_ms}ms < 3000ms)"
  else
    fail "$name (elapsed ${elapsed_ms}ms < 3000ms)" "took ${elapsed_ms}ms, expected short-timeout path (~2000ms)"
  fi

  # max-time で失敗したので outbox へ退避される。
  local ob
  ob=$(ls -1 "$home"/outbox/*.json 2>/dev/null | wc -l | tr -d ' ')
  assert_eq "$name (saved to outbox after timeout)" '1' "$ob"

  kill "$hangpid" >/dev/null 2>&1
}

# =========================================================================
# Test 17 (known-issues S1 / release-13 相当): reporter が単独で作る $MONOMI_HOME も 0700
# =========================================================================
# reporter は Node.js 側の ensureMonomiHome()（release-13 FR-01）を経由せず $home を単独で
# 作成しうる（child デバイスで `monomi pair` 前に reporter が先に発火する等）。
#   ケース1: $home が未作成 → umask 既定パーミッション（多くの環境で 0755）で作られないこと。
#   ケース2: $home が広い権限で事前作成済み → 無条件・毎回の chmod で 0700 へ補正されること。
test_home_dir_permission_enforced() {
  local name='S1: reporter creates/repairs $MONOMI_HOME at 0700 without ensureMonomiHome'
  local repo="$WORK/t17-repo"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  # 誰も listen していないポート（接続拒否）。配信結果ではなく $home の権限だけを見る。
  local home_fresh="$WORK/t17-home-fresh"
  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home_fresh" MONOMI_HUB_URL='http://127.0.0.1:59996' \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1
  assert_eq "$name (fresh \$home mode == 0700)" '0700' "$(dir_mode "$home_fresh")"

  local home_existing="$WORK/t17-home-existing"
  mkdir -p "$home_existing"
  chmod 755 "$home_existing"
  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home_existing" MONOMI_HUB_URL='http://127.0.0.1:59996' \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1
  assert_eq "$name (pre-existing wide-permission \$home repaired to 0700)" '0700' "$(dir_mode "$home_existing")"
}

# =========================================================================
# Test 18 (release-16 FR-01 AC-1〜AC-3): Workflow ツールの tool_summary 抽出
# =========================================================================
test_tool_summary_workflow() {
  local name='FR-01: Workflow tool_summary extraction'
  local home="$WORK/t18-home"
  local repo="$WORK/t18-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t18-cap.log"
  local capport="$WORK/t18-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # AC-1: tool_input.name があれば name を優先する（scriptPath 併存時も name 優先）。
  : >"$caplog"
  tool_hook_json 'wf-name' "$repo" 'Workflow' \
    '{"name":"run-release","scriptPath":".claude/workflows/run-release.js"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-1 name priority)" 'run-release' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-1 name priority)" 'no request captured'
  fi

  # AC-2: name が無く scriptPath のみ → basename（ディレクトリ・.js 拡張子を除去）。
  : >"$caplog"
  tool_hook_json 'wf-scriptpath' "$repo" 'Workflow' \
    '{"scriptPath":".claude/workflows/run-release.js"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-2 scriptPath basename)" 'run-release' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-2 scriptPath basename)" 'no request captured'
  fi

  # AC-3: name/scriptPath 無し、インライン script のみ → script 内 meta.name を抽出。
  : >"$caplog"
  tool_hook_json_node 'wf-script' "$repo" 'Workflow' 'script' \
    $'export const meta = {\n  name: \'inline-flow\',\n  description: \'x\',\n};\n' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-3 inline script meta.name)" 'inline-flow' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-3 inline script meta.name)" 'no request captured'
  fi

  # AC-3: meta.name も抽出できないインライン script → 固定文言 "workflow" にフォールバック。
  : >"$caplog"
  tool_hook_json_node 'wf-script-noname' "$repo" 'Workflow' 'script' \
    $'export const meta = {\n  description: \'x\',\n};\n' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-3 fallback literal 'workflow')" 'workflow' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-3 fallback literal 'workflow')" 'no request captured'
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 19 (release-16 FR-01 AC-4〜AC-5): Task(Agent)/Skill ツールの tool_summary 抽出
# =========================================================================
test_tool_summary_task_and_skill() {
  local name='FR-01: Task/Agent/Skill tool_summary extraction'
  local home="$WORK/t19-home"
  local repo="$WORK/t19-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t19-cap.log"
  local capport="$WORK/t19-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # AC-4: Task, subagent_type + description の両方 → "<subagent_type>: <description>"。
  : >"$caplog"
  tool_hook_json 'task-both' "$repo" 'Task' \
    '{"subagent_type":"general-purpose","description":"investigate bug"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-4 both fields)" 'general-purpose: investigate bug' \
      "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-4 both fields)" 'no request captured'
  fi

  # AC-4: subagent_type のみ → subagent_type のみ。
  : >"$caplog"
  tool_hook_json 'task-subagent-only' "$repo" 'Task' \
    '{"subagent_type":"general-purpose"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-4 subagent_type only)" 'general-purpose' \
      "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-4 subagent_type only)" 'no request captured'
  fi

  # AC-4: tool_name=Agent 表記でも同様に扱う。description のみ → description のみ。
  : >"$caplog"
  tool_hook_json 'agent-desc-only' "$repo" 'Agent' \
    '{"description":"investigate bug"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-4 Agent alias, description only)" 'investigate bug' \
      "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-4 Agent alias, description only)" 'no request captured'
  fi

  # AC-5: Skill → tool_input.skill がそのまま入る。
  : >"$caplog"
  tool_hook_json 'skill-1' "$repo" 'Skill' '{"skill":"code-review"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (AC-5 skill)" 'code-review' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (AC-5 skill)" 'no request captured'
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 20 (release-16 FR-01 AC-6): 対象外ツールの抽出結果が従来どおり（回帰なし）
# =========================================================================
test_tool_summary_other_tools_regression() {
  local name='FR-01 AC-6: non-target tool_summary extraction unchanged'
  local home="$WORK/t20-home"
  local repo="$WORK/t20-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t20-cap.log"
  local capport="$WORK/t20-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # Bash: command が入る。
  : >"$caplog"
  tool_hook_json 'bash-1' "$repo" 'Bash' '{"command":"ls -la"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (Bash command)" 'ls -la' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (Bash command)" 'no request captured'
  fi

  # Read: command が無ければ file_path が入る。
  : >"$caplog"
  tool_hook_json 'read-1' "$repo" 'Read' '{"file_path":"/tmp/x.txt"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (Read file_path)" '/tmp/x.txt' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (Read file_path)" 'no request captured'
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 21 (release-16 FR-01 AC-7): jq 無しフォールバックでも Workflow/Task/Skill の
# 基本抽出が動作する（インライン script の meta.name 抽出は対象外）。
# =========================================================================
test_tool_summary_nojq_fallback() {
  local name='FR-01 AC-7: no-jq fallback extraction'
  local home="$WORK/t21-home"
  local repo="$WORK/t21-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t21-cap.log"
  local capport="$WORK/t21-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # AC-1 相当: Workflow + name（jq 無し）。
  : >"$caplog"
  tool_hook_json 'nojq-wf-name' "$repo" 'Workflow' \
    '{"name":"run-release","scriptPath":".claude/workflows/run-release.js"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
      "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (Workflow name)" 'run-release' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (Workflow name)" 'no request captured'
  fi

  # AC-2 相当: Workflow + scriptPath のみ（jq 無し）。
  : >"$caplog"
  tool_hook_json 'nojq-wf-scriptpath' "$repo" 'Workflow' \
    '{"scriptPath":".claude/workflows/run-release.js"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
      "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (Workflow scriptPath basename)" 'run-release' \
      "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (Workflow scriptPath basename)" 'no request captured'
  fi

  # AC-5 相当: Skill（jq 無し）。
  : >"$caplog"
  tool_hook_json 'nojq-skill' "$repo" 'Skill' '{"skill":"code-review"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
      "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (Skill)" 'code-review' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (Skill)" 'no request captured'
  fi

  # Task の subagent_type（jq 無し。要件が明示する対象）。
  : >"$caplog"
  tool_hook_json 'nojq-task' "$repo" 'Task' \
    '{"subagent_type":"general-purpose","description":"investigate bug"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
      "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (Task subagent_type)" 'general-purpose: investigate bug' \
      "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (Task subagent_type)" 'no request captured'
  fi

  # 回帰確認: 対象外ツール（Bash）も jq 無しで従来どおり動作する。
  : >"$caplog"
  tool_hook_json 'nojq-bash' "$repo" 'Bash' '{"command":"ls -la"}' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
      "$SCRIPT" >/dev/null 2>&1
  if wait_for_file "$caplog" 50; then
    assert_eq "$name (Bash command regression)" 'ls -la' "$(jq -r '.tool_summary' "$caplog" | head -n 1)"
  else
    fail "$name (Bash command regression)" 'no request captured'
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 22 (release-23 FR-01 AC-1): resolve_tty() は ppid チェーンを辿り、最初に
# 見つかった非 ??/非空の tty を採用する（浅い階層は ?? を返すケース）
# =========================================================================
# 実 ps をフェイクへ差し替え、「1〜3 階層目は ??、4 階層目で見つかる」ケースを決定的に
# 検証する。カウンタファイルで ps 呼び出し回数を追跡し、呼び出し回数だけで応答を決める
# （実際の pid 値には依存しない。ppid= 呼び出しごとに「元 pid − 1」を返すだけの単純な
# 仕組みで、0/1/同一値に達しない限り無限に降下を続けるが、resolve_tty() 自身が持つ
# 15 段の上限で必ず打ち切られる；本ケースは 4 階層目で先に見つかるため上限には当たらない）。
test_resolve_tty_finds_ancestor_tty() {
  local name='release-23 FR-01 AC-1: resolve_tty finds tty via ppid chain (ancestor level)'
  local home="$WORK/t22-home"
  local repo="$WORK/t22-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t22-cap.log"
  local capport="$WORK/t22-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  local fakebin="$WORK/t22-bin"
  mkdir -p "$fakebin"
  local counter="$WORK/t22-ps-count"
  echo 0 >"$counter"
  cat >"$fakebin/ps" <<EOF
#!/usr/bin/env bash
if [ "\$1" = '-o' ] && [ "\$2" = 'tty=' ]; then
  n=\$(cat "$counter" 2>/dev/null || echo 0)
  if [ "\$n" -ge 3 ]; then
    printf 'ttys099\n'
  else
    printf '??\n'
  fi
elif [ "\$1" = '-o' ] && [ "\$2" = 'ppid=' ]; then
  n=\$(cat "$counter" 2>/dev/null || echo 0)
  n=\$((n + 1))
  echo "\$n" >"$counter"
  pid=\$4
  printf '%s\n' "\$((pid - 1))"
fi
EOF
  chmod +x "$fakebin/ps"

  hook_json 'PreToolUse' "$repo" '' |
    PATH="$fakebin:$PATH" MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
      "$SCRIPT" >/dev/null 2>&1

  if wait_for_file "$caplog" 50; then
    assert_eq "$name (tty resolved via ancestor, /dev/ prefixed)" '/dev/ttys099' \
      "$(jq -r '.terminal.tty' "$caplog" | head -n 1)"
  else
    fail "$name (tty resolved via ancestor, /dev/ prefixed)" 'no request captured'
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 23 (release-23 FR-01 AC-1): 15 段辿っても tty が見つからなければ null に
# 縮退する（無限ループしない）
# =========================================================================
test_resolve_tty_gives_up_after_max_depth() {
  local name='release-23 FR-01 AC-1: resolve_tty gives up (null) after max depth, no infinite loop'
  local home="$WORK/t23-home"
  local repo="$WORK/t23-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t23-cap.log"
  local capport="$WORK/t23-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # フェイク ps: tty= は常に ?? を返し、ppid= は常に「元 pid − 1」を返す（0/1/同一値に
  # 到達しないため resolve_tty() 自身の 15 段上限で打ち切られることを検証する）。
  local fakebin="$WORK/t23-bin"
  mkdir -p "$fakebin"
  cat >"$fakebin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = '-o' ] && [ "$2" = 'tty=' ]; then
  printf '??\n'
elif [ "$1" = '-o' ] && [ "$2" = 'ppid=' ]; then
  pid=$4
  printf '%s\n' "$((pid - 1))"
fi
EOF
  chmod +x "$fakebin/ps"

  hook_json 'PreToolUse' "$repo" '' |
    PATH="$fakebin:$PATH" MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
      "$SCRIPT" >/dev/null 2>&1

  if wait_for_file "$caplog" 50; then
    assert_eq "$name (tty null when not found within max depth)" 'null' \
      "$(jq -r '.terminal.tty' "$caplog" | head -n 1)"
  else
    fail "$name (tty null when not found within max depth)" 'no request captured'
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 24 (release-23 FR-01 AC-2/AC-3): terminal オブジェクトの環境変数捕捉
# （jq 経路・no-jq フォールバック経路の両方）
# =========================================================================
test_terminal_env_capture() {
  local name='release-23 FR-01 AC-2/AC-3: terminal object captures env vars (jq + no-jq)'
  local home="$WORK/t24-home"
  local repo="$WORK/t24-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t24-cap.log"
  local capport="$WORK/t24-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  local mode
  for mode in jq nojq; do
    : >"$caplog"
    if [ "$mode" = nojq ]; then
      hook_json 'PreToolUse' "$repo" '' |
        MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" MONOMI_DISABLE_JQ=1 \
          TERM_PROGRAM='iTerm.app' TMUX='/tmp/tmux-501/default,4242,0' TMUX_PANE='%7' \
          WSL_DISTRO_NAME='Ubuntu' WT_SESSION='abc-def' \
          "$SCRIPT" >/dev/null 2>&1
    else
      hook_json 'PreToolUse' "$repo" '' |
        MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
          TERM_PROGRAM='iTerm.app' TMUX='/tmp/tmux-501/default,4242,0' TMUX_PANE='%7' \
          WSL_DISTRO_NAME='Ubuntu' WT_SESSION='abc-def' \
          "$SCRIPT" >/dev/null 2>&1
    fi
    if ! wait_for_file "$caplog" 50; then
      fail "$name ($mode)" 'no request captured'
      continue
    fi
    assert_eq "$name ($mode term_program)" 'iTerm.app' \
      "$(jq -r '.terminal.term_program' "$caplog" | head -n 1)"
    assert_eq "$name ($mode tmux_pane)" '%7' \
      "$(jq -r '.terminal.tmux_pane' "$caplog" | head -n 1)"
    assert_eq "$name ($mode tmux_socket)" '/tmp/tmux-501/default' \
      "$(jq -r '.terminal.tmux_socket' "$caplog" | head -n 1)"
    assert_eq "$name ($mode wsl_distro)" 'Ubuntu' \
      "$(jq -r '.terminal.wsl_distro' "$caplog" | head -n 1)"
    assert_eq "$name ($mode wt_session)" 'abc-def' \
      "$(jq -r '.terminal.wt_session' "$caplog" | head -n 1)"
  done

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 25 (release-23 FR-01 AC-2): $TMUX が非空でなければ tmux_pane/tmux_socket は
# 設定しない（$TMUX_PANE だけが残っている状況でも漏れない）
# =========================================================================
test_terminal_tmux_fields_gated_by_TMUX() {
  local name='release-23 FR-01 AC-2: tmux_pane/tmux_socket stay null unless $TMUX is non-empty'
  local home="$WORK/t25-home"
  local repo="$WORK/t25-repo"
  mkdir -p "$home"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  local caplog="$WORK/t25-cap.log"
  local capport="$WORK/t25-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  # $TMUX は意図的に未設定のまま(env -u で環境から確実に除去。テスト実行者が tmux 内に
  # いても影響を受けない)、$TMUX_PANE だけが残っている状況(tmux 終了直後のシェル等)を
  # 想定する。$TMUX が非空でなければ tmux_pane/tmux_socket は捕捉しないこと(AC-2)。
  hook_json 'PreToolUse' "$repo" '' |
    env -u TMUX TMUX_PANE='%9' MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
      "$SCRIPT" >/dev/null 2>&1

  if wait_for_file "$caplog" 50; then
    assert_eq "$name (tmux_pane null without \$TMUX)" 'null' \
      "$(jq -r '.terminal.tmux_pane' "$caplog" | head -n 1)"
    assert_eq "$name (tmux_socket null without \$TMUX)" 'null' \
      "$(jq -r '.terminal.tmux_socket' "$caplog" | head -n 1)"
  else
    fail "$name" 'no request captured'
  fi

  kill "$cappid" >/dev/null 2>&1
}

# =========================================================================
# Test 26 (release-23 FR-01): terminal 追加後も旧形式ペイロード(outbox に仕込んだ
# terminal キー無しの固定 JSON)が引き続き有効に再送される(既存 outbox 経路への回帰なし)
# =========================================================================
# 新設フィールドは reporter が新規生成するペイロードにのみ載る。outbox 内の既存ファイル
# (旧 reporter が書いた terminal キー無しの JSON)はそのままバイト列として再送されるだけ
# なので、reporter は中身の shape を検査しない。ここでは明示的にそれを固定する。
test_legacy_outbox_payload_without_terminal_still_resent() {
  local name='release-23 FR-01: legacy outbox payload (no terminal key) still resent as-is'
  local home="$WORK/t26-home"
  local repo="$WORK/t26-repo"
  mkdir -p "$home/outbox"
  printf 'tok' >"$home/token"
  make_git_repo "$repo" 'https://github.com/sumihiro/ProjectLens.git'

  cat >"$home/outbox/legacy.json" <<'JSON'
{"device_id":"local","session_id":"legacy-no-terminal","instance":{"remote_url":"https://github.com/sumihiro/ProjectLens.git","path":"/x","branch":null,"is_git_repo":true,"common_dir":null},"event_type":"Notification","event_subtype":"idle_prompt","tool_name":null,"tool_summary":null,"occurred_at":"2020-01-01T06:00:00Z"}
JSON

  local caplog="$WORK/t26-cap.log"
  local capport="$WORK/t26-cap.port"
  : >"$caplog"
  CAP_LOG="$caplog" CAP_PORTFILE="$capport" node "$CAP_SERVER_JS" &
  local cappid=$!
  BG_PIDS="$BG_PIDS $cappid"
  if ! wait_for_file "$capport" 100; then
    fail "$name" 'capture server did not start'
    return
  fi
  local port
  port=$(cat "$capport")

  hook_json 'Notification' "$repo" 'permission' |
    MONOMI_HOME="$home" MONOMI_HUB_URL="http://127.0.0.1:$port" \
      "$SCRIPT" --subtype permission_prompt >/dev/null 2>&1

  if wait_for_grep "$caplog" 'legacy-no-terminal' 50; then
    pass "$name (legacy payload without terminal key delivered)"
  else
    fail "$name (legacy payload without terminal key delivered)" "caplog: $(cat "$caplog" 2>/dev/null)"
  fi
  # 再送は生バイト列そのままなので terminal キーは足されない(旧形式のまま届く)。
  local has_terminal
  has_terminal=$(grep -c 'legacy-no-terminal' "$caplog" 2>/dev/null)
  if [ "$has_terminal" -ge 1 ] && ! grep -q '"terminal"' <(grep 'legacy-no-terminal' "$caplog"); then
    pass "$name (resent bytes unchanged, no terminal key injected)"
  else
    fail "$name (resent bytes unchanged, no terminal key injected)" "caplog: $(cat "$caplog" 2>/dev/null)"
  fi

  kill "$cappid" >/dev/null 2>&1
}

# --- 実行 ----------------------------------------------------------------
ensure_build
test_real_hub_records_event
test_raw_remote_passthrough
test_outbox_on_hub_down
test_outbox_resend_order
test_token_not_exposed_in_curl_args
test_outbox_concurrent_flush_no_duplicate
test_outbox_head_4xx_does_not_block
test_control_char_escaped_no_400
test_rejected_cap_prunes_oldest
test_multi_endpoint_ordered_failover
test_multi_endpoint_all_down_saves_outbox
test_hub_url_overrides_endpoints
test_session_end_skips_outbox_flush
test_session_end_single_candidate_only
test_session_end_dead_hub_saves_outbox
test_session_end_4xx_quarantined
test_session_end_fast_timeout
test_home_dir_permission_enforced
test_tool_summary_workflow
test_tool_summary_task_and_skill
test_tool_summary_other_tools_regression
test_tool_summary_nojq_fallback
test_resolve_tty_finds_ancestor_tty
test_resolve_tty_gives_up_after_max_depth
test_terminal_env_capture
test_terminal_tmux_fields_gated_by_TMUX
test_legacy_outbox_payload_without_terminal_still_resent

echo '----------------------------------------'
printf 'passed: %d  failed: %d\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
