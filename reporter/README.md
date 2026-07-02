# Monomi bash レポーター (FR-02)

Claude Code のフックから発火し、稼働中の instance / session 情報を hub の
`POST /api/v1/events` へ送る bash スクリプト。**macOS の bash 3.2 + curl + git** を前提にし、
`jq` は「あれば使う／無くても動く」（有無を吸収）。Node.js には依存しない
（Claude Code はネイティブインストーラーで Node 非同梱のため。§3.2）。

- 実体: [`monomi-report.sh`](./monomi-report.sh)
- テスト: [`monomi-report.test.sh`](./monomi-report.test.sh)

## 役割と設計の要点

| 項目                 | 決定                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| project_key          | 正規化は **hub 側の一手**（§0.1）。reporter は `git remote get-url origin` の**生出力**をそのまま送る            |
| 時刻                 | `occurred_at` は ISO8601(Z)（§0.5）。hub が受信時に epoch ms へ変換する                                          |
| マルチエンドポイント | hub 到達先候補（config `hub_endpoints`）を優先順に**順試行**し、到達できた先へ POST（§0.2 / FR-04 AC-1）         |
| 耐障害性             | **全候補が**応答不能（接続失敗 / 5xx）なときのみイベントを `~/.monomi/outbox/*.json` へ退避（AC-3 / FR-04 AC-2） |
| 再送                 | 次回発火時、outbox 内の未送信分を `occurred_at` 昇順で先に再送してから当該イベントを送る（AC-4）                 |
| 4xx 隔離             | 4xx（不正 JSON / スキーマ不適合 / 失効トークン）は永久エラーとして `outbox/rejected/` へ隔離（FR-07）            |
| フック非破壊         | どんな失敗でも最終的に `exit 0`。フック（特に PreToolUse）を絶対にブロックしない                                 |

送信するペイロードは hub の `src/hub/dto.ts` の `rawEventPayloadSchema` と一致する:

```jsonc
{
  "device_id": "local", // hub が Bearer トークン由来の値で上書きする（§0.3）。体裁として送る
  "session_id": "<hook の session_id>",
  "instance": {
    "remote_url": "git@github.com:owner/repo.git", // 生出力。remote 無しは null
    "path": "/abs/toplevel", // git toplevel。非 git は cwd
    "branch": "main", // 非 git / detached は null
    "is_git_repo": true,
    "common_dir": "/abs/.git", // remote 無し git の融合キー用。非 git は null
  },
  "event_type": "Notification", // hook_event_name
  "event_subtype": "permission_prompt", // Notification の matcher（下記）
  "tool_name": null, // Pre/PostToolUse のみ
  "tool_summary": null, // tool_input の要約（先頭 200 字）
  "occurred_at": "2026-07-02T05:12:03Z",
}
```

## 呼び出し規約

標準入力に Claude Code のフック JSON を受け取り、そこから
`session_id` / `hook_event_name`(→`event_type`) / `cwd` / `tool_name` / `tool_input`(→`tool_summary`)
を抽出する。

```sh
# 一般フック（event_type は stdin の hook_event_name から）
echo "$HOOK_JSON" | monomi-report.sh

# Notification（matcher を明示指定）
echo "$HOOK_JSON" | monomi-report.sh --subtype permission_prompt
```

### `event_subtype`（Notification matcher）の決定順

Claude Code の Notification フック payload には matcher が確実には載らないため、次の順で決める:

1. `--subtype <値>`（`install-hooks` が matcher 別に登録するときに渡す。**推奨**）
2. stdin の `matcher` / `notification_type` フィールド（存在すれば）
3. `event_type=Notification` かつ `message` があるときの best-effort 推定
   （`permission`/`approve` を含む → `permission_prompt`、`waiting`/`idle` → `idle_prompt`）

有効な値は `permission_prompt`（権限待ち）と `idle_prompt`（次の指示待ち）。

### 引数

| 引数                | 意味                                                          |
| ------------------- | ------------------------------------------------------------- |
| `--subtype <値>`    | `event_subtype`。Notification の matcher を明示指定           |
| `--event-type <値>` | `event_type` を上書き（既定は stdin の `hook_event_name`）    |
| `<位置引数>`        | `--subtype` の簡便形（最初の非フラグ引数を subtype とみなす） |
| `-h`, `--help`      | ヘッダのヘルプを表示                                          |

## 環境変数

| 変数                  | 既定                 | 説明                                                                   |
| --------------------- | -------------------- | ---------------------------------------------------------------------- |
| `MONOMI_HOME`         | `$HOME/.monomi`      | token / outbox / config.yml の場所                                     |
| `MONOMI_HUB_URL`      | （下記から構築）     | hub のベース URL を丸ごと上書き（例 `http://127.0.0.1:47632`）。最優先 |
| `MONOMI_PORT`         | config.yml の `port` | 待受ポートの上書き（`MONOMI_HUB_URL` 未指定時）                        |
| `MONOMI_DISABLE_JQ`   | （未設定）           | 空でなければ jq を使わず bash フォールバック経路を使う（テスト用）     |
| `MONOMI_REJECTED_MAX` | `200`                | `outbox/rejected/` に貯める最大件数。超過分は最古から掃除する（FR-07） |
| `MONOMI_DEBUG`        | （未設定）           | 空でなければ診断ログを stderr に出す                                   |

hub URL 候補の解決順（FR-04。先に該当したものを採用。3 のみ複数候補、他は単一）:

1. `MONOMI_HUB_URL` — 最優先・**単一**。フル URL を丸ごと上書き（AC-3）。
2. `http://127.0.0.1:${MONOMI_PORT}` — env 上書き（**単一** loopback）。
3. config `hub_endpoints` — child の到達先**複数候補**（優先順・§0.2 / AC-1）。存在すれば順に試す。
4. `http://127.0.0.1:${config.yml の port}` — hub 自身が自 localhost 宛に送る**単一**経路。
5. `http://127.0.0.1:47632`（既定ポート）— 最後の砦（**単一**）。

3 を 4 の前に置くのは、`hub_endpoints` の存在が「このデバイスは child」という明確な信号であり、
万一 child config に古い `port:` 行が残っていてもマルチエンドポイントを無効化しないため（hub config は
`hub_endpoints` を持たないので 4 の loopback にそのまま落ちる）。候補はいずれも末尾スラッシュを剥がした
うえで `${url}/api/v1/events` に POST する。

`hub_endpoints` は config.yml に **ブロックシーケンス**（`- ` プレフィックス、1 行 1 URL）で書く
（`sed` で行単位に読める形式。config.ts のスキーマ注釈・`monomi pair` の書き出しと一致）:

```yaml
role: child
hub_endpoints:
  - http://192.168.1.100:47632 # LAN
  - http://100.64.0.1:47632 # Tailscale
```

**順試行の判定**: 各候補 URL に POST し、2xx なら配信確定でそこで止める。5xx / 接続失敗はその候補が
不達なので次候補へ回す。4xx（永久エラー）は「hub には届いたがペイロードが不正」で、候補は同一 hub への
別経路（LAN / Tailscale 等）を指す前提のため他候補でも同じ結果になる → 即 `rejected/` 隔離扱いとし
候補ループは続けない。**全候補が 5xx / 接続失敗**のときだけ全滅とみなし outbox へ退避する（AC-2）。

token は `${MONOMI_HOME}/token`（hub 起動時に発行される生トークン）を読み、
`Authorization: Bearer <token>` として付与する。

## `install-hooks` からの登録（FR-01 との契約）

`install-hooks`（別項目）は Claude Code の 7 フックを `~/.claude/settings.json` に登録する。
その際の command 文字列は概ね次の形になる:

```jsonc
// 一般フック
{ "type": "command", "command": "bash ~/.monomi/monomi-report.sh" }

// Notification は matcher 別に 2 エントリ登録し、--subtype で matcher を渡す
{ "matcher": "permission_prompt",
  "hooks": [{ "type": "command", "command": "bash ~/.monomi/monomi-report.sh --subtype permission_prompt" }] }
{ "matcher": "idle_prompt",
  "hooks": [{ "type": "command", "command": "bash ~/.monomi/monomi-report.sh --subtype idle_prompt" }] }
```

`event_type` は各フックの stdin `hook_event_name` から自動で決まるため、
Notification 以外は `--subtype` を付けなくてよい。

## outbox（退避 / 再送 / 4xx 隔離）

POST の結果を **HTTP status で 3 分岐**する（FR-07）。壊れた 1 件（poison-pill）がキュー全体を
閉塞させないための設計:

| 結果                          | 判定       | 挙動                                                   |
| ----------------------------- | ---------- | ------------------------------------------------------ |
| 2xx                           | 成功       | 配信完了。outbox 由来なら当該ファイルを削除            |
| 5xx / 接続失敗 / タイムアウト | 一時エラー | `outbox/*.json` へ退避し次回再送（再送中はそこで中断） |
| 4xx                           | 永久エラー | `outbox/rejected/` へ隔離し、キューは止めず先へ進む    |

- **退避（一時エラー）**: **全候補**が接続拒否・タイムアウト・5xx で POST できないと（=全滅、
  FR-04 AC-2）、そのイベントの本文 JSON を `${MONOMI_HOME}/outbox/*.json` に 1 ファイルとして
  退避する（AC-3）。1 候補でも到達できれば退避しない。
- **再送**: 次回フック発火時は **まず outbox を `occurred_at` 昇順で再送**し、成功したファイルを
  削除してから当該イベントを送る（AC-4）。再送も候補 URL を順試行し、**全候補が** 5xx / 接続失敗で
  1 件でも再送不能ならそこで中断し、残りは次回へ持ち越す。退避ファイル名は一意性のためタイムスタンプ + PID + 乱数で作るが、
  **再送順はファイル名ではなく中身の `occurred_at`** で決める（ISO8601(Z) は辞書順＝時刻順）。
- **4xx 隔離**: hub が 4xx（`400 invalid_json` / `400 invalid_payload` / 失効トークンの `401`）を
  返したイベントは再送しても直らないため、`outbox/rejected/` へ退避してキューから外し、後続の
  正常イベントを配信し続ける（FR-07 AC-1・AC-3）。`rejected/` は `*.json` を直に置かない別階層
  なので再送対象にはならない。無限蓄積を防ぐため件数上限（`MONOMI_REJECTED_MAX`、既定 200）を
  超えると **mtime 最古から掃除**する。
- **制御文字のエスケープ**: jq 不在フォールバック経路では、`json_escape` が U+0000〜U+001F の制御
  文字を `\uXXXX`（`\n` / `\r` / `\t` は短縮形）へエスケープする。これがないと生の制御文字を含む
  フィールド（例: `tool_summary`）が invalid JSON になり hub に `400` される poison-pill を生む
  （FR-07 AC-2）。jq 経路では jq が同等の処理を行う。

## テスト

```sh
bash reporter/monomi-report.test.sh
```

FR-02 の受け入れ基準を shell で検証する（`dist/` が無ければ `tsc` で用意する）:

- **AC-1**: 実 hub（`node dist/hub/serve.js`）起動下で Notification(permission_prompt) を発火し、
  `sqlite3` で `events` テーブルに 1 行入ることを確認。
- **AC-2**: capture server に対して発火し、`git remote get-url origin` の生出力が
  `instance.remote_url` にそのまま届くことを確認（jq 経路・no-jq 経路の両方）。
- **AC-3**: 応答しないポートへ向けて発火し、`outbox/*.json` が生成されることを確認。
- **AC-4**: ファイル名順と `occurred_at` 順が逆になる 2 件を outbox に仕込み、hub 復旧後に
  `occurred_at` 昇順（06:00 → 08:00）で再送されてから当該イベントが送られ、outbox が空になることを確認。

FR-07（outbox 閉塞解消）も同ハーネスで検証する:

- **FR-07 AC-3**: outbox 先頭（最古）に 4xx を返す poison イベント、後続に正常イベントを仕込み、
  選択的 400 を返す capture server で発火。後続正常と当該イベントが配信され、poison は配信されず
  `outbox/rejected/` に 1 件残り、outbox 本体が空になることを確認（先頭 4xx がキューを閉塞しない）。
- **FR-07 AC-2**: `tool_input.command` に生の制御文字 `0x01` を仕込み、`MONOMI_DISABLE_JQ=1` の
  フォールバック経路で発火。`JSON.parse` で厳格検証する capture server が `400` せず受理し
  （`\u0001` にエスケープ済み）、outbox / rejected どちらにも退避されないことを確認。
- **FR-07（掃除）**: 4xx を 3 件仕込み `MONOMI_REJECTED_MAX=2` で発火し、`rejected/` が 2 件に
  抑えられる（最古から掃除され無限蓄積しない）ことを確認。

FR-04（マルチエンドポイント順試行）も同ハーネスで検証する:

- **FR-04 AC-1**: config `hub_endpoints` に「死んだポート → live capture server」の 2 候補を書き、
  `MONOMI_HUB_URL` 無しで発火。1 番目が接続拒否でも 2 番目へフェイルオーバーしてちょうど 1 件配信され、
  outbox / rejected に退避されないことを確認（順試行）。
- **FR-04 AC-2**: `hub_endpoints` を死んだポート 2 つにして発火。全滅時のみ `outbox/*.json` に 1 件
  退避され、rejected には入らないことを確認。
- **FR-04 AC-3**: `hub_endpoints`（live）と `MONOMI_HUB_URL`（別の live）の 2 サーバを立て、
  `MONOMI_HUB_URL` を設定して発火。override 側にだけ届き、`hub_endpoints` 側は一切叩かれない
  （最優先・単一）ことを確認。

依存: `node`（実 hub / capture server 用）・`sqlite3`・`git`・`curl`。テストハーネス側は `jq` を使う
（reporter 本体は jq 有無を吸収する）。
