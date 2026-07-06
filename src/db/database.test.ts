import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_FILE_MODE, openDatabase, type Database } from './database.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-database-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('openDatabase permissions (FR-02)', () => {
  it('chmods a real DB file to 0o600 on creation (AC-1/AC-2)', () => {
    const dbFile = path.join(tmpDir, 'monomi.db')
    let db: Database | undefined
    try {
      db = openDatabase(dbFile)
      const mode = fs.statSync(dbFile).mode & 0o777
      expect(mode).toBe(DB_FILE_MODE)
      expect(mode).toBe(0o600)
    } finally {
      db?.close()
    }
  })

  it('re-applies 0o600 unconditionally even when the file already had looser permissions', () => {
    const dbFile = path.join(tmpDir, 'existing.db')
    // Pre-create the file with an intentionally looser mode to simulate a DB
    // created before this permission hardening existed.
    fs.writeFileSync(dbFile, '')
    fs.chmodSync(dbFile, 0o644)

    let db: Database | undefined
    try {
      db = openDatabase(dbFile)
      const mode = fs.statSync(dbFile).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      db?.close()
    }
  })

  it('opens an in-memory DB without throwing and without touching the filesystem (AC-2)', () => {
    let db: Database | undefined
    expect(() => {
      db = openDatabase(':memory:')
    }).not.toThrow()
    expect(db).toBeDefined()
    db?.close()
  })
})
