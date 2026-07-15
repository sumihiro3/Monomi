import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from './database.js'
import { openDatabase } from './database.js'
import { applyMigrations } from './migrations.js'

/**
 * `database.ts` と同じ手法（`node:sqlite` は experimental のため静的 import を避け
 * `createRequire` で実行時に解決する）で、DDL を経由しない生の {@link Database} を用意する。
 * release-23 の DDL には既にターミナル列が含まれるため、DDL 経由では「旧 DB」を再現できない。
 */
const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite')

/** release-23（FR-02a）より前の `sessions` テーブル相当の DDL。 */
const PRE_RELEASE_23_SESSIONS_DDL = `
CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  instance_id       TEXT NOT NULL,
  agent_type        TEXT NOT NULL DEFAULT 'claude_code',
  pid               INTEGER,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,
  last_heartbeat_at INTEGER
);
`

const TERMINAL_COLUMNS = [
  'tty',
  'term_program',
  'tmux_pane',
  'tmux_socket',
  'wsl_distro',
  'wt_session',
  'terminal_seen_at',
]

/** 指定テーブルの列名一覧をソート済みで返す（列追加の順序に依存しない比較のため）。 */
function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[])
    .map((row) => row.name)
    .sort()
}

/** DDL を経由しない、release-23 より前の `sessions` テーブルのみを持つ生 DB を用意する。 */
function openPreRelease23Db(): Database {
  const db = new DatabaseSyncCtor(':memory:')
  db.exec(PRE_RELEASE_23_SESSIONS_DDL)
  return db
}

describe('applyMigrations (FR-02a AC-3)', () => {
  let db: Database | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('adds the release-23 terminal columns to a pre-release-23 sessions table', () => {
    db = openPreRelease23Db()

    applyMigrations(db)

    const cols = columnNames(db, 'sessions')
    for (const expected of TERMINAL_COLUMNS) {
      expect(cols).toContain(expected)
    }
  })

  it('is idempotent: re-applying does not throw and does not duplicate columns', () => {
    const rawDb = openPreRelease23Db()
    db = rawDb

    applyMigrations(rawDb)
    expect(() => applyMigrations(rawDb)).not.toThrow()

    const cols = columnNames(rawDb, 'sessions')
    expect(new Set(cols).size).toBe(cols.length)
  })

  it('leaves the sessions column set identical to a fresh DDL-created DB', () => {
    db = openPreRelease23Db()
    applyMigrations(db)
    const migratedCols = columnNames(db, 'sessions')

    let freshDb: Database | undefined
    try {
      freshDb = openDatabase(':memory:')
      const freshCols = columnNames(freshDb, 'sessions')
      expect(migratedCols).toEqual(freshCols)
    } finally {
      freshDb?.close()
    }
  })
})
