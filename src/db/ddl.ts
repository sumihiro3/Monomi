/**
 * Monomi hub の SQLite スキーマ定義（§7.3 DDL + §0.3 tokens + §0.5 received_at 補正）。
 *
 * すべて `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` で記述し、
 * 起動のたびに冪等適用できるようにする（マイグレーションフレームワークは v1 では持たない）。
 *
 * §7.3 からの意図的な差分:
 * - `events` テーブルに `received_at INTEGER NOT NULL` を追加。§0.5 が経過時間計算の
 *   権威時刻を hub 受信時刻とするため（クロックスキュー排除）。§0 は §7.3 より優先する。
 *
 * release-1 スコープ外の列も DDL 上は用意する（更新経路は設けない）:
 * - `sessions.last_heartbeat_at`: ライブネス検知（§0.4 v1延期）の受け皿。列のみ。
 * - `pr_status`: GitHub poller（§0.4 v1延期）の受け皿。テーブルのみ作成し行は増えない。
 *
 * release-23（FR-02a）からの意図的な差分:
 * - `sessions` テーブルに reporter 捕捉のターミナル特定情報
 *   （`tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session`/`terminal_seen_at`）
 *   を追加。この DDL 自体は `CREATE TABLE IF NOT EXISTS` のため新規 DB にしか効かず、
 *   既存 DB への列追加は `./migrations.js` の `applyMigrations()` が別途担う
 *   （ARCHITECTURE §7.3「マイグレーションフレームワークを持たない」からの初の意図的逸脱）。
 */
export const DDL = `
-- デバイス（レポート送信元）
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('hub','child')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- 論理プロジェクト（git remote / common-dir で識別）
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at   INTEGER NOT NULL
);

-- インスタンス（ディレクトリ単位。worktree の有無に関わらず同じ扱い）
CREATE TABLE IF NOT EXISTS instances (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  path        TEXT NOT NULL,
  branch      TEXT,
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,
  UNIQUE(device_id, path)
);

-- Claude Code(等)セッション（1 instance につき履歴として N 件）
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  instance_id       TEXT NOT NULL REFERENCES instances(id),
  agent_type        TEXT NOT NULL DEFAULT 'claude_code',
  pid               INTEGER,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,
  last_heartbeat_at INTEGER,
  tty               TEXT,
  term_program      TEXT,
  tmux_pane         TEXT,
  tmux_socket       TEXT,
  wsl_distro        TEXT,
  wt_session        TEXT,
  terminal_seen_at  INTEGER
);

-- 生イベントログ（status 導出 + Agent View 用の活動フィード）
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  instance_id   TEXT NOT NULL REFERENCES instances(id),
  event_type    TEXT NOT NULL,
  event_subtype TEXT,
  tool_name     TEXT,
  tool_summary  TEXT,
  occurred_at   INTEGER NOT NULL,
  received_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_instance_time ON events(instance_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_time  ON events(session_id, occurred_at DESC);

-- PR レビュー状態（GitHub poller が書く。release-1 では行は増えない）
CREATE TABLE IF NOT EXISTS pr_status (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch     TEXT NOT NULL,
  pr_number  INTEGER,
  state      TEXT NOT NULL,
  url        TEXT,
  checked_at INTEGER NOT NULL,
  UNIQUE(project_id, branch)
);

-- デバイストークン（認証。§0.3）
CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_device ON tokens(device_id);
`
