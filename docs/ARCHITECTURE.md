# Monomi アーキテクチャ

> 本ドキュメントが Monomi の現行アーキテクチャの権威仕様。設計・検討の経緯（命名決定、要求の背景、Codex 対応調査、当初の未着手事項）は `monomi-handoff.md`（凍結）を参照する。
>
> 記述は実装ソース（`src/`・`reporter/`）を正とし、両者に齟齬がある場合は実装を正とする。

Monomi は、複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボードである。構成は次の 3 レイヤー。

- **reporter**（bash、macOS/Linux/WSL2）: Claude Code フックから発火し、状態イベントを hub へ POST する。
- **hub**（素の Node.js + SQLite）: イベントを集約・正規化し、status を導出して API で返す。pm2 で常駐。
- **CLI**（Ink）: hub API をポーリングしてターミナルにダッシュボードを描画する。

---

## 1. 確定仕様の要点（handoff §0）

実装前レビューで確定し、以降の設計より優先される中核方針。実装はすべてこれに準拠している。

- **project_key 正規化を hub 側に一本化**（§0.1）: reporter は `git remote get-url origin` の生出力をそのまま送り、正規化は hub 側の唯一の Node 実装（`ProjectKeyNormalizer`）で行う。bash / PowerShell へ正規化を二重実装しない。表記ゆれで同一リポジトリが横断ダッシュボードで複数行に割れるのを防ぐため。
- **書き込み経路の耐障害性**（§0.2）: child は hub 到達先を複数併記（LAN / Tailscale 等）し、reporter は順に試して到達できた先へ POST する。全滅時のみ状態遷移イベントをローカル `~/.monomi/outbox/*.json` へ退避し、次回発火でまとめて再送する。
- **認証となりすまし書き込み防止**（§0.3）: `tokens` テーブルで Bearer トークンを SHA-256 保存（生トークンは保存しない）。各リクエストはトークンから `device_id` を導出し、ボディの `device_id` 指定は無視する。ペアリングコードは失敗 5 回で即無効化・成功で単発破棄。`chmod 600` で token / config を保護する。
- **status 導出の補正**（§0.5）: 権限待ちの観測は `Notification`(matcher `permission_prompt`) を用いる。raw_state は session 単位で導出し、優先度で instance 代表を決める（closed が active を覆い隠さない）。経過時間の起点は「現 raw_state 連続区間の最初のイベント時刻」、権威時刻は hub の `received_at`（クロックスキュー排除）。hub は numeric priority も返し、CLI ロールアップは `max()` するだけにする。
- **段階リリース区分**（§0.4）: 単機ウェッジ → 認証ハードニング／2 台目 → CLI ダッシュボードの順に段階リリースする（本節末の対応表を参照）。

---

## 2. 全体アーキテクチャ

```
Claude Code フック（各デバイス）
      ↓
reporter（bash。git 情報を解決し ISO8601 時刻を付けて POST）
      ↓
Hub API（role で hub/child を切り替え。素の Node.js プロセス、pm2 常駐）
      ↓
SQLite（devices / projects / instances / sessions / events / tokens / pr_status を集約）
      ↓
CLI（hub API をポーリングして Ink でターミナル表示）
```

### 2.1 hub / child の役割分担

- 各マシンの `~/.monomi/config.yml` の `role: hub | child` で役割を指定する（既定 `hub`）。
- `role: child` は `hub_endpoints`（到達先 URL の優先順リスト、§0.2）を持ち、reporter は先頭から順試行して到達できた先へ POST する。
- `role: hub` は `localhost` 宛でよく `hub_endpoints` は不要。1 台体制は hub 単体で成立する。2 台目は config を 1 つ足すだけ。
- `monomi hub` を `role: child` のデバイスで実行するとエラー終了する（`src/cli.ts` の child ガード）。

### 2.2 クロスプラットフォーム方針

- Node.js は Claude Code の前提にできない（ネイティブインストーラーは Node 非同梱）。よって reporter は OS ごとに用意する方針で、現状 **bash 版（macOS/Linux/WSL2）** を実装している。Windows ネイティブ（PowerShell）は現状スコープ外。
- **hub 自体は素の Node.js プロセス**（Tauri 等のアプリ化はしない）。pm2 で常駐管理する。
- **画面は CLI**（Ink）。ブラウザ向け Web ダッシュボードは作らない。

### 2.3 常時稼働（autostart）

pm2 の `pm2 startup && pm2 save`（macOS は launchd、Linux は systemd 自動判定）で常駐させる。専用の install コマンドは現状未実装。

---

## 3. レポーター（reporter）

実体は `reporter/monomi-report.sh`。macOS の bash 3.2 + curl + git を前提にし、`jq` は「あれば使う／無くても動く」（有無を吸収）。Node.js に依存しない。詳細な仕様は `reporter/README.md`。

- **project_key**: 正規化は hub 側の一手（§0.1）。reporter は `git remote get-url origin` の生出力を `instance.remote_url` にそのまま載せる。
- **時刻**: `occurred_at` は ISO8601(Z)（§0.5）。hub が受信時に epoch ms へ変換する。
- **マルチエンドポイント**: hub 到達先候補を優先順に順試行し、到達できた先へ POST する。候補解決順は「`MONOMI_HUB_URL`（単一・最優先）→ `MONOMI_PORT` の loopback → config `hub_endpoints`（複数候補）→ config `port` の loopback → 既定ポート `47632`」。
- **耐障害性（outbox）**: 全候補が接続失敗／5xx のときのみ、イベント本文を `~/.monomi/outbox/*.json` へ退避する。次回発火時にまず outbox を `occurred_at` 昇順で再送してから当該イベントを送る。
- **SessionEnd 高速経路（release-7 FR-02）**: `event_type=SessionEnd` のみ例外経路を通る。outbox flush をスキップし、候補 hub URL の先頭 1 件のみへ `connect-timeout=1s`/`max-time=2s` で単発 POST する（他候補への順次試行はしない）。Claude Code の Graceful shutdown 猶予（既定 5 秒）内に確実に完了させるため、マルチエンドポイント順次試行（候補ごと最大 8s）を待たない設計。失敗時は他イベント種別と同じく outbox へ退避し（4xx は `rejected/` へ隔離）、次回いずれかのイベント発火時に通常の `flush_outbox` 経路で再送される。`SessionEnd` 以外は本節冒頭の「マルチエンドポイント」「耐障害性（outbox）」の経路（outbox flush 先行 → 複数候補順次試行 → 候補ごと最大 8s）を維持する（回帰なし）。
- **4xx 隔離**: 4xx（不正 JSON／スキーマ不適合／失効トークン）は永久エラーとして `~/.monomi/outbox/rejected/` へ隔離し、キューを閉塞させない。件数上限（`MONOMI_REJECTED_MAX`、既定 200）超過分は最古から掃除する。
- **フック非破壊**: どんな失敗でも最終的に `exit 0` し、フック（特に PreToolUse）をブロックしない。

### 3.1 フックの登録（install-hooks）

`monomi install-hooks` が Claude Code の 7 フックを `~/.claude/settings.json` へ冪等に登録する（`src/install-hooks/`）。command 文字列末尾に `#monomi:v1` マーカーを埋め込み（bash コメント扱いで無害）、これを判別に使うことで既存の他ツール由来フックを壊さず remove-then-add する。`Notification` は matcher 別に 2 エントリ（`permission_prompt` / `idle_prompt`）へ分割するため、登録数は 8 になる。除去は `monomi uninstall-hooks`。

---

## 4. フック → raw_state マッピング

`src/status/raw-state-resolver.ts` の `rawStateOf()` が 1 イベントを raw_state へ写す唯一の定義。状態導出に無関係なイベントは `null`。

| フック（event_type）                                               | 条件                        | raw_state                         |
| ------------------------------------------------------------------ | --------------------------- | --------------------------------- |
| `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | —                           | `ACTIVE`                          |
| `Notification`                                                     | subtype `permission_prompt` | `APPROVAL_WAIT`                   |
| `Notification`                                                     | subtype `idle_prompt`       | `NEXT_WAIT`                       |
| `Notification`                                                     | 上記以外の matcher          | `null`（状態に無関係）            |
| `Stop`                                                             | —                           | `NEXT_WAIT`（暫定）               |
| `SessionEnd` / `session_lost`                                      | —                           | `CLOSED`                          |
| `WorktreeCreate` / `WorktreeRemove`                                | —                           | `null`（instance 登録の補助情報） |

- 権限待ちの観測は `PermissionRequest`（allow/deny/ask を返す同期ゲート）ではなく `Notification`(matcher `permission_prompt`) に一本化する（§0.5）。同期パスに観測 POST を挟んで遅延・誤判断を注入しないため。`PermissionRequest` は `EventType` 列挙に含めない。
- `Stop` は「ターン終了」の暫定 `NEXT_WAIT`。直後の `idle_prompt` か次の `UserPromptSubmit` で確定する。
- PR レビュー待ちはフックでは拾えないため、別系統（GitHub poller）で取得する設計。poller は現状未実装（`pr_status` テーブルは作られるが行は増えない）。

---

## 5. status 導出ロジック

**status カラムは持たない。表示のたびにイベント列から導出する**（放置判定が経過時間依存のため、キャッシュするとズレる）。導出エンジンは `src/status/` に責務ごとの値オブジェクト／ドメインサービスとして分解されている。

### 5.1 raw_state 判定

`RawStateResolver` が「`received_at` 基準で最も新しい、状態を持つイベント」の写像として現在の raw_state を決める。状態を持つイベントが 1 つも無い縮退ケースは `ACTIVE`（経過 0）扱い。

### 5.2 遷移時刻（経過時間の起点）

`StateTransitionFinder` が「現 raw_state 連続区間の最初のイベントの `received_at`」を遷移時刻とする。`idle_prompt` が複数回発火しても（同じ `NEXT_WAIT` が連続）起点はリセットされない。別の raw_state が挟まった時点で区間が切れ、その後の新しい区間の先頭が起点になる。時刻計算はすべて hub の `received_at` 基準（§0.5）で、`occurred_at`（クライアント時刻）は status 導出に用いない。

### 5.3 エスカレーション閾値

`EscalationThresholds` が raw_state 別の放置昇格閾値を保持する（`config.yml` の `escalation_thresholds` で上書き可能）。既定値:

| raw_state       | 既定閾値 |
| --------------- | -------- |
| `ACTIVE`        | 2h       |
| `APPROVAL_WAIT` | 6h       |
| `NEXT_WAIT`     | 24h      |
| `PR_WAIT`       | 72h      |

`EscalationPolicy.classify()` が遷移・経過時間・閾値・PR 有無から表示ステータスを確定する。手順は「候補選択（`ACTIVE` はそのまま／`APPROVAL_WAIT` はそのまま／`next_wait` は PR ありで `PR_WAIT`・なしで `NEXT_WAIT`）→ その候補状態の閾値で経過時間判定 → 超過なら `STALE` へ昇格」。`active` 中は PR が開いていても `ACTIVE` を優先する。`CLOSED` は非表示（放置判定の対象外）。

### 5.4 表示ステータスの優先順位（1 instance につき 1 つに絞る）

`STATUS_PRIORITY`（`src/status/status-priority.ts`）が優先順位を数値化する唯一のテーブル。数値が大きいほど注意を要する。

| 表示ステータス  | priority | 意味                                 |
| --------------- | -------- | ------------------------------------ |
| `STALE`         | 5        | 放置                                 |
| `APPROVAL_WAIT` | 4        | 権限待ち                             |
| `PR_WAIT`       | 3        | PR レビュー待ち                      |
| `NEXT_WAIT`     | 2        | 次の指示待ち                         |
| `ACTIVE`        | 1        | 稼働中                               |
| `CLOSED`        | 0        | 非表示（ロールアップの最下位比較用） |

「放置 > 権限待ち > PR レビュー待ち > 次の指示待ち > 稼働中」（§5.2）を数値の大小で表す。この定数はここ一箇所にのみ存在し、hub が `status.priority` として API で返すため、CLI ロールアップは `max()` するだけで済む（優先順位の二重管理を排除）。

### 5.5 ロールアップ

`InstanceStatusRollup` が 1 instance 配下の複数 session の `RollupEntry`（`{ status: StatusResult, lastEventAt: EpochMs }`）から最も優先度の高い（同値なら最も長く経過している）ものを代表に選ぶ。`CLOSED` は最下位優先度なので、稼働中など表示対象の session が 1 つでもあれば closed に覆い隠されない。project 単位のロールアップは CLI 側（`ClientRollup`）の関心事で hub は持たない（§5.3）。

代表選定の前に、instance 内で最も新しい `lastEventAt` から 15 分（`STALE_SESSION_THRESHOLD_MS`、config 化しないハードコード定数）以上離れた session を候補から除外する（孤立 session 除外、release-7 FR-01／`docs/known-issues.md` B7 対応）。`SessionEnd`/`session_lost` を一度も受け取れず `sessions.ended_at` が NULL のまま残った孤立 session が、古い raw_state（例: `next_wait`）のまま稼働中 session の表示を覆い隠す不具合の対症療法で、ライブネス検知（§6、未実装）の代替ではない。基準は絶対時刻（hub の `now`）ではなく instance 内の最新イベント時刻からの相対距離とする。これにより、長時間のツール実行中で instance に新規イベントが無い稼働中 session 自身を誤って stale 扱いしない。instance 内の最新イベントを持つ session は距離 0 で必ず候補に残るため、除外の結果として候補が 0 件になることは構造的に起きない（session が 1 件のみのときも影響を受けない）。

### 5.6 導出パイプライン

`StatusDeriver.deriveForSession()` は判断ロジックを持たない薄いオーケストレーターで、`RawStateResolver`（最新 raw_state）→ `StateTransitionFinder`（遷移時刻）→ `EscalationPolicy`（表示確定）を順に呼び `StatusResult` を組み立てる。hub の `InstanceStatusService` は、`loadEventsForCurrentRun()` で現在の連続区間の判定に十分なイベントだけを `received_at` 降順にページングしながら取得し（`scanForRunBoundary` で境界検出時に打ち切り）、session ごとに導出する。その際、同じ `loadEventsForCurrentRun()` の先頭（`received_at` 降順の最新イベント）を `lastEventAt` として `StatusResult` と組にした `RollupEntry`（§5.5）を作り rollup へ渡して代表を選び、`§8.2` の wire 行へ写す（イベント 0 件の縮退ケースは `lastEventAt` に `now` を安全値として使う）。

---

## 6. 異常終了・ライブネス（現状: 未実装）

- `SessionEnd` は Ctrl+C / `/clear` / 通常終了では発火するが、`kill -9` / 電源断 / ネットワーク切断では発火しない（原理的に不可能）。
- 検知できない異常終了はハートビート方式（`SessionStart` フック内で PID 監視のバックグラウンド子プロセスを生やし、対象 PID が死んだら `session_lost` を 1 回 POST）でカバーする設計だが、**現状はライブネス検知（常駐ハートビート／`session_lost`）を実装していない**。`sessions.last_heartbeat_at` 列と `session_lost` イベント種別は受け皿として先に用意済みで、更新経路はまだ設けていない。放置しきい値（§5.3）のセーフティネットに委ねる。
- release-7 で、`SessionEnd`/`session_lost` を受け取れず `ended_at` が NULL のまま残った孤立 session が、稼働中の別 session の表示を覆い隠す不具合（`docs/known-issues.md` B7）に対し、rollup 側で孤立 session を代表選定から除外する対症療法（§5.5 の stale session 除外）を追加した。これは表示上の症状緩和であり、孤立 session 自体を `CLOSED` へ確定させる根本対応（ライブネス検知）ではない。加えて reporter の `SessionEnd` 送信を高速化（§3、release-7 FR-02）し、Graceful shutdown の猶予内での送達確度を上げたが、終了経路によっては `SessionEnd` フック自体が発火しない可能性が残るため、いずれも対症療法に留まる。
- PID は hook payload に含まれないため（実機 Claude Code 2.1.197 で確認）、将来のハートビートでは reporter が `$PPID` 系譜を辿って `sessions.pid` を自前充填する想定。

---

## 7. データモデル

### 7.1 木構造

```
session（一番細かい単位。agent 側の session_id）
  └─ instance（ディレクトリ単位。git toplevel、非 git なら cwd）
       └─ project（正規化済み project_key 単位）
```

instance は「git worktree」ではなく「ディレクトリ」の単位。worktree を使わない場合は自然に 1 プロジェクト = 1 instance になるだけで特別扱いは不要。`WorktreeCreate` / `WorktreeRemove` は instance 登録の補助情報という位置づけ。

### 7.2 タイムスタンプ

内部の全時刻は **UNIX エポック（ミリ秒）の INTEGER**（放置判定が経過時間の引き算だから）。API 応答時に ISO8601(Z) 文字列へ変換して返す。型は branded 型 `EpochMs` / `DurationMs`（`src/domain/time.ts`）で取り違えを防ぐ。

### 7.3 DDL

`src/db/ddl.ts` の実体。すべて `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` で記述し、起動のたびに冪等適用する（マイグレーションフレームワークは持たない）。`events.received_at` は経過時間計算の権威時刻（§0.5）として DDL に含まれる。

```sql
-- デバイス（レポート送信元）
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,       -- config.yml の device_id
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('hub','child')),
  first_seen_at INTEGER NOT NULL,       -- epoch ms
  last_seen_at  INTEGER NOT NULL
);

-- 論理プロジェクト（正規化済み project_key で識別）
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL UNIQUE,    -- 正規化済み git remote、または local:/nogit: キー
  display_name TEXT,                    -- 未設定なら project_key から自動生成
  created_at   INTEGER NOT NULL
);

-- インスタンス（ディレクトリ単位。worktree の有無に関わらず同じ扱い）
CREATE TABLE IF NOT EXISTS instances (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  path        TEXT NOT NULL,            -- git toplevel。非 git なら cwd
  branch      TEXT,                     -- 非 git なら NULL
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,                  -- WorktreeRemove 等で埋まる
  UNIQUE(device_id, path)
);

-- セッション（1 instance につき履歴として N 件）
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,   -- エージェント側の session_id
  instance_id       TEXT NOT NULL REFERENCES instances(id),
  agent_type        TEXT NOT NULL DEFAULT 'claude_code',  -- 現状 claude_code 固定
  pid               INTEGER,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,               -- clear/logout/prompt_input_exit/session_lost/other
  last_heartbeat_at INTEGER             -- ライブネス未実装のため現状常に NULL
);

-- 生イベントログ（status 導出 + Agent View 用の活動フィード）
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  instance_id   TEXT NOT NULL REFERENCES instances(id),  -- 非正規化。最新状態クエリで JOIN を省く
  event_type    TEXT NOT NULL,          -- SessionStart/.../SessionEnd/session_lost 等
  event_subtype TEXT,                   -- 例: Notification の matcher
  tool_name     TEXT,                   -- Pre/PostToolUse のみ
  tool_summary  TEXT,                   -- 切り詰めた tool_input
  occurred_at   INTEGER NOT NULL,       -- epoch ms。クライアント（デバイス）時刻
  received_at   INTEGER NOT NULL        -- epoch ms。hub 受信時刻（経過時間計算の権威時刻）
);
CREATE INDEX IF NOT EXISTS idx_events_instance_time ON events(instance_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_time  ON events(session_id, occurred_at DESC);

-- PR レビュー状態（GitHub poller が書く。現状 poller 未実装で行は増えない）
CREATE TABLE IF NOT EXISTS pr_status (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch     TEXT NOT NULL,
  pr_number  INTEGER,
  state      TEXT NOT NULL,             -- none/awaiting_review/changes_requested/approved/merged
  url        TEXT,
  checked_at INTEGER NOT NULL,
  UNIQUE(project_id, branch)
);

-- デバイストークン（認証。§0.3）
CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  token_hash  TEXT NOT NULL UNIQUE,    -- SHA-256(token)。生 token は保存しない
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER                  -- revoke 時刻。NULL なら有効
);
CREATE INDEX IF NOT EXISTS idx_tokens_device ON tokens(device_id);
```

### 7.4 起動時の PRAGMA・冪等性

- DB を開く際に `journal_mode=WAL` + `synchronous=NORMAL`（電源断耐性）+ `foreign_keys=ON` を設定する（`src/db/database.ts`）。WAL は永続ファイルでのみ有効。
- 初出の project / instance / session はイベント受信時に自動登録される（冪等）。project は正規化キーで findOrCreate、instance は `(device_id, path)` で upsert（branch は DO UPDATE）、session は `session_id` で upsertStarted。device 行はイベント経路では新規作成せず、認証済み device の `last_seen_at` を touch するに留める（device の登録は bootstrap／pairing 経路が担う）。

---

## 8. Hub API 設計

`src/hub/http-server.ts` の `createHubServer()` が Repository → UseCase/Service → Controller → Router を DI 配線する。リクエストパイプラインは「ルート照合 → 認証（認証必須ルート）→ ボディ JSON パース（POST 系）→ ハンドラ実行 → JSON 応答」。境界での時刻変換（wire は ISO8601、内部は epoch ms）は Controller/DTO 側が担う。

- 既定で全インターフェース（`0.0.0.0`）にバインドし他デバイスからの到達を許可する。config `bind:` で `127.0.0.1` 等へ上書き可能。既定ポートは `47632`（config `port:`）。
- 送信元アドレスは生 TCP 接続の `socket.remoteAddress` のみを見る。`X-Forwarded-For` は一切参照しない（§0.3）。
- リクエストボディ上限は 1 MB（超過は 413）。

### 8.1 認証

- 認証必須ルートは `Authorization: Bearer <device_token>` を要求する。`AuthResolver` が生トークンを SHA-256 照合して device を解決し（`TokenService.verify`）、無効／失効／欠落はすべて 401（`WWW-Authenticate: Bearer`）。
- 書き込みでは、認証済み device の id でボディの `device_id` を必ず上書きする（なりすまし書き込み防止、§0.3）。
- 読み取り API は、有効なトークンであれば発行元デバイスを問わず全デバイスの instance／イベントを返す（所有権チェックは行わない。既知課題 S2）。
- ペアリング系（`pair/start` / `pair/claim`）は認証をスキップする public ルート。デバイス管理系（`devices`）は Bearer 認証に加えて loopback 限定ガードを上乗せする。

### 8.2 実装済みルート一覧

| メソッド | パス                         | 認証              | 用途                                                               |
| -------- | ---------------------------- | ----------------- | ------------------------------------------------------------------ |
| `POST`   | `/api/v1/events`             | Bearer            | 全イベント共通の受け口。project/instance/session を初出自動登録    |
| `GET`    | `/api/v1/instances`          | Bearer            | 一覧。status 導出済みの行を `{ generated_at, instances[] }` で返す |
| `GET`    | `/api/v1/instances/:id`      | Bearer            | 詳細。一覧 1 行 + `recent_events`（直近 100 件、Agent View 用）    |
| `GET`    | `/api/v1/devices`            | Bearer + loopback | 登録デバイス一覧（トークン有効/失効つき）                          |
| `POST`   | `/api/v1/devices/:id/revoke` | Bearer + loopback | 当該 device の有効トークンを一括失効                               |
| `POST`   | `/api/v1/pair/start`         | public + loopback | 6 桁ペアリングコード発行（loopback からのみ）                      |
| `POST`   | `/api/v1/pair/claim`         | public            | コード照合して child 用 device_token を発行                        |

> `POST /api/v1/heartbeat` は handoff §8.1 の設計に含まれるが、ライブネス検知が現状未実装のため**ルートとして登録されていない**（§6 参照）。

### 8.3 書き込みペイロード（`POST /api/v1/events`）

`src/hub/dto.ts` の `rawEventPayloadSchema`（zod）で検証する。reporter は正規化前の生 remote を `instance.remote_url` に載せ、`occurred_at` は ISO8601(Z) 文字列で送る。

```json
{
  "device_id": "macmini-1",
  "session_id": "a1b2c3d4",
  "instance": {
    "remote_url": "git@github.com:sumihiro/ProjectLens.git",
    "path": "/Users/sumihiro/dev/ProjectLens",
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

- `device_id` は body で送るが、hub は認証済み Bearer トークン由来の値で上書きする（body 値は信頼しない）。
- `project_key` は hub が `ProjectKeyNormalizer` で導出する（§11）。
- 成功は 201（`event_id` 等の ack）、スキーマ不適合は 400（`invalid_payload`）。

### 8.4 読み取りレスポンス（`GET /api/v1/instances`）

```json
{
  "generated_at": "2026-07-01T05:20:00Z",
  "instances": [
    {
      "instance_id": "inst_01",
      "project": { "id": "proj_01", "name": "ProjectLens" },
      "device": { "id": "macmini-1", "name": "Mac mini" },
      "path": "/Users/sumihiro/dev/ProjectLens",
      "branch": "feature/ai-sidecar",
      "status": {
        "display": "approval_wait",
        "raw_state": "approval_wait",
        "elapsed_seconds": 720,
        "is_stale": false,
        "priority": 4
      },
      "pr": { "state": "none" },
      "session": { "id": "a1b2c3d4", "last_heartbeat_at": null }
    }
  ]
}
```

- `status.display` / `raw_state` は wire では小文字 snake（例 `approval_wait`）。`priority` は §5.4 の numeric priority。
- project 単位のロールアップは CLI 側で `project_id` により groupBy して計算する（hub は持たない）。
- watch モードは単純ポーリング（数秒おきに叩き直す）。SSE/WebSocket は使わない。

### 8.5 エラー応答

| ステータス | error                                                   | 契機                                                  |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------- |
| 400        | `invalid_json` / `invalid_payload`                      | JSON パース不能／zod 検証失敗                         |
| 401        | `unauthorized`                                          | トークン欠落／無効／失効                              |
| 403        | `loopback_required`                                     | devices/pair-start へ非 loopback からアクセス         |
| 404        | `not_found` / `instance_not_found` / `device_not_found` | 未一致ルート／対象なし                                |
| 405        | `method_not_allowed`                                    | パス一致・メソッド不一致                              |
| 409        | `device_conflict`                                       | claim 時、申告 device が既存かつ有効トークン保持      |
| 413        | `payload_too_large`                                     | ボディが 1 MB 超                                      |
| 500        | `internal_error`                                        | Controller が写し損ねた想定外例外（詳細は漏らさない） |

---

## 9. ペアリングフロー

hub API は常時起動している前提。ペアリングは別モードではなく、常時稼働 API に生えた 2 エンドポイント（`src/hub/pairing-service.ts`・`pair-controller.ts`）。

- **hub 側** `monomi hub pair`: 既に起動している hub API に loopback 宛でリクエストを 1 回投げるクライアント。`PairingService` が 6 桁コードを 5 分 TTL でメモリ上の Map に保持する（SQLite 永続化はしない）。あわせて LAN / Tailscale の到達先候補 URL を表示する。
- **child 側** `monomi pair --code <code> [--hub <url> ...]`: 到達先 URL を手動指定（複数可、指定順が到達優先順）して claim する。成功で発行された device_token を `~/.monomi/config.yml`（`role: child` / `hub_endpoints` / `device_id`）と token ファイルへ保存する（いずれも `chmod 600`）。mDNS 自動探索は現状スコープ外。
- **総当り対策（§0.3）**: `pair/start` は `socket.remoteAddress` のみで loopback 判定する。コード不一致 claim はアクティブな全コードの失敗回数を加算し、5 回で即無効化。正しいコードでの claim は単発破棄（再利用不可）。TTL 切れは `expired`(400)、不一致・使用済みは `invalid_code`(400)、申告 device が既存かつ有効トークン保持なら乗っ取り拒否 `device_conflict`(409) を返し `monomi hub devices revoke <id>` を案内する。
- **1 台体制**（hub のみ）はペアリング不要。hub 起動時（`bootstrap`）に hostname ベースで device_id を自動生成し、ローカル用 token を自動発行して `~/.monomi/token` へ書き出す。冪等（2 回起動しても重複しない）。
- **デバイス管理**: `monomi hub devices list` / `monomi hub devices revoke <id>`。

---

## 10. CLI 設計

### 10.1 ライブラリ

Ink（React reconciler + Yoga レイアウト）。フィルタ・展開など状態遷移の多い画面に宣言的状態管理が向くため採用。watch モードで常駐する用途なので起動コスト 1 回きりは許容範囲。CLI は status 導出ロジックを一切持たない（すべて hub 側 `StatusDeriver` / `InstanceStatusRollup` の責務）。`ClientRollup` は hub が返す numeric priority を `max()` するだけ。

### 10.2 画面イメージ

```
 Claude Code Status ── 8 projects · 2 devices ───────────────────────── 14:32:07

  [1]稼働中 2   [2]権限待ち 1   [3]次の指示待ち 2   [4]PRレビュー待ち 1   [5]放置 2
 ─────────────────────────────────────────────────────────────────────────────
    PROJECT                 DEVICE     BRANCH                    STATE          AGE
  > ProjectLens              Mac mini   feature/ai-sidecar      ● 稼働中        2m
    Monban                   Mac mini   design-b/pty-injection  ○ 権限待ち      12m
 ─────────────────────────────────────────────────────────────────────────────
```

### 10.3 キーバインド（`src/cli/key-binding-controller.ts`）

| キー             | 動作                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| `1`–`5`          | 状態フィルタのトグル（複数選択可、一覧表示中のみ）                      |
| `j`/`k`・`↑`/`↓` | 一覧: カーソル移動（vim 流・矢印両対応） / 詳細: イベント履歴スクロール |
| `Enter`          | 選択 instance の詳細（Agent View Lv.1）を開く                           |
| `←`/`→`          | 詳細: 隣接プロジェクトへ移動（release-6 FR-04）                         |
| `w`              | 詳細: イベント行の折り返し/切り詰め切替（release-6 FR-08）              |
| `esc`            | 戻る（ヘルプを閉じる／詳細から一覧へ）                                  |
| `?`              | ヘルプオーバーレイの表示切替                                            |
| `q`              | 終了                                                                    |

watch モードは常時 ON（数秒おきに一覧を自動更新）で、トグルキーは持たない。ファジー検索 `/`・ソート `s`・デバイス循環 `d` は現状スコープ外。

### 10.4 詳細ビュー（Agent View Lv.1）

1 instance を選択すると、上部「概要」BOX（instance_id・project・device・branch・status・session_id・path・pr）と下部「イベント履歴」BOX（`event_type` / `tool_name` / `tool_summary` 等、`GET /api/v1/instances/:id` の `recent_events`・直近 100 件）を、ともに端末幅一杯の罫線 BOX（タイトルを上辺に左寄せ埋め込み）として重ねて表示する。イベントは hub からは新しい順（API 契約は不変）で届くが、CLI 表示側で反転し古い順・最新が下端のターミナルログ風に描く。`j`/`k`・`↑`/`↓` で 1 行スクロールでき、最下部を表示している間は新着イベントに自動追従（tail-follow）、下辺罫線には表示範囲 `X-Y of Z`（`Z` は取得上限 100 件が上限）を右寄せで埋め込む。`w` でイベント行の切り詰め⇔全文折り返しを切替可能（既定は切り詰め）。詳細ビュー表示中はターミナルのタブ/ウィンドウタイトルが `project名 @ device名` に変わり、一覧に戻ると既定値 `Monomi` に戻る。LLM 要約 recap（Lv.2）は現状スコープ外。

---

## 11. project_key 正規化

`src/domain/project-key-normalizer.ts` の `ProjectKeyNormalizer` が唯一の実装（§0.1）。他のどのクラスも正規化の詳細を知らない。

- **git remote あり**（`GIT_REMOTE`）: scheme / 認証情報を除去 → host 小文字化・ポート除去 → 末尾 `.git` 除去 → `host/owner/repo` 形式に固定。scp 形式（`git@host:owner/repo.git`）と URL 形式の両対応。GitLab のネストサブグループはパスを丸ごと保持。owner/repo の大小文字は保持し、host のみ小文字化する。
- **remote 無し git**（`LOCAL_NO_REMOTE`）: `local:{device_id}:{common-dir または cwd}`。
- **非 git**（`NO_GIT`）: `nogit:{device_id}:{cwd}`。

非 remote / 非 git は device_id を鍵に前置することで、クロスデバイス融合を構造的に禁止する（別マシンの無関係なローカルディレクトリが同一プロジェクトに融合しない）。表示名（`display_name` 未設定時）は project_key 末尾セグメントから自動生成する。

---

## 段階リリースと現状スコープ

handoff §0.4 の段階方針（単機ウェッジ → 認証ハードニング／2 台目 → CLI）は、実際のリリースへ次のように展開された。

| リリース                             | 主な内容（現状仕様として実装済み）                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| release-1 single-machine-wedge       | install-hooks（冪等注入）／bash reporter（outbox・4xx 隔離）／Hub API + SQLite（WAL）／project_key 正規化 hub 一本化／event-time status 導出／単機ウェッジ                                                                                                                                                                                                                                   |
| release-2 biome-migration            | Lint・フォーマットを Biome へ統一（Markdown のみ Prettier）                                                                                                                                                                                                                                                                                                                                  |
| release-3 multi-device-pairing       | 手動ペアリング／tokens 認証・なりすまし防止／マルチエンドポイント順試行／devices 管理                                                                                                                                                                                                                                                                                                        |
| release-4 cli-dashboard-ux           | Ink ダッシュボード／常時 watch／状態フィルタ／詳細ビュー（Agent View Lv.1）                                                                                                                                                                                                                                                                                                                  |
| release-5 docs-restructure           | 現状スナップショット（本ドキュメント等）と設計経緯（handoff 凍結）の分離                                                                                                                                                                                                                                                                                                                     |
| release-6 detail-view-redesign       | 詳細ビュー（Agent View Lv.1）をボーダー付きBOXへ作り直し（概要BOX＋スクロール可能なイベント履歴BOX）／`recent_events` 取得上限を 20→100 件に引き上げ／古い順（最新が下端）表示＋tail-follow／隣接プロジェクト移動（`←`/`→`）／イベント行の折り返し⇔切り詰め切替（`w`）／ターミナルのタブ/ウィンドウタイトル追従                                                                              |
| release-7 session-status-reliability | 孤立 session（`SessionEnd` 未達で `ended_at` NULL のまま残った session）が稼働中 session の表示を覆い隠す不具合（B7）の対症療法として、rollup に stale session 除外（instance 内最新イベントから相対 15 分、§5.5）を追加／reporter の `SessionEnd` 送信高速化（outbox flush スキップ＋先頭候補 1 件のみ `connect-timeout=1s`/`max-time=2s`、§3）。ライブネス検知の本実装は引き続きスコープ外 |

**現状スコープ外／未実装**（受け皿のみ用意、または将来検討）:

- ライブネス検知（常駐ハートビート／`session_lost`／`sessions.last_heartbeat_at` 更新）
- PR レビュー待ち（GitHub poller／`pr_status` への書き込み／`PR_WAIT` の実データ）
- mDNS 自動探索、Windows ネイティブ reporter（PowerShell）、フル TLS
- 読み取り API のデバイス所有権チェック（既知課題 S2）
- CLI の絞り込み系（fuzzy 検索 `/`・ソート `s`・デバイス循環 `d`）／Agent View Lv.2（LLM 要約）
- 他エージェント（Codex 等）対応（`sessions.agent_type` 列のみ先行して用意済み）
