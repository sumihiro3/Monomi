import type { Database } from './database.js'

/** ALTER TABLE ADD COLUMN 対象の1列を表す（列名 + SQLite 型）。 */
interface ColumnDefinition {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER'
}

/**
 * `sessions` テーブルへ release-23（FR-02a）で追加された列。
 *
 * `ddl.ts` の `CREATE TABLE IF NOT EXISTS` は新規 DB にしか効かないため、
 * 既存 DB にこれらの列を追加するのは {@link applyMigrations} の役目。
 * 一覧は `ddl.ts` の `sessions` 定義と一致させる。
 */
const SESSIONS_ADDED_COLUMNS: readonly ColumnDefinition[] = [
  { name: 'tty', type: 'TEXT' },
  { name: 'term_program', type: 'TEXT' },
  { name: 'tmux_pane', type: 'TEXT' },
  { name: 'tmux_socket', type: 'TEXT' },
  { name: 'wsl_distro', type: 'TEXT' },
  { name: 'wt_session', type: 'TEXT' },
  { name: 'terminal_seen_at', type: 'INTEGER' },
]

/** `PRAGMA table_info(<table>)` の行（必要なフィールドのみ）。 */
interface TableInfoRow {
  name: string
}

/** `table` の既存列名を集合として返す。 */
function existingColumnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[]
  return new Set(rows.map((row) => row.name))
}

/**
 * 既存 DB に対する冪等な列追加マイグレーション（FR-02a AC-3）。
 *
 * ARCHITECTURE §7.3「マイグレーションフレームワークを持たない」からの初の意図的逸脱。
 * DDL の `CREATE TABLE IF NOT EXISTS` は既存 DB への列追加ができないため、
 * `PRAGMA table_info(sessions)` で欠落している列だけを `ALTER TABLE ADD COLUMN` する。
 *
 * `openDatabase()` が `db.exec(DDL)` 直後に呼ぶ想定。新規 DB では DDL が全列を
 * 作成済みのため、このマイグレーションは何もしない（冪等）。
 *
 * @param db PRAGMA 設定・DDL 適用済みの {@link Database}。
 */
export function applyMigrations(db: Database): void {
  const existing = existingColumnNames(db, 'sessions')
  for (const column of SESSIONS_ADDED_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${column.name} ${column.type}`)
    }
  }
}
