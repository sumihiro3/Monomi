# Monomi bash レポーター (FR-02)

Claude Code のフックから発火し、稼働中の instance / session 情報を hub の
`POST /api/v1/events` へ送る bash スクリプト。**macOS の bash 3.2 + curl + git** を前提にし、
`jq` は「あれば使う／無くても動く」（有無を吸収）。Node.js には依存しない
（Claude Code はネイティブインストーラーで Node 非同梱のため。§3.2）。

- 実体: [`monomi-report.sh`](./monomi-report.sh)
- テスト: [`monomi-report.test.sh`](./monomi-report.test.sh)

## 役割と設計の要点

| 項目         | 決定                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| project_key  | 正規化は **hub 側の一手**（§0.1）。reporter は `git remote get-url origin` の**生出力**をそのまま送る |
| 時刻         | `occurred_at` は ISO8601(Z)（§0.5）。hub が受信時に epoch ms へ変換する                               |
| 耐障害性     | hub 応答不能時はイベントを `~/.monomi/outbox/*.json` へ退避（AC-3）                                   |
| 再送         | 次回発火時、outbox 内の未送信分を `occurred_at` 昇順で先に再送してから当該イベントを送る（AC-4）      |
| フック非破壊 | どんな失敗でも最終的に `exit 0`。フック（特に PreToolUse）を絶対にブロックしない                      |

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

| 変数                | 既定                 | 説明                                                                   |
| ------------------- | -------------------- | ---------------------------------------------------------------------- |
| `MONOMI_HOME`       | `$HOME/.monomi`      | token / outbox / config.yml の場所                                     |
| `MONOMI_HUB_URL`    | （下記から構築）     | hub のベース URL を丸ごと上書き（例 `http://127.0.0.1:47632`）。最優先 |
| `MONOMI_PORT`       | config.yml の `port` | 待受ポートの上書き（`MONOMI_HUB_URL` 未指定時）                        |
| `MONOMI_DISABLE_JQ` | （未設定）           | 空でなければ jq を使わず bash フォールバック経路を使う（テスト用）     |
| `MONOMI_DEBUG`      | （未設定）           | 空でなければ診断ログを stderr に出す                                   |

hub URL の解決順は `MONOMI_HUB_URL` → `http://127.0.0.1:${MONOMI_PORT}` →
`http://127.0.0.1:${config.yml の port}` → `http://127.0.0.1:47632`（既定ポート）。

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

## outbox（退避 / 再送）

- hub への POST が失敗（接続拒否・タイムアウト・非 2xx）すると、そのイベントの本文 JSON を
  `${MONOMI_HOME}/outbox/*.json` に 1 ファイルとして退避する（AC-3）。
- 次回フック発火時は **まず outbox を `occurred_at` 昇順で再送**し、成功したファイルを削除してから
  当該イベントを送る（AC-4）。1 件でも再送に失敗したらそこで中断し、残りは次回へ持ち越す。
- 退避ファイル名は一意性のためタイムスタンプ + PID + 乱数で作るが、**再送順はファイル名ではなく
  中身の `occurred_at`** で決める（ISO8601(Z) は辞書順＝時刻順）。

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

依存: `node`（実 hub / capture server 用）・`sqlite3`・`git`・`curl`。テストハーネス側は `jq` を使う
（reporter 本体は jq 有無を吸収する）。
