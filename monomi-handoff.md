# Monomi 設計引き継ぎ資料

対象: 複数デバイス・複数プロジェクトでClaude Codeを並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PRレビュー待ち／放置）をひと目で横断的に確認できるCLIツール。

作者: Sumihiro（TEP Lab） / 本資料はClaude.aiでの設計検討を、実装フェーズ（Claude Code）に引き継ぐためのもの。

---

## 0. v1 実装前の確定仕様修正（2026-07-01 敵対レビュー反映）

> 本節は Claude Code 上での多角敵対レビュー（7レンズ・反証検証、51件中46件通過）で確定した **v1 実装前に固定すべき仕様修正**。以降の各節（§3〜§10）と食い違う場合は **本節を優先**する。決定記録は Vault `Decisions/2026-07-01-monomi-v1-scope.md`。

### 0.1 project_key 正規化を hub 側に一本化（§7.1 / §7.3 / §8.1 を改訂）

- reporter は **生の `git remote get-url origin` 出力（OS 非依存）をそのまま送る**。正規化ロジックを bash / PowerShell に**二重実装しない**（表記ゆれで同一リポが横断ダッシュボードで2行に割れるのを防ぐ）。
- 正規化は **hub 側の唯一の Node 実装**で行う: scheme / 認証情報除去 → host 小文字化 → 末尾 `.git` 除去 → `host/owner/repo` 形式に固定。**scp 形式（`git@host:owner/repo.git`）と URL 形式の両対応**。採用 remote は `origin` 固定（無ければアルファベット順先頭）。
- **受け入れ条件**: 入力 remote → 期待 key の **ゴールデンテスト10件**（SSH / HTTPS / `.git` 有無 / GitLab ネストサブグループ / ポート付き / 大小文字混在）を用意し、正規化関数が全て通ること。
- 非 remote / 非 git は device_id を鍵に前置してクロスデバイス融合を構造的に禁止:
  - remote 無し git: `local:{device_id}:{common-dir}`
  - 非 git: `nogit:{device_id}:{cwd}`

### 0.2 書き込み経路の耐障害性（マルチエンドポイント＋ローカル outbox）（§3.1 / §8.1 に追加）

- child config は hub 到達先を **複数併記**（例: LAN `192.168.1.100:PORT` と Tailscale `100.x.x.x:PORT`）。reporter は**順に試して到達できた先へ POST** する。
- **全エンドポイント全滅時**は状態遷移イベント（`permission_prompt` / `idle_prompt` / `SessionEnd`）を `~/.monomi/outbox/*.json` へ追記退避 → 次回フック発火でまとめて再送。occurred_at はクライアント時刻なので順序は保てる。
- これにより「hub が pm2 再起動 / OS 更新で数分落ちている間に権限待ちイベントが黙殺される」最悪ケースを塞ぐ。

### 0.3 認証を実装可能にする（tokens テーブル追加）（§7.3 / §8.2 / §9 を改訂）

- §7.3 DDL に **`tokens` テーブルを追加**（当節末の DDL 追記を参照）。`token_hash` を SHA-256 保存・`device_id` に FK・`revoked_at`。生トークンは保存しない。
- 各リクエストは **Bearer トークンから device_id を導出**し、リクエストボディの `device_id` 指定は**無視**（なりすまし書き込み防止）。
- `pair/claim` は **6桁コードを失敗5回で即無効化**＋成功で単発破棄（総当り無力化）。`pair/start` は `socket.remoteAddress` のみで localhost 判定し `X-Forwarded-For` は無視。
- child の `config.yml` は `chmod 600`。

### 0.4 v1 スコープの段階リリース（適用範囲を確定）

**単機ウェッジ → 2台目 → 認証ハードニング** の順に段階リリースする。

| 区分 | 内容 |
|---|---|
| **v1 含む** | install-hooks（冪等注入）/ bash レポーター（macOS/Linux/WSL2）/ Hub API + SQLite（WAL 既定）/ project_key 正規化 hub 一本化 / データモデル整合性（冪等・不変条件）/ event-time status 導出 / ローカル outbox / マルチデバイス（config＋手動ペアリング＋tokens＋認証硬化）/ CLI（Ink 間引き）＋ Agent View Lv.1 |
| **v1 延期** | ライブネス検知（常駐ハートビート / session_lost）/ PRレビュー待ち（`gh` CLI で v1.1 fast-follow）/ mDNS 探索 |
| **v1 落とす** | Windows ネイティブ（PowerShell / タスクスケジューラ）/ フル TLS / トークンスコープ分離・OSキーチェーン / SQLite バックアップ・自動リストア / ペアリングコードの永続化 / CLI 絞り込み系（fuzzy / sort / device 循環）/ Agent View Lv.2 / Codex 対応 |

### 0.5 status 導出とフックの補正（§4 / §5 / §8.2 / §10 に反映）

- **権限待ちの観測は `Notification`(matcher `permission_prompt`) を用いる**（§4 の `PermissionRequest → approval_wait` を改訂）。`PermissionRequest` は allow/deny/ask を返す**同期ゲート**で、観測用に POST を挟むと権限パスに遅延・誤判断を注入しうるため。`idle_prompt → next_wait` と同系統で一貫させる。
- **raw_state は session 単位で導出**し、§5.2 優先度で instance / project 代表を決める（closed セッションが active を覆い隠すバグを禁止）。
- **経過時間の起点**は「現 raw_state 連続区間の最初のイベント時刻＝状態遷移時刻」。idle_prompt が複数回発火しても放置の時計はリセットしない。
- **経過時間の引き算に使う権威時刻は hub の received_at**（各デバイスのクロックスキューを排除）。wire 形式は ISO8601(Z) 文字列で送り、hub が受信時に epoch ms へ変換。
- hub は status に **numeric priority** も返し、CLI ロールアップは `max()` するだけにする（優先順位定数の二重管理を排除）。
- **PID は hook payload に含まれない**（実機 Claude Code 2.1.197 で確認）。reporter が `$PPID` 系譜を辿って恒久 Claude Code プロセスを特定し `sessions.pid` を自前充填する。
- SQLite 初期化で `PRAGMA journal_mode=WAL` + `synchronous=NORMAL` を既定化（電源断耐性）。

---

## 1. プロダクト名

- **本ツール: Monomi（物見）**
- タグライン: **`Monomi — a status dashboard for Claude Code across machines`**
- npm公開は `@tep-lab/monomi` のようなスコープ付きで公開する（無スコープの`monomi`は放置状態の別パッケージに既に使われているため）。

### 決定までの経緯（メモ）

1. 当初は「見渡す・監視する」という意味の合致から **Yagura（櫓）** を第一候補にしていた。
2. 既存の「Claude Codeの承認プロンプトをインターセプトするツール」も同名Yaguraだったため、そちらを **Monban（門番）** に改名する案で一度決着（Sekisho＝関所は、同じメタファーを使う既存OSS「zero-trust proxy」と概念が被るため見送り）。
3. その後、英語ネイティブへの発音のしやすさとSEOを比較検討した結果、Yaguraを再考:
   - 発音: Yaguraは`gu`の連続子音で詰まりやすく、"Yakuza"に音が近いという懸念もあった。Monomiは`mono-`という馴染みのある接頭辞のおかげで発音しやすい。
   - SEO: 両方ともアニメ/ゲームキャラクター名と衝突する（Yagura＝Naruto第四代水影、Monomi＝ダンガンロンパ2のマスコット）が、Narutoは世界的巨大フランチャイズで検索競合が桁違いに激しい。Monomiの方が指名検索で埋もれにくい。
   - 結論: **監視ツール側の名前をMonomiに変更**。承認インターセプトツール側はMonban改名のままで変更なし。
4. タグラインに「Agent」「AI」を入れる案も検討したが、"AI agent"は既にLangChain/AutoGen等のエージェントフレームワーク群が占有する激戦区であり、むしろ埋もれる方向に働くため見送り。「Claude Code」と直接言い切る方が指名検索の的中率が高いと判断。v2でCodex等に対応した際は "coding agents" のような複数形表現へタグラインを更新する想定。

---

## 2. 要求の要約

- Claude Codeを複数デバイス（Mac mini、MacBook、将来的にはWindows）・複数プロジェクトで並行運用していると、どのプロジェクトがどんな状態か分からなくなる、忘れる。
- 「ここを見れば分かる」横断ダッシュボードが欲しい（通知よりもプル型の一覧確認を優先）。
- 1台体制の場合もあれば、複数台（Mac mini常時稼働＋MacBook）の場合もある。将来的にはWindowsもホストになれるようにしたい。
- OSS公開、将来的に商用化も視野。
- 画面はGUIではなくCLI。Claude Codeユーザーはターミナルに常駐している層なので親和性が高い。

---

## 3. 全体アーキテクチャ

```
Claude Code フック（各デバイス）
      ↓
状態レポートスクリプト（OS別、git情報を解決してPOST）
      ↓
Hub API（役割設定で hub/child を切り替え可能。素のNode.jsプロセス、pm2常駐）
      ↓
SQLite（project/instance/session/eventsを集約）
      ↓
CLI（hub APIをポーリングしてターミナルに表示）
```

### 3.1 hub / child の役割分担

- 各マシンの `~/.monomi/config.yml` で `role: hub | child` を指定。
- `role: child` の場合は `hub_endpoints`（到達先URLのリスト。§0.2）を指定し、reporterは先頭から順に試して到達できた先へPOSTする。
- `role: hub` の場合は `localhost` 宛でよく、`hub_endpoints` は不要。
- **1台体制はhub単体で自然に成立する**（child不要）。2台目を足す時は設定ファイルを1つ足すだけ。
- どのマシンもhubになれる。Mac mini固定ではない。

### 3.2 クロスプラットフォーム方針

- **Node.jsはClaude Code自体の前提にできない**（ネイティブインストーラーはNode.js不要でバイナリ同梱のため）。よってレポータースクリプトはOSごとに用意する。
  - macOS / Linux / WSL2: bash + curl + git（共通スクリプト。WSL2はLinuxなのでそのまま動く）
  - Windows ネイティブ: PowerShell（`Invoke-RestMethod`）+ Git for Windows
- **hub自体は素のNode.jsプロセス**（Tauriアプリ化はコード署名・SmartScreen/Gatekeeper対応のコストが重いため見送り）。pm2で常駐管理。
- **画面はGUIではなくCLI**（後述）。ブラウザ向けWebダッシュボードも作らない。

### 3.3 常時稼働（autostart）

| OS | 方法 |
|---|---|
| macOS | `pm2 startup && pm2 save`（launchd） |
| Linux | `pm2 startup && pm2 save`（systemd自動判定） |
| Windows | pm2は`pm2 startup`非対応。Windows標準のタスクスケジューラで「ログオン時に`pm2 resurrect`」を1個登録する方式を採用（サードパーティのpm2-windows-*系は依存が増えるため見送り。無人稼働が必要な場合のみ`pm2-installer`をオプション案内）|

`monomi hub install-autostart` のようなコマンドでOS判定して自動処理する想定。

---

## 4. トリガー（Claude Codeフック）マッピング

| フック | 意味 | raw_state |
|---|---|---|
| `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | 稼働中 | `active` |
| `PermissionRequest` | 権限確認が必要 | `approval_wait` |
| `Notification`（matcher: `idle_prompt`） | 一定時間アイドルで次の入力待ち | `next_wait` |
| `Stop` | ターン終了（暫定。直後にidle_promptで確定するか、次のUserPromptSubmitでactiveに戻る） | `next_wait`（暫定） |
| `SessionEnd` | セッション終了 | `closed` |
| `WorktreeCreate` / `WorktreeRemove` | worktreeの作成／削除 | instanceの登録・削除の補助情報 |

PRレビュー待ちだけはフックでは拾えないため、別系統（GitHub API poller）で取得する。

---

## 5. Status導出ロジック

**statusカラムは持たない。表示のたびに導出する。**（放置判定が経過時間依存のため、キャッシュするとズレる）

### 5.1 経過時間によるエスカレーション（raw_state別に閾値を変える）

| raw_state | 通常表示 | 放置に昇格する経過時間 |
|---|---|---|
| `active` | 稼働中 | 2時間 |
| `approval_wait` | 権限待ち | 6時間 |
| `next_wait` | 次の指示待ち | 24時間 |
| `pr_wait`（pollerが立てる） | PRレビュー待ち | 72時間 |
| `closed` | 非表示 or グレー | 対象外 |

閾値はconfigで上書き可能にする。

### 5.2 表示ステータスの優先順位（1インスタンスにつき1つに絞る）

```
放置 > 権限待ち > PRレビュー待ち（raw_state ≠ active時のみ） > 次の指示待ち > 稼働中
```

活動中（active）の場合はPRが開いていてもactiveを優先表示する（人の注意が今どこに向くべきかを表すため）。

### 5.3 ロールアップ

instance配下に複数session、project配下に複数instanceがある場合、代表ステータスは配下の中で最も優先度が高いものを採用する。ロールアップの計算はhub APIではなく**CLI側**で行う（表示都合はクライアントの関心事）。

---

## 6. 異常終了への対応

### 6.1 検知できるケース／できないケース

| 終了パターン | SessionEnd | 検知方法 |
|---|---|---|
| Ctrl+C / `/clear` / 通常終了 | 発火する | リアルタイムに拾える |
| 強制終了 / `kill -9` / 電源断 / ネットワーク切断 | 発火しない（原理的に不可能） | ハートビート＋放置しきい値に委ねる |

### 6.2 ハートビート方式（PIDマーカー＋バックグラウンドプロセス）

OS常設スケジューラ（cron/launchd/タスクスケジューラ）には登録せず、**`SessionStart`フックの中でバックグラウンド子プロセスをその場で1つ生やす**方式を採用（OSごとの登録・解除ロジックが不要になるため）。

- 子プロセスは「対象PIDが生きている間5分おきにハートビートPOST → 死んだら`session_lost`イベントを1回POSTして自分も終了」というだけのループ
- bash版・PowerShell版どちらも標準機能（`nohup ... &`、`Start-Process -WindowStyle Hidden`）で実装可能
- ハートビートは`events`テーブルに行を増やさず、`sessions.last_heartbeat_at`を更新するだけの専用軽量APIとする
- マシンごとスリープ/電源断の場合はハートビートごと消えるため検知できないが、これは放置しきい値のセーフティネットに委ねてよい（想定通りの挙動）

---

## 7. テーブル設計（最終版）

### 7.1 instanceの単位についての訂正

当初「instance = git worktree」としていたが誤り。worktreeを使わないユーザーの方が多く、また同じディレクトリで複数セッションを並行実行するケースもある。

正しい木構造:

```
session（一番細かい単位）
  └─ instance（ディレクトリ単位。git rev-parse --show-toplevel、非gitならcwdそのもの）
       └─ project（git remote / common-dir単位）
```

worktreeを使わない場合は自然に1プロジェクト＝1instanceになるだけで、特別扱いは不要。`WorktreeCreate`/`WorktreeRemove`はinstance登録の補助情報という位置づけに格下げ。

### 7.2 タイムスタンプはUNIXエポック（ミリ秒）のINTEGER

放置判定の根幹が「経過時間の引き算」なので、TEXT(ISO8601)より整数の方が扱いやすい。API応答時にISO8601へ変換して返す。

### 7.3 DDL

```sql
-- デバイス（レポート送信元）
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,       -- config.yml の device_id
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('hub','child')),
  first_seen_at INTEGER NOT NULL,       -- epoch ms
  last_seen_at  INTEGER NOT NULL
);

-- 論理プロジェクト（git remote / common-dir で識別）
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL UNIQUE,    -- 正規化済みgit remote、またはcommon-dir絶対パス
  display_name TEXT,                    -- エイリアス（未設定ならproject_keyから自動生成）
  created_at   INTEGER NOT NULL
);

-- インスタンス（ディレクトリ単位。worktreeの有無に関わらず同じ扱い）
CREATE TABLE instances (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  path        TEXT NOT NULL,            -- git toplevel。非gitならcwdそのもの
  branch      TEXT,                     -- 非gitならNULL
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,                  -- WorktreeRemove、またはクリーンアップジョブが埋める
  UNIQUE(device_id, path)
);

-- Claude Code(等)セッション（1 instanceにつき履歴としてN件）
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,   -- エージェント側のsession_id
  instance_id       TEXT NOT NULL REFERENCES instances(id),
  agent_type        TEXT NOT NULL DEFAULT 'claude_code',  -- v1は'claude_code'固定。将来'codex'等を追加
  pid               INTEGER,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,               -- clear/logout/prompt_input_exit/session_lost/other
  last_heartbeat_at INTEGER
);

-- 生イベントログ（status導出 + Agent View用の活動フィード。Lv.1のみ、要約付き生ログ）
CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  instance_id   TEXT NOT NULL REFERENCES instances(id),  -- 非正規化。最新状態クエリでJOINを省くため
  event_type    TEXT NOT NULL,          -- SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/
                                         -- Notification/Stop/SessionEnd/
                                         -- WorktreeCreate/WorktreeRemove/session_lost
                                         -- （PermissionRequestは含まない。§0.5により
                                         --  Notification matcher=permission_promptに一本化）
  event_subtype TEXT,                   -- 例: Notificationのmatcher(idle_prompt/permission_prompt)
  tool_name     TEXT,                   -- PreToolUse/PostToolUseのみ
  tool_summary  TEXT,                   -- 切り詰めたtool_input（ファイルパス/コマンド先頭）
  occurred_at   INTEGER NOT NULL,       -- epoch ms。クライアント（デバイス）時刻
  received_at   INTEGER NOT NULL        -- epoch ms。hub受信時刻（§0.5: 経過時間計算の権威時刻）
);
CREATE INDEX idx_events_instance_time ON events(instance_id, occurred_at DESC);
CREATE INDEX idx_events_session_time  ON events(session_id, occurred_at DESC);

-- PRレビュー状態（GitHub pollerが書く。フック経由ではないので別系統）
CREATE TABLE pr_status (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch     TEXT NOT NULL,
  pr_number  INTEGER,
  state      TEXT NOT NULL,             -- none/awaiting_review/changes_requested/approved/merged
  url        TEXT,
  checked_at INTEGER NOT NULL,
  UNIQUE(project_id, branch)
);

-- デバイストークン（認証。§0.3 で追加。宣言だけだった Bearer 認証／revoke を実装可能にする）
CREATE TABLE tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  token_hash  TEXT NOT NULL UNIQUE,    -- SHA-256(token)。生tokenは保存しない
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER                  -- revoke時刻。NULLなら有効
);
CREATE INDEX idx_tokens_device ON tokens(device_id);
```

### 7.4 運用上の注意

- ハートビートは行を増やさず`sessions.last_heartbeat_at`を上書き更新するだけ（`events`肥大化防止）。
- `events`はLv.1 Agent View用に直近数十件あれば十分。運用が回り出したら「N日より古いeventsを削除」または「セッションごとに直近200件のみ残す」で間引く（v1では見送り、実データを見てから決定）。
- `agent_type`列は将来Codex等の別エージェント対応の受け皿として先に追加済み。v1では`claude_code`固定でよい。

---

## 8. Hub API設計

### 8.1 書き込み系（レポータースクリプト／ハートビートプロセスから）

```
POST /api/v1/events       -- 全イベント共通の受け口。project/instance/deviceは初出なら自動登録
POST /api/v1/heartbeat    -- sessions.last_heartbeat_atのみ更新（eventsには積まない）
```

`/api/v1/events` リクエスト例（§0.1/§0.5 反映。reporter は正規化前の生remoteをそのまま送る）:

```json
{
  "device_id": "macmini-1",
  "session_id": "a1b2c3d4",
  "instance": {
    "remote_url": "git@github.com:sumihiro/ProjectLens.git",
    "path": "/Users/sumihiro/dev/ProjectLens-worktrees/ai-sidecar",
    "branch": "feature/ai-sidecar",
    "is_git_repo": true,
    "common_dir": null
  },
  "event_type": "Notification",
  "event_subtype": "permission_prompt",
  "tool_name": "Bash",
  "tool_summary": "npm install",
  "occurred_at": "2026-07-01T05:12:03Z"
}
```

- `device_id` はbody指定を送るが、hubは**認証済みBearerトークンから解決したdevice_idで必ず上書き**する（body値は信頼しない、§0.3）。
- `instance.remote_url` は正規化前の生出力（`project_key`はhubが`ProjectKeyNormalizer`で導出する。§0.1）。
- `PermissionRequest`は event_type に含めない。権限待ちは `event_type: "Notification"` + `event_subtype: "permission_prompt"` で表す（§0.5）。

### 8.2 読み取り系（CLIから）

```
GET /api/v1/instances       -- 一覧。status導出済みの値を返す（閾値ロジックはhub側に一本化）
GET /api/v1/instances/:id   -- 詳細。recent_events（直近N件、Agent View用）を含む
```

`GET /api/v1/instances` レスポンス例:

```json
{
  "generated_at": "2026-07-01T05:20:00Z",
  "instances": [
    {
      "instance_id": "inst_01",
      "project": { "id": "proj_01", "name": "ProjectLens" },
      "device":  { "id": "macmini-1", "name": "Mac mini" },
      "path": "/Users/sumihiro/dev/ProjectLens-worktrees/ai-sidecar",
      "branch": "feature/ai-sidecar",
      "status": {
        "display": "approval_wait",
        "raw_state": "approval_wait",
        "elapsed_seconds": 720,
        "is_stale": false,
        "priority": 4
      },
      "pr": { "state": "none" },
      "session": { "id": "a1b2c3d4", "last_heartbeat_at": "2026-07-01T05:19:40Z" }
    }
  ]
}
```

- プロジェクト単位のロールアップはCLI側で`project_id`によりgroupByして計算する（hub APIには持たせない）。
- watchモードは**単純ポーリング**（数秒おきに`GET /api/v1/instances`を叩き直す）。個人利用規模なのでSSE/WebSocketは不要。
- 認証は`Authorization: Bearer <device_token>`必須（書き込み・読み取り両方）。

---

## 9. ペアリングフロー

hub APIは常時起動している前提。ペアリングは別モードではなく、常時稼働中のAPIに生えた2エンドポイント。

```
POST /api/v1/pair/start   -- コード発行。localhostからのみ受け付ける（外部から叩けないようにガード）
POST /api/v1/pair/claim   -- コード照合してtoken発行。外部から叩いてOK
```

- **hub側**: `monomi hub pair` は新しいサーバーを起動するのではなく、既に起動しているhub APIにlocalhost宛でリクエストを1回投げるクライアント。6桁コードを5分間TTLでメモリ上（Map）に保持するだけで、SQLite永続化は不要。あわせてLAN/Tailscale（100.64.0.0/10）の到達先候補URLを検出して表示する（`os.networkInterfaces`＋`tailscale ip -4`フォールバック）。
- **child側**: `monomi pair --code XXXXXX --hub <url> [--hub <url2>...]` で到達先URLを手動指定する（複数指定可、指定順が到達優先順）。hub側が表示した候補URLをそのまま渡す運用を想定し、mDNS自動探索は見送り（§0.4「v1延期」・§12）。
- 成功したらdevice_tokenを発行し、childの`config.yml`に保存。
- 1台体制（hubのみ）はペアリング不要。hub起動時にhostnameベースでdevice_idを自動生成し、ローカル用tokenも自動発行。
- デバイス管理コマンドも用意: `monomi hub devices list` / `monomi hub devices revoke <id>`

---

## 10. CLI設計

### 10.1 ライブラリ選定: Ink

- Inkは`react-reconciler`（React DOM/React Nativeも使う低レベルパッケージ）の上にターミナル向けレンダラーを乗せたもの。ReactはDOMではなく差分計算エンジンとして再利用されているだけで、ブラウザ固有の要素はない。
- レイアウトはYoga（Flexboxエンジン）でCSSライクなプロパティがそのまま使える。
- 実績: Gatsby、Shopify、Parcel等が採用。2026年4月にv7.0リリース、React19対応。
- 実測サイズ: Ink本体は約540KB（unpacked）。`ink`+`react`をnode_modulesにインストールすると合計約23MB（大半は間接依存の`es-toolkit`）。実体部分（react-reconciler + yoga-layout + react + ws）は3MB程度で軽量。watchモードで常駐させる用途なら起動コストは1回きりなので許容範囲。
- 対抗馬のblessed/neo-blessedは低レベルで軽量だが、フィルタ・ソート・展開状態など状態遷移が多い今回の画面には、Inkの宣言的な状態管理の方が向いている。

### 10.2 画面イメージ

```
 Claude Code Status ── 8 projects · 2 devices ───────────────────────── 14:32:07

  [1]稼働中 2   [2]権限待ち 1   [3]次の指示待ち 2   [4]PRレビュー待ち 1   [5]放置 2
 ─────────────────────────────────────────────────────────────────────────────
    PROJECT                 DEVICE     BRANCH                    STATE          AGE
  > ProjectLens              Mac mini   feature/ai-sidecar      ● 稼働中        2m
      ├─ main                                                    ○ 権限待ち      12m
    Monban                   Mac mini   design-b/pty-injection  ○ 権限待ち      12m
    ...
 ─────────────────────────────────────────────────────────────────────────────
  1-5 filter  d device  / search  j/k ↑↓ move  ↵ expand  s sort  w watch  ? help  q quit
```

### 10.3 キーバインド方針

- `1`-`5`: 状態フィルタのトグル（複数選択可）
- `j`/`k` と矢印キー両対応（vim流、lazygit/k9s/gh dashと同じ作法）
- `d`: デバイスフィルタを循環
- `/`: プロジェクト名のファジー検索
- `↵`（Enter）: worktree/複数session展開
- `s`: ソート切替（経過時間短い順→名前順→デバイス順で循環、デフォルトは経過時間短い順）
- `w`: watchモードON/OFF
- `?`: ヘルプオーバーレイ、`q`: 終了

### 10.4 詳細ビュー（Agent View Lv.1）

1プロジェクト（1instance）を選択すると、直近のイベント（`PostToolUse`のtool_name/tool_summary等）をタイムライン表示する「生の活動ログ」を出す。

```
 ProjectLens / feature/ai-sidecar ──────────────────────────── [esc] back

  status      権限待ち (12m経過)
  device      Mac mini
  branch      feature/ai-sidecar
  session_id  a1b2c3d4...
  path        ~/dev/ProjectLens-worktrees/feature-ai-sidecar
  last event  PermissionRequest (Bash: npm install)
  pr          なし
```

**Lv.2（LLM要約recap）は将来拡張として見送り。** Kura/Hermesの03:00サマリー生成パターンを転用すれば、セッション終了時や定期的に「このセッションでは〜をした」という1〜2行要約を生成できる想定だが、v1はLv.1（生ログ）のみで進める。

---

## 11. 他エージェント（Codex等）対応の技術調査結果（v1では未対応・v2検討事項）

- Codex CLIのhooksはClaude Codeとイベント名がかなり一致（`SessionStart`/`PreToolUse`/`PostToolUse`/`PermissionRequest`/`UserPromptSubmit`/`Stop`）。payload構造も`session_id`/`cwd`/`transcript_path`等が共通しており、業界的に収斂しつつある（Gemini CLIも同系統の仕組みを持つ）。
- 技術的には、OS別レポータースクリプトと同じ発想で「エージェント別レポータースクリプト」を追加すれば、hub側の設計（テーブル・API）は変更不要で対応できる見込み。そのため`sessions.agent_type`列だけ先に追加済み（§7.3参照）。
- ただし以下の差異・制約があり、v1では見送り：
  - Claude Codeの`idle_prompt`通知に相当する「次の指示待ち」の直接判定手段がCodexにはない（Stopイベントからの推測に頼ることになる）
  - `WorktreeCreate`/`WorktreeRemove`相当がない（実害は小さい、instanceの識別はgitコマンドベースなので）
  - **Windowsでフックが無効**（実験的機能として明記されている）
  - **フックの信頼確認フローが必要**（`.codex/hooks.json`を置くだけでは発火せず、ユーザーが`/hooks`コマンドで明示的に信頼操作をする必要がある。サプライチェーン攻撃対策のための仕様。`--dangerously-bypass-hook-trust`で回避可能だが常用は非推奨）。これによりインストーラーの自動化度がClaude Code版より下がる。

---

## 12. 未着手・次の検討事項

- レポータースクリプトの実装（bash版・PowerShell版、git解決ロジック含む）
- Hub APIサーバーの実装（Node.js、SQLite、放置判定タイマー、PRポーラー）
- CLIの実装（Ink、画面コンポーネント分割）
- eventsテーブルの間引き戦略の確定（実データを見てから）
- ペアリングのmDNSアドバタイズ実装詳細
- コード署名不要な配布方法の確立（npm/npx配布が前提。将来的にexe化する場合は別途検討）

---

*本資料はClaude.ai上での設計検討会話をもとに作成。以降の実装はClaude Codeで行う想定。*
