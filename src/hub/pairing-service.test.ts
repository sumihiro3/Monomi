import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { TokenRepository } from '../db/repositories/token-repository.js'
import { openDatabase, type Database } from '../db/database.js'
import { toEpochMs, type EpochMs } from '../domain/time.js'
import { PairingService, type PairingServiceOptions } from './pairing-service.js'
import { TokenService } from './token-service.js'

/**
 * PairingService の単体テスト（§9 / §0.3 / FR-02）。実 DB（temp file）に DeviceRepository +
 * TokenService を通し、コード発行 / TTL / 単発破棄 / 失敗5回無効化 / child 登録 + token 発行を
 * 決定的な注入クロック・固定コードで検証する。
 */

const FIXED_CODE = '482913'
const TTL_MS = 300_000

let tmpDir: string
let db: Database
let devices: DeviceRepository
let tokenService: TokenService
/** 注入クロック（TTL 判定を決定的にする）。 */
let nowMs: number

function clock(): EpochMs {
  return toEpochMs(nowMs)
}

function makeService(options: PairingServiceOptions = {}): PairingService {
  return new PairingService(tokenService, devices, {
    now: clock,
    ttlMs: TTL_MS,
    generateCode: () => FIXED_CODE,
    ...options,
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-pairing-'))
  db = openDatabase(path.join(tmpDir, 'monomi.db'))
  devices = new DeviceRepository(db)
  tokenService = new TokenService(new TokenRepository(db), devices)
  nowMs = 1_000_000
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('PairingService.startPairing (§9 / FR-02 AC-1)', () => {
  it('issues a code with expiresAt = now + ttl and returns the ttl', () => {
    const service = makeService()
    const issued = service.startPairing()
    expect(issued.code).toBe(FIXED_CODE)
    expect(issued.expiresAt).toBe(toEpochMs(nowMs + TTL_MS))
    expect(issued.ttlMs).toBe(TTL_MS)
  })

  it('generates a 6-digit zero-padded code by default', () => {
    const service = new PairingService(tokenService, devices, { now: clock })
    expect(service.startPairing().code).toMatch(/^\d{6}$/)
  })
})

describe('PairingService.claim success (§0.3 / FR-02 AC-3)', () => {
  it('registers the child as CHILD and issues a working device_token', () => {
    const service = makeService()
    const { code } = service.startPairing()

    const result = service.claim(code, { deviceId: 'macbook', name: 'macbook.local' })
    expect(result).toEqual({ ok: true, token: expect.any(String), deviceId: 'macbook' })

    // child が upsert 登録され、発行トークンが verify を通る（→ 以降 Bearer 認証で使える）。
    const registered = devices.findById('macbook')
    expect(registered).toMatchObject({ id: 'macbook', name: 'macbook.local', role: 'CHILD' })
    if (result.ok) {
      expect(tokenService.verify(result.token)?.id).toBe('macbook')
    }
  })

  it('is single-use: the same code cannot be claimed twice (§0.3)', () => {
    const service = makeService()
    const { code } = service.startPairing()

    expect(service.claim(code, { deviceId: 'macbook', name: 'macbook.local' }).ok).toBe(true)
    const again = service.claim(code, { deviceId: 'macbook', name: 'macbook.local' })
    expect(again).toEqual({ ok: false, reason: 'invalid_code' })
  })
})

describe('PairingService.claim TTL (§9 / FR-02 AC-5)', () => {
  it('returns expired once the TTL has elapsed and does not register a device', () => {
    const service = makeService()
    const { code } = service.startPairing()

    nowMs += TTL_MS // exactly at the expiry boundary → expired
    const result = service.claim(code, { deviceId: 'macbook', name: 'macbook.local' })
    expect(result).toEqual({ ok: false, reason: 'expired' })
    expect(devices.findById('macbook')).toBeNull()
  })
})

describe('PairingService.claim brute-force protection (§0.3 / FR-02 AC-4)', () => {
  it('invalidates the code after 5 failed attempts, then rejects the correct code', () => {
    const service = makeService()
    const { code } = service.startPairing()

    for (let i = 0; i < 5; i++) {
      expect(service.claim('000000', { deviceId: 'x', name: 'x' })).toEqual({
        ok: false,
        reason: 'invalid_code',
      })
    }
    // 5 failures invalidated the code: even the correct code now fails.
    expect(service.claim(code, { deviceId: 'macbook', name: 'macbook.local' })).toEqual({
      ok: false,
      reason: 'invalid_code',
    })
    expect(devices.findById('macbook')).toBeNull()
  })

  it('still accepts the correct code after 4 failures (threshold is exactly 5)', () => {
    const service = makeService()
    const { code } = service.startPairing()

    for (let i = 0; i < 4; i++) {
      service.claim('000000', { deviceId: 'x', name: 'x' })
    }
    expect(service.claim(code, { deviceId: 'macbook', name: 'macbook.local' }).ok).toBe(true)
  })
})

describe('PairingService.claim device takeover (§0.3 / FR-02 #8)', () => {
  it('rejects claiming an existing device_id that still holds an active token', () => {
    const service = makeService()
    // 1st pairing: macbook is registered and gets an active token.
    expect(
      service.claim(service.startPairing().code, { deviceId: 'macbook', name: 'macbook.local' }).ok
    ).toBe(true)

    // A fresh, valid code cannot re-register the same device_id while it holds an active token.
    const { code } = service.startPairing()
    expect(service.claim(code, { deviceId: 'macbook', name: 'macbook.local' })).toEqual({
      ok: false,
      reason: 'device_conflict',
    })
  })

  it('does not register/replace the device or issue a token on a takeover attempt', () => {
    const service = makeService()
    const first = service.claim(service.startPairing().code, {
      deviceId: 'macbook',
      name: 'macbook.local',
    })
    expect(first.ok).toBe(true)

    // Attempt to take over macbook under a different display name.
    const before = devices.findById('macbook')
    const { code } = service.startPairing()
    expect(service.claim(code, { deviceId: 'macbook', name: 'attacker.local' }).ok).toBe(false)

    // The stored device is untouched (name not overwritten) and no new token was issued.
    expect(devices.findById('macbook')).toEqual(before)
    if (first.ok) {
      expect(tokenService.verify(first.token)?.id).toBe('macbook')
    }
  })

  it('does not consume the pairing code on a takeover attempt (code stays claimable)', () => {
    const service = makeService()
    expect(
      service.claim(service.startPairing().code, { deviceId: 'macbook', name: 'macbook.local' }).ok
    ).toBe(true)

    // Conflict does not delete the entry.
    const { code } = service.startPairing()
    expect(service.claim(code, { deviceId: 'macbook', name: 'macbook.local' })).toEqual({
      ok: false,
      reason: 'device_conflict',
    })

    // After the device's tokens are revoked, the SAME in-flight code completes the pairing.
    tokenService.revokeAllForDevice('macbook')
    expect(service.claim(code, { deviceId: 'macbook', name: 'macbook.local' }).ok).toBe(true)
  })
})

describe('PairingService.claim re-pairing after revoke (§0.3 / FR-02 #8)', () => {
  it('allows re-pairing the same device_id once its active token is revoked', () => {
    const service = makeService()
    expect(
      service.claim(service.startPairing().code, { deviceId: 'macbook', name: 'macbook.local' }).ok
    ).toBe(true)

    // Revoke frees the id: hasActiveToken(macbook) becomes false.
    tokenService.revokeAllForDevice('macbook')

    const result = service.claim(service.startPairing().code, {
      deviceId: 'macbook',
      name: 'macbook.local',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.deviceId).toBe('macbook')
      // The re-issued token authenticates; the revoked one does not.
      expect(tokenService.verify(result.token)?.id).toBe('macbook')
    }
  })

  it('keeps the original device_id / first_seen_at when re-pairing after revoke (upsert semantics)', () => {
    const service = makeService()
    expect(
      service.claim(service.startPairing().code, { deviceId: 'macbook', name: 'macbook.local' }).ok
    ).toBe(true)
    const firstSeen = devices.findById('macbook')?.firstSeenAt

    tokenService.revokeAllForDevice('macbook')
    nowMs += 60_000 // re-pair later; first_seen_at must be preserved, last_seen_at may advance
    expect(
      service.claim(service.startPairing().code, { deviceId: 'macbook', name: 'macbook.local' }).ok
    ).toBe(true)

    expect(devices.findById('macbook')?.firstSeenAt).toBe(firstSeen)
  })
})
