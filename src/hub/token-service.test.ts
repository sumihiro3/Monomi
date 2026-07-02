import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { TokenRepository } from '../db/repositories/token-repository.js'
import { openDatabase, type Database } from '../db/database.js'
import type { Device } from '../domain/entities.js'
import { toEpochMs } from '../domain/time.js'
import { AuthResolver } from './auth-resolver.js'
import { TokenService } from './token-service.js'

let tmpDir: string
let db: Database
let devices: DeviceRepository
let tokens: TokenRepository
let service: TokenService
let device: Device

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-token-'))
  db = openDatabase(path.join(tmpDir, 'monomi.db'))
  devices = new DeviceRepository(db)
  tokens = new TokenRepository(db)
  service = new TokenService(tokens, devices)
  device = devices.upsert({
    id: 'macmini-1',
    name: 'Mac mini',
    role: 'HUB',
    firstSeenAt: toEpochMs(1000),
    lastSeenAt: toEpochMs(1000),
  })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('TokenService.issue (FR-03 AC-4)', () => {
  it('stores only the SHA-256 hash, never the raw token', () => {
    const raw = service.issue(device.id)

    const rows = db.prepare('SELECT device_id, token_hash FROM tokens').all() as {
      device_id: string
      token_hash: string
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].device_id).toBe(device.id)
    expect(rows[0].token_hash).toBe(sha256Hex(raw))
    expect(rows[0].token_hash).not.toBe(raw) // hash, not the raw token
    // The raw token must not be persisted verbatim in any tokens column.
    const leaked = db.prepare('SELECT 1 FROM tokens WHERE token_hash = ?').get(raw)
    expect(leaked).toBeUndefined()
  })

  it('produces high-entropy, unique tokens across calls', () => {
    const other = devices.upsert({
      id: 'macmini-2',
      name: 'Mac mini 2',
      role: 'HUB',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    })
    const a = service.issue(device.id)
    const b = service.issue(other.id)

    expect(a).not.toBe(b)
    // 32 random bytes base64url-encoded => 43 chars (256 bits of entropy).
    expect(a.length).toBeGreaterThanOrEqual(43)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('TokenService.verify', () => {
  it('resolves a valid token to its device', () => {
    const raw = service.issue(device.id)
    const resolved = service.verify(raw)

    expect(resolved).not.toBeNull()
    expect(resolved?.id).toBe(device.id)
    expect(resolved?.name).toBe('Mac mini')
    expect(resolved?.role).toBe('HUB')
  })

  it('returns null for an unknown or empty token', () => {
    service.issue(device.id)
    expect(service.verify('not-a-real-token')).toBeNull()
    expect(service.verify('')).toBeNull()
  })

  it('returns null once the token is revoked', () => {
    const raw = service.issue(device.id)
    const tokenId = tokens.findByHash(sha256Hex(raw))!.id

    expect(service.verify(raw)?.id).toBe(device.id)
    service.revoke(tokenId)
    expect(service.verify(raw)).toBeNull()
  })

  it('cannot issue a token for an unregistered device (FK guards the device link)', () => {
    expect(() => service.issue('ghost-device')).toThrow() // FK: devices(id) missing
  })
})

describe('TokenService.activeDeviceIds (review #3)', () => {
  it('returns the set of device ids with at least one active token, 1 query for all devices', () => {
    const other = devices.upsert({
      id: 'macmini-2',
      name: 'Mac mini 2',
      role: 'HUB',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    })
    const raw = service.issue(device.id)
    service.issue(other.id)
    service.revoke(tokens.findByHash(sha256Hex(raw))!.id) // device now has no active token

    const activeIds = service.activeDeviceIds()
    expect(activeIds).toEqual(new Set([other.id]))
    expect(activeIds.has(device.id)).toBe(false)
  })

  it('returns an empty set when no device has an active token', () => {
    expect(service.activeDeviceIds()).toEqual(new Set())
  })
})

describe('AuthResolver', () => {
  let auth: AuthResolver

  beforeEach(() => {
    auth = new AuthResolver(service)
  })

  it('resolves the device from a Bearer header (case-insensitive scheme)', () => {
    const raw = service.issue(device.id)
    expect(auth.resolveDevice({ headers: { authorization: `Bearer ${raw}` } })?.id).toBe(device.id)
    expect(auth.resolveDevice({ headers: { authorization: `bearer ${raw}` } })?.id).toBe(device.id)
  })

  it('returns null for missing, malformed or empty Authorization headers', () => {
    expect(auth.resolveDevice({ headers: {} })).toBeNull()
    expect(auth.resolveDevice({ headers: { authorization: 'Basic abc' } })).toBeNull()
    expect(auth.resolveDevice({ headers: { authorization: 'Bearer ' } })).toBeNull()
    expect(auth.resolveDevice({ headers: { authorization: 'Bearer' } })).toBeNull()
  })

  it('returns null for a well-formed header carrying an invalid token', () => {
    expect(auth.resolveDevice({ headers: { authorization: 'Bearer deadbeef' } })).toBeNull()
  })
})
