import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceRepository } from '../../db/repositories/device-repository.js'
import { TokenRepository } from '../../db/repositories/token-repository.js'
import { openDatabase, type Database } from '../../db/database.js'
import type { Device } from '../../domain/entities.js'
import { toEpochMs } from '../../domain/time.js'
import type { DeviceDto, DeviceRevokeResult } from '../dto.js'
import type { HubRequest } from '../router.js'
import { TokenService } from '../token-service.js'
import { DevicesController } from './devices-controller.js'

/**
 * DevicesController の単体テスト（FR-03）。実 DB（temp file）に device/token を用意し、
 * DeviceRepository + TokenService を通した handleList/handleRevoke の振る舞いを検証する。
 */

let tmpDir: string
let db: Database
let devices: DeviceRepository
let tokenRepo: TokenRepository
let tokenService: TokenService
let controller: DevicesController

/** 認証済みリクエストの device は本 Controller では未使用なので固定のダミーで足りる。 */
const AUTHED_DEVICE: Device = {
  id: 'macmini',
  name: 'macmini.local',
  role: 'HUB',
  firstSeenAt: toEpochMs(0),
  lastSeenAt: toEpochMs(0),
}

/** 既定は loopback（`127.0.0.1`）。ガードのテストでは明示的に非 loopback を渡す。 */
function req(
  params: Record<string, string> = {},
  remoteAddress: string | null = '127.0.0.1'
): HubRequest {
  return { params, body: undefined, device: AUTHED_DEVICE, remoteAddress }
}

function seedDevice(id: string, name: string, role: Device['role'], seenAt: number): Device {
  return devices.upsert({
    id,
    name,
    role,
    firstSeenAt: toEpochMs(seenAt),
    lastSeenAt: toEpochMs(seenAt),
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-devctl-'))
  db = openDatabase(path.join(tmpDir, 'monomi.db'))
  devices = new DeviceRepository(db)
  tokenRepo = new TokenRepository(db)
  tokenService = new TokenService(tokenRepo, devices)
  controller = new DevicesController(devices, tokenService)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('DevicesController.handleList (FR-03 AC-1)', () => {
  it('lists devices first_seen_at ascending with wire-shaped fields and token status', () => {
    seedDevice('macmini', 'macmini.local', 'HUB', 1000)
    seedDevice('macbook', 'macbook.local', 'CHILD', 2000)
    tokenService.issue('macmini') // active token
    const revoked = tokenService.issue('macbook')
    // Revoke macbook's only token so has_active_token flips to false.
    tokenService.revokeAllForDevice('macbook')
    expect(tokenService.verify(revoked)).toBeNull()

    const res = controller.handleList(req())
    expect(res.status).toBe(200)
    const { devices: rows } = res.body as { devices: DeviceDto[] }

    expect(rows.map((d) => d.id)).toEqual(['macmini', 'macbook'])
    expect(rows[0]).toMatchObject({
      id: 'macmini',
      name: 'macmini.local',
      role: 'hub', // wire lowercase
      has_active_token: true,
    })
    expect(rows[0].first_seen_at).toBe(new Date(1000).toISOString())
    expect(rows[0].last_seen_at).toBe(new Date(1000).toISOString())
    expect(rows[1]).toMatchObject({ id: 'macbook', role: 'child', has_active_token: false })
  })

  it('reports has_active_token false for a device that never had a token', () => {
    seedDevice('ipad', 'ipad.local', 'CHILD', 3000)
    const rows = (controller.handleList(req()).body as { devices: DeviceDto[] }).devices
    expect(rows).toHaveLength(1)
    expect(rows[0].has_active_token).toBe(false)
  })
})

describe('DevicesController.handleRevoke (FR-03 AC-2)', () => {
  it('revokes all active tokens and makes verify fail afterwards (→ 401 upstream)', () => {
    seedDevice('macbook', 'macbook.local', 'CHILD', 2000)
    const t1 = tokenService.issue('macbook')
    const t2 = tokenService.issue('macbook')
    expect(tokenService.verify(t1)?.id).toBe('macbook')

    const res = controller.handleRevoke(req({ id: 'macbook' }))
    expect(res.status).toBe(200)
    expect(res.body as DeviceRevokeResult).toEqual({
      ok: true,
      device_id: 'macbook',
      revoked: 2,
    })

    // Both tokens now fail verification (the auth pipeline turns null into 401).
    expect(tokenService.verify(t1)).toBeNull()
    expect(tokenService.verify(t2)).toBeNull()
    expect(tokenService.hasActiveToken('macbook')).toBe(false)
  })

  it('returns 200 with revoked:0 when the device has no active token (idempotent)', () => {
    seedDevice('macbook', 'macbook.local', 'CHILD', 2000)
    tokenService.issue('macbook')
    controller.handleRevoke(req({ id: 'macbook' }))

    const res = controller.handleRevoke(req({ id: 'macbook' }))
    expect(res.status).toBe(200)
    expect((res.body as DeviceRevokeResult).revoked).toBe(0)
  })

  it('returns 404 for an unknown device id', () => {
    const res = controller.handleRevoke(req({ id: 'ghost' }))
    expect(res.status).toBe(404)
    expect(res.body as { error: string }).toEqual({ error: 'device_not_found' })
  })
})

describe('DevicesController loopback gate (review #5+#7)', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.53',
    '::1',
    '::ffff:127.0.0.1',
  ])('handleList passes through for loopback remoteAddress %s', (address) => {
    seedDevice('macmini', 'macmini.local', 'HUB', 1000)
    const res = controller.handleList(req({}, address))
    expect(res.status).toBe(200)
  })

  it.each([
    '203.0.113.7',
    '10.0.0.4',
    '192.168.1.100',
    null,
  ])('handleList rejects non-loopback remoteAddress %s with 403', (address) => {
    seedDevice('macmini', 'macmini.local', 'HUB', 1000)
    const res = controller.handleList(req({}, address))
    expect(res.status).toBe(403)
    expect(res.body as { error: string }).toMatchObject({ error: 'loopback_required' })
  })

  it.each([
    '127.0.0.1',
    '127.0.0.53',
    '::1',
    '::ffff:127.0.0.1',
  ])('handleRevoke passes through for loopback remoteAddress %s', (address) => {
    seedDevice('macbook', 'macbook.local', 'CHILD', 2000)
    const res = controller.handleRevoke(req({ id: 'macbook' }, address))
    expect(res.status).toBe(200)
  })

  it.each([
    '203.0.113.7',
    '10.0.0.4',
    '192.168.1.100',
    null,
  ])('handleRevoke rejects non-loopback remoteAddress %s with 403 without revoking tokens', (address) => {
    seedDevice('macbook', 'macbook.local', 'CHILD', 2000)
    const t1 = tokenService.issue('macbook')
    const res = controller.handleRevoke(req({ id: 'macbook' }, address))
    expect(res.status).toBe(403)
    expect(res.body as { error: string }).toMatchObject({ error: 'loopback_required' })
    // Guard runs before revocation, so the existing token must still verify.
    expect(tokenService.verify(t1)?.id).toBe('macbook')
  })
})
