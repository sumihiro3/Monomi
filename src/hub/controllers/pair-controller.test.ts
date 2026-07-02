import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceRepository } from '../../db/repositories/device-repository.js'
import { TokenRepository } from '../../db/repositories/token-repository.js'
import { openDatabase, type Database } from '../../db/database.js'
import { toEpochMs, type EpochMs } from '../../domain/time.js'
import type { PairClaimResponse, PairStartResponse } from '../dto.js'
import { PairingService } from '../pairing-service.js'
import type { PublicHubRequest } from '../router.js'
import { TokenService } from '../token-service.js'
import { PairController } from './pair-controller.js'

/**
 * PairController の単体テスト（§9 / FR-02）。実 DB + 実 PairingService（固定コード・注入クロック）を
 * 通し、loopback 判定（AC-2）・claim の成功/失敗マッピング（AC-3/AC-5）を HTTP レイヤー抜きで検証する。
 */

const FIXED_CODE = '482913'
const TTL_MS = 300_000

let tmpDir: string
let db: Database
let devices: DeviceRepository
let tokenService: TokenService
let service: PairingService
let controller: PairController
let nowMs: number

function clock(): EpochMs {
  return toEpochMs(nowMs)
}

/** public リクエスト（未認証。device は常に null、remoteAddress を明示指定）。 */
function publicReq(remoteAddress: string | null, body: unknown = undefined): PublicHubRequest {
  return { params: {}, body, device: null, remoteAddress }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-pairctl-'))
  db = openDatabase(path.join(tmpDir, 'monomi.db'))
  devices = new DeviceRepository(db)
  tokenService = new TokenService(new TokenRepository(db), devices)
  nowMs = 1_000_000
  service = new PairingService(tokenService, devices, {
    now: clock,
    ttlMs: TTL_MS,
    generateCode: () => FIXED_CODE,
  })
  controller = new PairController(service)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('PairController.handleStart loopback gate (FR-02 AC-2)', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.53',
    '::1',
    '::ffff:127.0.0.1',
  ])('accepts loopback remoteAddress %s and returns code + ttl', (address) => {
    const res = controller.handleStart(publicReq(address))
    expect(res.status).toBe(200)
    const body = res.body as PairStartResponse
    expect(body.code).toBe(FIXED_CODE)
    expect(body.ttl_seconds).toBe(300)
    expect(body.expires_at).toBe(new Date(nowMs + TTL_MS).toISOString())
  })

  it.each([
    '203.0.113.7',
    '10.0.0.4',
    '192.168.1.100',
    null,
  ])('rejects non-loopback remoteAddress %s with 403', (address) => {
    const res = controller.handleStart(publicReq(address))
    expect(res.status).toBe(403)
    expect(res.body as { error: string }).toMatchObject({ error: 'loopback_required' })
  })
})

describe('PairController.handleClaim (FR-02 AC-3/AC-5)', () => {
  /** loopback から start を1回叩いて有効なコードを1件用意する。 */
  function startCode(): string {
    return (controller.handleStart(publicReq('127.0.0.1')).body as PairStartResponse).code
  }

  it('claims a valid code → 200 with token + device_id + role child, and registers the device', () => {
    const code = startCode()
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code, device_id: 'macbook', name: 'macbook.local' })
    )
    expect(res.status).toBe(200)

    const body = res.body as PairClaimResponse
    expect(body.device_id).toBe('macbook')
    expect(body.role).toBe('child')
    expect(tokenService.verify(body.token)?.id).toBe('macbook')
    expect(devices.findById('macbook')?.role).toBe('CHILD')
  })

  it('rejects a wrong code → 400 invalid_code', () => {
    startCode()
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code: '000000', device_id: 'x', name: 'x' })
    )
    expect(res.status).toBe(400)
    expect(res.body as { error: string }).toMatchObject({ error: 'invalid_code' })
    expect(devices.findById('x')).toBeNull()
  })

  it('rejects an expired code → 400 code_expired (AC-5)', () => {
    const code = startCode()
    nowMs += TTL_MS
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code, device_id: 'macbook', name: 'macbook.local' })
    )
    expect(res.status).toBe(400)
    expect(res.body as { error: string }).toMatchObject({ error: 'code_expired' })
  })

  it('rejects taking over a device with an active token → 409 device_conflict citing revoke (#8)', () => {
    // 1st claim registers macbook and issues a token.
    controller.handleClaim(
      publicReq('127.0.0.1', { code: startCode(), device_id: 'macbook', name: 'macbook.local' })
    )
    // A fresh code cannot re-register macbook while its token is active.
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code: startCode(), device_id: 'macbook', name: 'attacker.local' })
    )
    expect(res.status).toBe(409)
    expect(res.body as { error: string; message: string }).toMatchObject({
      error: 'device_conflict',
    })
    expect((res.body as { message: string }).message).toContain('monomi hub devices revoke macbook')
  })

  it('allows re-pairing after revoke → 200 (#8)', () => {
    controller.handleClaim(
      publicReq('127.0.0.1', { code: startCode(), device_id: 'macbook', name: 'macbook.local' })
    )
    tokenService.revokeAllForDevice('macbook')
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code: startCode(), device_id: 'macbook', name: 'macbook.local' })
    )
    expect(res.status).toBe(200)
    expect((res.body as PairClaimResponse).device_id).toBe('macbook')
  })

  it('rejects a malformed payload (missing device_id) → 400 invalid_payload', () => {
    const code = startCode()
    const res = controller.handleClaim(publicReq('127.0.0.1', { code }))
    expect(res.status).toBe(400)
    expect(res.body as { error: string }).toMatchObject({ error: 'invalid_payload' })
  })

  it('rejects a device_id longer than 64 chars → 400 invalid_payload (#9)', () => {
    const code = startCode()
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code, device_id: 'a'.repeat(65), name: 'macbook.local' })
    )
    expect(res.status).toBe(400)
    expect(res.body as { error: string }).toMatchObject({ error: 'invalid_payload' })
    expect(devices.findById('a'.repeat(65))).toBeNull()
  })

  it('rejects a device_id containing invalid characters → 400 invalid_payload (#9)', () => {
    const code = startCode()
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code, device_id: 'mac book/../etc', name: 'macbook.local' })
    )
    expect(res.status).toBe(400)
    expect(res.body as { error: string }).toMatchObject({ error: 'invalid_payload' })
  })

  it('rejects a name longer than 128 chars → 400 invalid_payload (#9)', () => {
    const code = startCode()
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code, device_id: 'macbook', name: 'a'.repeat(129) })
    )
    expect(res.status).toBe(400)
    expect(res.body as { error: string }).toMatchObject({ error: 'invalid_payload' })
    expect(devices.findById('macbook')).toBeNull()
  })

  it('accepts a device_id at the 64-char boundary with allowed characters (#9)', () => {
    const code = startCode()
    const deviceId = `${'a'.repeat(60)}_._-`
    const res = controller.handleClaim(
      publicReq('127.0.0.1', { code, device_id: deviceId, name: 'macbook.local' })
    )
    expect(res.status).toBe(200)
    expect(devices.findById(deviceId)?.role).toBe('CHILD')
  })
})
