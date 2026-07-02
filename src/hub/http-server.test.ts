import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type MonomiPaths, resolvePaths } from '../config/paths.js'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { TokenRepository } from '../db/repositories/token-repository.js'
import { type EpochMs, toEpochMs } from '../domain/time.js'
import type { AuthResolver } from './auth-resolver.js'
import type { InstanceDetail, InstanceStatusRow } from './dto.js'
import { HttpServer } from './http-server.js'
import { Router } from './router.js'
import { type HubHandle, serve } from './serve.js'
import { TokenService } from './token-service.js'

/**
 * HttpServer の E2E テスト（FR-03 AC-1/AC-5）。
 *
 * `serve()` エントリを port 0（エフェメラル）で起動し、実 DB 初期化 + bootstrap +
 * DI 配線 + node:http を通した本物の HTTP 往復で検証する。認証・境界での時刻変換
 * （wire ISO8601 ⇄ 内部 epoch ms、§0.5）・status 導出まで含めて確認する。
 */

const HOSTNAME = 'macmini.local'

/** bootstrap が起動時に採取する時刻。以降の POST/GET で可制御クロックへ差し替える。 */
const BOOT_MS = 1_700_000_000_000

let tmpDir: string
let paths: MonomiPaths
let hub: HubHandle
let token: string
/** 可制御クロック（received_at と status 導出の now を決定的にする）。 */
let nowMs: number

function clock(): EpochMs {
  return toEpochMs(nowMs)
}

function url(pathname: string): string {
  return `http://127.0.0.1:${hub.port}${pathname}`
}

/** 有効/無効トークンを任意に付けて POST する（body が string ならそのまま送る）。 */
function post(pathname: string, body: unknown, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bearer !== undefined) {
    headers.authorization = `Bearer ${bearer}`
  }
  return fetch(url(pathname), {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** 有効/無効トークンを任意に付けて GET する。 */
function get(pathname: string, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (bearer !== undefined) {
    headers.authorization = `Bearer ${bearer}`
  }
  return fetch(url(pathname), { headers })
}

/** device_id を持たない正常イベント body（§0.3: device_id は Controller が権威充填する）。 */
function eventBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    instance: {
      remote_url: 'git@github.com:sumihiro/monomi.git',
      path: '/Users/sumihiro/dev/monomi',
      branch: 'feature/ai-sidecar',
      is_git_repo: true,
    },
    event_type: 'PostToolUse',
    event_subtype: null,
    tool_name: null,
    tool_summary: null,
    occurred_at: new Date(nowMs).toISOString(),
    ...over,
  }
}

function eventCount(): number {
  return (hub.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-http-'))
  paths = resolvePaths(tmpDir)
  nowMs = BOOT_MS
  hub = await serve({ paths, port: 0, hostname: HOSTNAME, now: clock, logger: () => {} })
  token = hub.rawToken
})

afterEach(async () => {
  await hub.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('serve() bootstrap wiring', () => {
  it('binds an ephemeral loopback port and provisions a device + token', () => {
    expect(hub.port).toBeGreaterThan(0)
    expect(hub.deviceId).toBe('macmini')
    expect(token.length).toBeGreaterThan(0)
    // bootstrap only provisions device/token; no events yet.
    expect(eventCount()).toBe(0)
  })
})

describe('bind resolution (FR-06 AC-1)', () => {
  it('binds 0.0.0.0 by default when no host option and no config `bind:` are given', () => {
    expect(hub.server.address()?.address).toBe('0.0.0.0')
  })

  it('config `bind:` overrides the 0.0.0.0 default', async () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-http-bind-'))
    const overridePaths = resolvePaths(overrideDir)
    fs.mkdirSync(overridePaths.home, { recursive: true })
    fs.writeFileSync(overridePaths.configFile, 'bind: 127.0.0.1\n')

    const overrideHub = await serve({
      paths: overridePaths,
      port: 0,
      hostname: 'macbook.local',
      logger: () => {},
    })
    try {
      expect(overrideHub.server.address()?.address).toBe('127.0.0.1')
    } finally {
      await overrideHub.close()
      fs.rmSync(overrideDir, { recursive: true, force: true })
    }
  })
})

describe('authentication gate (FR-03 AC-5)', () => {
  it('rejects POST /events without a token → 401 + WWW-Authenticate', async () => {
    const res = await post('/api/v1/events', eventBody())
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect((await res.json()) as { error: string }).toEqual({ error: 'unauthorized' })
    expect(eventCount()).toBe(0) // rejected before any write
  })

  it('rejects an invalid bearer token → 401', async () => {
    const res = await post('/api/v1/events', eventBody(), 'not-a-real-token')
    expect(res.status).toBe(401)
    expect(eventCount()).toBe(0)
  })

  it('gates GET /instances behind auth too → 401', async () => {
    const res = await get('/api/v1/instances')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/events (FR-03 AC-1)', () => {
  it('accepts a valid event with a bearer token → 201 and stores exactly one row', async () => {
    const res = await post('/api/v1/events', eventBody(), token)
    expect(res.status).toBe(201)

    const ack = (await res.json()) as {
      ok: boolean
      event_id: number
      instance_id: string
      project_id: string
    }
    expect(ack.ok).toBe(true)
    expect(typeof ack.event_id).toBe('number')
    expect(ack.instance_id.length).toBeGreaterThan(0)
    expect(ack.project_id.length).toBeGreaterThan(0)

    expect(eventCount()).toBe(1)
  })

  it('ignores a spoofed body device_id and attributes the event to the authed device (§0.3)', async () => {
    await post('/api/v1/events', eventBody({ device_id: 'attacker-device' }), token)

    const res = await get('/api/v1/instances', token)
    const body = (await res.json()) as { instances: InstanceStatusRow[] }
    expect(body.instances).toHaveLength(1)
    expect(body.instances[0].device.id).toBe(hub.deviceId)
  })

  it('rejects a malformed payload with 400 invalid_payload', async () => {
    const res = await post('/api/v1/events', {}, token)
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_payload' })
    expect(eventCount()).toBe(0)
  })

  it('rejects a non-JSON body with 400 invalid_json', async () => {
    const res = await post('/api/v1/events', 'this is not json', token)
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_json' })
  })
})

describe('GET /api/v1/instances (FR-03 AC-1 / FR-04 derived status)', () => {
  it('returns instances with a derived approval_wait status and ISO8601 generated_at', async () => {
    // active at T0, then a permission_prompt at T1; query 720s later at T2.
    const t0 = BOOT_MS
    const t1 = BOOT_MS + 60_000
    const t2 = t1 + 720_000

    nowMs = t0
    await post('/api/v1/events', eventBody({ event_type: 'SessionStart' }), token)
    nowMs = t1
    await post(
      '/api/v1/events',
      eventBody({ event_type: 'Notification', event_subtype: 'permission_prompt' }),
      token
    )

    nowMs = t2
    const res = await get('/api/v1/instances', token)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { generated_at: string; instances: InstanceStatusRow[] }
    expect(body.generated_at).toBe(new Date(t2).toISOString())
    expect(body.instances).toHaveLength(1)

    const row = body.instances[0]
    expect(row.status.display).toBe('approval_wait')
    expect(row.status.raw_state).toBe('approval_wait')
    expect(row.status.priority).toBe(4)
    expect(row.status.elapsed_seconds).toBe(720) // received_at-based, §0.5
    expect(row.status.is_stale).toBe(false)
    expect(row.pr.state).toBe('none') // poller unimplemented in release-1
    expect(row.project.name).toBe('monomi') // display_name derived from project_key
    expect(row.device.id).toBe(hub.deviceId)
    expect(row.branch).toBe('feature/ai-sidecar')
  })
})

describe('GET /api/v1/instances/:id (§8.2 / §10.4)', () => {
  it('returns the detail with recent_events newest-first and ISO8601 received_at', async () => {
    const t0 = BOOT_MS
    const t1 = BOOT_MS + 60_000

    nowMs = t0
    await post('/api/v1/events', eventBody({ event_type: 'SessionStart' }), token)
    nowMs = t1
    await post(
      '/api/v1/events',
      eventBody({ event_type: 'Notification', event_subtype: 'permission_prompt' }),
      token
    )

    const list = (await (await get('/api/v1/instances', token)).json()) as {
      instances: InstanceStatusRow[]
    }
    const instanceId = list.instances[0].instance_id

    const res = await get(`/api/v1/instances/${instanceId}`, token)
    expect(res.status).toBe(200)

    const detail = (await res.json()) as InstanceDetail
    expect(detail.instance_id).toBe(instanceId)
    expect(detail.recent_events).toHaveLength(2)
    // Newest-first by occurred_at.
    expect(detail.recent_events[0].event_type).toBe('Notification')
    expect(detail.recent_events[0].event_subtype).toBe('permission_prompt')
    expect(detail.recent_events[1].event_type).toBe('SessionStart')
    // received_at is stamped by the hub clock and emitted as ISO8601 (§0.5).
    expect(detail.recent_events[0].received_at).toBe(new Date(t1).toISOString())
    // FR-09 L2: each event carries a distinct id (events.id) over the wire for CLI React keys.
    expect(typeof detail.recent_events[0].id).toBe('number')
    expect(detail.recent_events[0].id).not.toBe(detail.recent_events[1].id)
  })

  it('returns 404 for an unknown instance id', async () => {
    const res = await get('/api/v1/instances/inst_missing', token)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toEqual({ error: 'instance_not_found' })
  })
})

describe('cross-device visibility (FR-06 AC-2 / AC-3)', () => {
  /**
   * 別デバイスを DB に直接登録しトークンを発行する（実際の pair フローは FR-02 の範囲）。
   *
   * @param deviceId 発行先 device の id。
   * @param name device 表示名。
   * @returns 発行した生トークン。
   */
  function issueDeviceToken(deviceId: string, name: string): string {
    const deviceRepo = new DeviceRepository(hub.db)
    const tokenRepo = new TokenRepository(hub.db)
    const tokenService = new TokenService(tokenRepo, deviceRepo)
    deviceRepo.upsert({
      id: deviceId,
      name,
      role: 'CHILD',
      firstSeenAt: clock(),
      lastSeenAt: clock(),
    })
    return tokenService.issue(deviceId)
  }

  it("lets any other device's valid token view this device's instance/events (仕様固定 S2)", async () => {
    const otherDeviceToken = issueDeviceToken('macbook', 'macbook.local')

    await post('/api/v1/events', eventBody({ event_type: 'SessionStart' }), token)

    // No ownership check: device B's token can list device A's instance (FR-06 AC-2).
    const listRes = await get('/api/v1/instances', otherDeviceToken)
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { instances: InstanceStatusRow[] }
    expect(list.instances).toHaveLength(1)
    expect(list.instances[0].device.id).toBe(hub.deviceId)

    const instanceId = list.instances[0].instance_id
    const detailRes = await get(`/api/v1/instances/${instanceId}`, otherDeviceToken)
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as InstanceDetail
    expect(detail.instance_id).toBe(instanceId)
    expect(detail.recent_events.length).toBeGreaterThan(0)
  })

  it('still rejects a revoked device token with 401 (FR-06 AC-3 regression)', async () => {
    const revokedDeviceToken = issueDeviceToken('ipad', 'ipad.local')

    const preRevoke = await get('/api/v1/instances', revokedDeviceToken)
    expect(preRevoke.status).toBe(200)

    const tokenRow = hub.db.prepare('SELECT id FROM tokens WHERE device_id = ?').get('ipad') as {
      id: number
    }
    new TokenService(new TokenRepository(hub.db), new DeviceRepository(hub.db)).revoke(tokenRow.id)

    const postRevoke = await get('/api/v1/instances', revokedDeviceToken)
    expect(postRevoke.status).toBe(401)
  })
})

describe('devices management (FR-03)', () => {
  /** 別デバイスを DB に直接登録しトークンを発行する（実 pair フローは FR-02 の範囲）。 */
  function issueDeviceToken(deviceId: string, name: string): string {
    const deviceRepo = new DeviceRepository(hub.db)
    const tokenRepo = new TokenRepository(hub.db)
    const tokenService = new TokenService(tokenRepo, deviceRepo)
    deviceRepo.upsert({
      id: deviceId,
      name,
      role: 'CHILD',
      firstSeenAt: clock(),
      lastSeenAt: clock(),
    })
    return tokenService.issue(deviceId)
  }

  it('GET /api/v1/devices lists registered devices with token status (AC-1)', async () => {
    issueDeviceToken('macbook', 'macbook.local')

    const res = await get('/api/v1/devices', token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      devices: { id: string; role: string; has_active_token: boolean; last_seen_at: string }[]
    }

    const ids = body.devices.map((d) => d.id)
    expect(ids).toContain(hub.deviceId) // the bootstrapped hub device
    expect(ids).toContain('macbook')

    const hubRow = body.devices.find((d) => d.id === hub.deviceId)
    expect(hubRow?.role).toBe('hub')
    expect(hubRow?.has_active_token).toBe(true)
    expect(hubRow?.last_seen_at).toBe(new Date(BOOT_MS).toISOString())
  })

  it('POST /api/v1/devices/:id/revoke revokes the device token, which then 401s (AC-2)', async () => {
    const childToken = issueDeviceToken('macbook', 'macbook.local')

    // Pre-revoke: the child token works.
    expect((await get('/api/v1/instances', childToken)).status).toBe(200)

    const revokeRes = await post('/api/v1/devices/macbook/revoke', undefined, token)
    expect(revokeRes.status).toBe(200)
    expect((await revokeRes.json()) as { ok: boolean; device_id: string; revoked: number }).toEqual(
      {
        ok: true,
        device_id: 'macbook',
        revoked: 1,
      }
    )

    // Post-revoke: the same token is now rejected (AC-2).
    const listRes = await get('/api/v1/devices', token)
    const list = (await listRes.json()) as { devices: { id: string; has_active_token: boolean }[] }
    expect(list.devices.find((d) => d.id === 'macbook')?.has_active_token).toBe(false)
    expect((await get('/api/v1/instances', childToken)).status).toBe(401)
  })

  it('gates GET /api/v1/devices behind auth → 401', async () => {
    expect((await get('/api/v1/devices')).status).toBe(401)
  })

  it('returns 404 when revoking an unknown device', async () => {
    const res = await post('/api/v1/devices/ghost/revoke', undefined, token)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toEqual({ error: 'device_not_found' })
  })
})

describe('pairing flow (§9 / FR-02)', () => {
  /** child が config へ保存する claim レスポンス。 */
  type ClaimBody = { token: string; device_id: string; role: string }

  /** loopback から pair/start を叩き、発行された 6 桁コードを返す。 */
  async function startPairing(): Promise<PairStartBody> {
    const res = await post('/api/v1/pair/start', {})
    expect(res.status).toBe(200)
    return (await res.json()) as PairStartBody
  }
  type PairStartBody = { code: string; expires_at: string; ttl_seconds: number }

  it('start (loopback, public) issues a 6-digit code + TTL; claim issues a working token and registers the child', async () => {
    const start = await startPairing()
    expect(start.code).toMatch(/^\d{6}$/)
    expect(start.ttl_seconds).toBe(300)
    expect(start.expires_at).toBe(new Date(BOOT_MS + 300_000).toISOString())

    // claim is public (no bearer) and returns token + assigned settings (FR-02 AC-3).
    const claimRes = await post('/api/v1/pair/claim', {
      code: start.code,
      device_id: 'macbook',
      name: 'macbook.local',
    })
    expect(claimRes.status).toBe(200)
    const claim = (await claimRes.json()) as ClaimBody
    expect(claim.device_id).toBe('macbook')
    expect(claim.role).toBe('child')
    expect(claim.token.length).toBeGreaterThan(0)

    // The freshly issued token authenticates against a normal read route.
    expect((await get('/api/v1/instances', claim.token)).status).toBe(200)

    // The child now appears in the devices list as a child device.
    const devicesRes = await get('/api/v1/devices', token)
    const list = (await devicesRes.json()) as { devices: { id: string; role: string }[] }
    expect(list.devices.find((d) => d.id === 'macbook')?.role).toBe('child')
  })

  it('is single-use: a claimed code cannot be reused (§0.3)', async () => {
    const start = await startPairing()
    const claim = { code: start.code, device_id: 'macbook', name: 'macbook.local' }
    expect((await post('/api/v1/pair/claim', claim)).status).toBe(200)

    const again = await post('/api/v1/pair/claim', claim)
    expect(again.status).toBe(400)
    expect((await again.json()) as { error: string }).toMatchObject({ error: 'invalid_code' })
  })

  it('rejects a wrong code and invalidates the code after 5 failures (§0.3 / FR-02 AC-4)', async () => {
    const start = await startPairing()
    const wrong = start.code === '000000' ? '111111' : '000000'

    for (let i = 0; i < 5; i++) {
      const res = await post('/api/v1/pair/claim', { code: wrong, device_id: 'x', name: 'x' })
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_code' })
    }
    // The correct code is now invalidated by too many attempts.
    const res = await post('/api/v1/pair/claim', {
      code: start.code,
      device_id: 'macbook',
      name: 'macbook.local',
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_code' })
  })

  it('returns code_expired once the TTL elapses (§9 / FR-02 AC-5)', async () => {
    const start = await startPairing()
    nowMs = BOOT_MS + 300_000 // advance the shared clock to the expiry boundary
    const res = await post('/api/v1/pair/claim', {
      code: start.code,
      device_id: 'macbook',
      name: 'macbook.local',
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'code_expired' })
  })

  it('rejects taking over an existing device that still holds an active token with 409 (#8)', async () => {
    // First pairing: macbook is registered and gets an active token.
    const first = await startPairing()
    expect(
      (
        await post('/api/v1/pair/claim', {
          code: first.code,
          device_id: 'macbook',
          name: 'macbook.local',
        })
      ).status
    ).toBe(200)

    // A second, fresh code cannot re-register the same device_id while its token is active.
    const second = await startPairing()
    const res = await post('/api/v1/pair/claim', {
      code: second.code,
      device_id: 'macbook',
      name: 'attacker.local',
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('device_conflict')
    expect(body.message).toContain('monomi hub devices revoke macbook')
  })

  it('allows re-pairing a device_id after its token is revoked, reusing the in-flight code (#8)', async () => {
    const first = await startPairing()
    expect(
      (
        await post('/api/v1/pair/claim', {
          code: first.code,
          device_id: 'macbook',
          name: 'macbook.local',
        })
      ).status
    ).toBe(200)

    // Conflict while the token is active (code is NOT consumed by the 409).
    const second = await startPairing()
    expect(
      (
        await post('/api/v1/pair/claim', {
          code: second.code,
          device_id: 'macbook',
          name: 'macbook.local',
        })
      ).status
    ).toBe(409)

    // Hub admin revokes macbook, then the SAME code completes the pairing.
    expect((await post('/api/v1/devices/macbook/revoke', undefined, token)).status).toBe(200)

    const reclaimRes = await post('/api/v1/pair/claim', {
      code: second.code,
      device_id: 'macbook',
      name: 'macbook.local',
    })
    expect(reclaimRes.status).toBe(200)
    const claim = (await reclaimRes.json()) as ClaimBody
    expect(claim.device_id).toBe('macbook')
    // The re-issued token authenticates against a normal read route.
    expect((await get('/api/v1/instances', claim.token)).status).toBe(200)
  })

  it('rejects a malformed claim payload with 400 invalid_payload', async () => {
    const res = await post('/api/v1/pair/claim', { device_id: 'macbook' })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_payload' })
  })

  it('rejects a claim with an overlong device_id with 400 invalid_payload (#9)', async () => {
    const start = await startPairing()
    const res = await post('/api/v1/pair/claim', {
      code: start.code,
      device_id: 'a'.repeat(65),
      name: 'macbook.local',
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_payload' })
  })

  it('rejects a claim with a device_id containing disallowed characters with 400 invalid_payload (#9)', async () => {
    const start = await startPairing()
    const res = await post('/api/v1/pair/claim', {
      code: start.code,
      device_id: '../etc/passwd',
      name: 'macbook.local',
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_payload' })
  })

  it('rejects a claim with an overlong name with 400 invalid_payload (#9)', async () => {
    const start = await startPairing()
    const res = await post('/api/v1/pair/claim', {
      code: start.code,
      device_id: 'macbook',
      name: 'a'.repeat(129),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_payload' })
  })
})

describe('routing', () => {
  it('returns 404 for an unknown route', async () => {
    const res = await get('/api/v1/nope', token)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' })
  })

  it('returns 405 when the method is wrong for a known path', async () => {
    const res = await get('/api/v1/events', token)
    expect(res.status).toBe(405)
    expect((await res.json()) as { error: string }).toEqual({ error: 'method_not_allowed' })
  })

  it('GET /api/v1/instances/%ZZ → 404 (invalid percent-encoding does not 500)', async () => {
    const res = await get('/api/v1/instances/%ZZ', token)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' })
  })
})

/**
 * public ルート（認証スキップ）と生リクエスト文脈注入の単体テスト（§0.3 / FR-02 の前提）。
 *
 * FR-02 の pair/start（loopback のみ・未認証）/ pair/claim（未認証）を通せるようにする
 * パイプライン改修の検証。`createHubServer` はまだ public ルートを登録しないため、ダミーの
 * public ルートを持つ {@link HttpServer} を直接組んで、認証迂回・device: null・
 * `socket.remoteAddress` 注入・X-Forwarded-For 無視を実 HTTP 往復で確認する。
 */
describe('public routes bypass auth + raw request context (§0.3 / FR-02)', () => {
  let server: HttpServer | undefined

  afterEach(async () => {
    if (server !== undefined) {
      await server.close()
      server = undefined
    }
  })

  /** 呼ばれたら失敗する AuthResolver スタブ（public ルートで認証が走らないことを立証する）。 */
  function throwingAuth(): AuthResolver {
    return {
      resolveDevice(): never {
        throw new Error('auth must be skipped for public routes')
      },
    } as unknown as AuthResolver
  }

  it('reaches a public GET route unauthenticated, with device null and loopback remoteAddress', async () => {
    const router = new Router().add(
      'GET',
      '/api/v1/pair/probe',
      (req) => ({ status: 200, body: { device: req.device, remoteAddress: req.remoteAddress } }),
      { public: true }
    )
    server = new HttpServer(router, throwingAuth())
    const port = await server.listen(0, '127.0.0.1')

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/pair/probe`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: unknown; remoteAddress: string }
    expect(body.device).toBeNull()
    expect(body.remoteAddress).toContain('127.0.0.1')
  })

  it('injects socket remoteAddress and ignores X-Forwarded-For on a public POST route (§0.3)', async () => {
    const router = new Router().add(
      'POST',
      '/api/v1/pair/claim',
      (req) => ({ status: 200, body: { remoteAddress: req.remoteAddress, echo: req.body } }),
      { public: true }
    )
    server = new HttpServer(router, throwingAuth())
    const port = await server.listen(0, '127.0.0.1')

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ code: '123456' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { remoteAddress: string; echo: { code: string } }
    expect(body.remoteAddress).toContain('127.0.0.1')
    expect(body.remoteAddress).not.toContain('203.0.113.7')
    // public ルートでもボディ JSON パースは通り、Controller へ渡る。
    expect(body.echo).toEqual({ code: '123456' })
  })

  it('still auth-gates a non-public route on the same server (401), while the public route is open', async () => {
    let resolveCalls = 0
    const auth = {
      resolveDevice(): null {
        resolveCalls++
        return null
      },
    } as unknown as AuthResolver
    const router = new Router()
      .add('GET', '/api/v1/authed', () => ({ status: 200, body: { ok: true } }))
      .add('GET', '/api/v1/open', () => ({ status: 200, body: { ok: true } }), { public: true })
    server = new HttpServer(router, auth)
    const port = await server.listen(0, '127.0.0.1')

    // public ルート: 認証は走らず到達する。
    const openRes = await fetch(`http://127.0.0.1:${port}/api/v1/open`)
    expect(openRes.status).toBe(200)
    expect(resolveCalls).toBe(0)

    // 認証必須ルート: resolveDevice が走り null → 401（既存挙動は不変）。
    const authedRes = await fetch(`http://127.0.0.1:${port}/api/v1/authed`)
    expect(authedRes.status).toBe(401)
    expect(authedRes.headers.get('www-authenticate')).toBe('Bearer')
    expect(resolveCalls).toBe(1)
  })
})
