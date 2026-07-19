import type { Database } from './database.js'

/**
 * ALTER TABLE ADD COLUMN 対象の1列を表す（列名 + SQLite 型 + 任意の NOT NULL DEFAULT）。
 *
 * SQLite の `ALTER TABLE ADD COLUMN` は `NOT NULL` 制約を付けるなら定数の `DEFAULT`
 * が必須（既存行を埋めるため）。`notNullDefault` を指定した列は `ddl.ts` の対応する
 * `NOT NULL DEFAULT <値>` 定義と一致させる。
 */
interface ColumnDefinition {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER'
  /** 指定すると `NOT NULL DEFAULT <値>` を列定義に付与する（未指定なら nullable）。 */
  readonly notNullDefault?: string
}

/** 列定義を `ALTER TABLE ADD COLUMN` に渡す SQL 断片へ変換する。 */
function columnDefinitionSql(column: ColumnDefinition): string {
  const constraint =
    column.notNullDefault === undefined ? '' : ` NOT NULL DEFAULT ${column.notNullDefault}`
  return `${column.name} ${column.type}${constraint}`
}

/** 1テーブルに対する冪等マイグレーション定義（対象テーブル名 + 追加列一覧）。 */
interface TableMigration {
  readonly table: string
  readonly columns: readonly ColumnDefinition[]
}

/**
 * 既存 DB に対して `ALTER TABLE ADD COLUMN` で追加する列の一覧（テーブルごと）。
 *
 * `ddl.ts` の `CREATE TABLE IF NOT EXISTS` は新規 DB にしか効かないため、
 * 既存 DB にこれらの列を追加するのは {@link applyMigrations} の役目。
 * 各テーブルの一覧は `ddl.ts` の対応するテーブル定義と一致させる。
 */
const TABLE_MIGRATIONS: readonly TableMigration[] = [
  {
    // release-23（FR-02a）で追加された reporter 捕捉のターミナル特定情報
    // （`wezterm_pane` のみ release-28 FR-02 で追加）。
    table: 'sessions',
    columns: [
      { name: 'tty', type: 'TEXT' },
      { name: 'term_program', type: 'TEXT' },
      { name: 'tmux_pane', type: 'TEXT' },
      { name: 'tmux_socket', type: 'TEXT' },
      { name: 'wsl_distro', type: 'TEXT' },
      { name: 'wt_session', type: 'TEXT' },
      { name: 'wezterm_pane', type: 'TEXT' },
      { name: 'terminal_seen_at', type: 'INTEGER' },
    ],
  },
  {
    // release-27（FR-03）で追加された Draft PR フラグ。
    table: 'pr_status',
    columns: [{ name: 'is_draft', type: 'INTEGER', notNullDefault: '0' }],
  },
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
 * `table` が存在するかどうか。
 *
 * `PRAGMA table_info()` は存在しないテーブルに対しても例外を投げず空行を返すため、
 * 「テーブルが存在しない」と「列を持たないテーブル」を区別するために使う
 * （実テーブルは必ず1列以上持つため、後者は実質発生しない）。
 * `ALTER TABLE` は対象テーブルが無いと例外を投げるため、複数テーブルを順にマイグレーション
 * する {@link applyMigrations} が個々のテーブル欠落で全体を落とさないためのガード。
 */
function tableExists(db: Database, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  return row !== undefined
}

/**
 * 既存 DB に対する冪等な列追加マイグレーション（FR-02a AC-3 / release-27 FR-03 AC-2）。
 *
 * ARCHITECTURE §7.3「マイグレーションフレームワークを持たない」からの意図的逸脱。
 * DDL の `CREATE TABLE IF NOT EXISTS` は既存 DB への列追加ができないため、
 * {@link TABLE_MIGRATIONS} に定義されたテーブルごとに `PRAGMA table_info` で
 * 欠落している列だけを `ALTER TABLE ADD COLUMN` する。
 *
 * `openDatabase()` が `db.exec(DDL)` 直後に呼ぶ想定。新規 DB では DDL が全列を
 * 作成済みのため、このマイグレーションは何もしない（冪等）。対象テーブル自体が
 * 存在しない場合（テスト用の部分スキーマ等）はそのテーブルをスキップし、他テーブルの
 * マイグレーションには影響しない。
 *
 * @param db PRAGMA 設定・DDL 適用済みの {@link Database}。
 */
export function applyMigrations(db: Database): void {
  for (const migration of TABLE_MIGRATIONS) {
    if (!tableExists(db, migration.table)) {
      continue
    }
    const existing = existingColumnNames(db, migration.table)
    for (const column of migration.columns) {
      if (!existing.has(column.name)) {
        db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${columnDefinitionSql(column)}`)
      }
    }
  }
}
