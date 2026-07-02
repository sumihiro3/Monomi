import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config/config.js'
import { resolvePaths, type MonomiPaths } from '../config/paths.js'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { openDatabase, type Database } from '../db/database.js'
import { toEpochMs } from '../domain/time.js'
import { AuthResolver } from './auth-resolver.js'
import { TokenRepository } from '../db/repositories/token-repository.js'
import { TokenService } from './token-service.js'
import { bootstrap } from './bootstrap.js'

let tmpDir: string
let paths: MonomiPaths
let db: Database

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function tableCount(table: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c
}

const fixedNow = () => toEpochMs(1_700_000_000_000)

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-bootstrap-'))
  paths = resolvePaths(tmpDir)
  db = openDatabase(paths.dbFile)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('bootstrap device generation (FR-03 AC-3)', () => {
  it('generates a device_id from the hostname, registers it, and writes it back to config.yml', () => {
    const result = bootstrap(db, paths, { hostname: 'Sumihiros-MacBook-Pro.local', now: fixedNow })

    expect(result.deviceIdGenerated).toBe(true)
    expect(result.deviceId).toBe('sumihiros-macbook-pro')

    const stored = new DeviceRepository(db).findById(result.deviceId)
    expect(stored?.name).toBe('Sumihiros-MacBook-Pro.local')
    expect(stored?.role).toBe('HUB')

    // config.yml now carries the generated device_id and reloads consistently.
    expect(fs.existsSync(paths.configFile)).toBe(true)
    expect(loadConfig(paths).deviceId).toBe('sumihiros-macbook-pro')
  })

  it('reuses an existing config device_id instead of generating one', () => {
    fs.writeFileSync(paths.configFile, '# hand-written config\ndevice_id: my-hub\nport: 51000\n')
    const result = bootstrap(db, paths, { hostname: 'irrelevant-host', now: fixedNow })

    expect(result.deviceIdGenerated).toBe(false)
    expect(result.deviceId).toBe('my-hub')
    // Hand edits (comment + port) are preserved; device_id already present so file is untouched.
    const text = fs.readFileSync(paths.configFile, 'utf8')
    expect(text).toContain('# hand-written config')
    expect(text).toContain('port: 51000')
  })

  it('preserves comments and other keys when writing a generated device_id', () => {
    fs.writeFileSync(paths.configFile, '# keep me\nport: 51000\n')
    bootstrap(db, paths, { hostname: 'macmini', now: fixedNow })

    const text = fs.readFileSync(paths.configFile, 'utf8')
    expect(text).toContain('# keep me')
    expect(text).toContain('port: 51000')
    expect(text).toContain('device_id: macmini')
    expect(loadConfig(paths).port).toBe(51000)
  })

  it('falls back to monomi-hub when the hostname has no usable characters', () => {
    const result = bootstrap(db, paths, { hostname: '...', now: fixedNow })
    expect(result.deviceId).toBe('monomi-hub')
  })
})

describe('bootstrap token provisioning (FR-03 AC-4)', () => {
  it('issues a local token, stores only its hash, and writes the raw token chmod 600', () => {
    const result = bootstrap(db, paths, { hostname: 'macmini', now: fixedNow })

    expect(result.tokenIssued).toBe(true)
    expect(tableCount('tokens')).toBe(1)

    // Raw token lives on disk (for reporter/CLI); DB keeps only the hash.
    expect(fs.existsSync(paths.tokenFile)).toBe(true)
    const fileToken = fs.readFileSync(paths.tokenFile, 'utf8')
    expect(fileToken).toBe(result.rawToken)
    expect(fileToken).not.toContain('\n') // no trailing newline for verbatim cat

    const stored = db.prepare('SELECT token_hash FROM tokens').get() as { token_hash: string }
    expect(stored.token_hash).toBe(sha256Hex(result.rawToken))

    const mode = fs.statSync(paths.tokenFile).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('produces a token that AuthResolver accepts end-to-end', () => {
    const result = bootstrap(db, paths, { hostname: 'macmini', now: fixedNow })

    const auth = new AuthResolver(
      new TokenService(new TokenRepository(db), new DeviceRepository(db))
    )
    const resolved = auth.resolveDevice({
      headers: { authorization: `Bearer ${result.rawToken}` },
    })
    expect(resolved?.id).toBe(result.deviceId)
  })

  it('re-issues when the on-disk token is no longer valid (self-heal)', () => {
    const first = bootstrap(db, paths, { hostname: 'macmini', now: fixedNow })
    // Revoke the only token; the raw token on disk is now invalid.
    const tokenId = new TokenRepository(db).findByHash(sha256Hex(first.rawToken))!.id
    new TokenService(new TokenRepository(db), new DeviceRepository(db)).revoke(tokenId)

    const second = bootstrap(db, paths, { hostname: 'macmini', now: fixedNow })
    expect(second.tokenIssued).toBe(true)
    expect(second.rawToken).not.toBe(first.rawToken)
    expect(fs.readFileSync(paths.tokenFile, 'utf8')).toBe(second.rawToken)
  })
})

describe('bootstrap idempotency', () => {
  it('does not duplicate device or token when run twice', () => {
    const first = bootstrap(db, paths, { hostname: 'macmini', now: fixedNow })
    const second = bootstrap(db, paths, { hostname: 'macmini', now: fixedNow })

    expect(second.deviceId).toBe(first.deviceId)
    expect(second.rawToken).toBe(first.rawToken)
    expect(second.deviceIdGenerated).toBe(false) // config now has device_id
    expect(second.tokenIssued).toBe(false) // existing token reused

    expect(tableCount('devices')).toBe(1)
    expect(tableCount('tokens')).toBe(1)
  })

  it('preserves first_seen_at across runs (device upsert is idempotent)', () => {
    const first = bootstrap(db, paths, { hostname: 'macmini', now: () => toEpochMs(1000) })
    bootstrap(db, paths, { hostname: 'macmini', now: () => toEpochMs(9000) })

    const device = new DeviceRepository(db).findById(first.deviceId)
    expect(device?.firstSeenAt).toBe(1000) // preserved
    expect(device?.lastSeenAt).toBe(9000) // refreshed
  })
})
