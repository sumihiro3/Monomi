import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePaths, type MonomiPaths } from '../config/paths.js'
import { toEpochMs, type EpochMs } from '../domain/time.js'
import type { InstanceDetail, InstanceStatusRow } from './dto.js'
import { serve, type HubHandle } from './serve.js'

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
  })

  it('returns 404 for an unknown instance id', async () => {
    const res = await get('/api/v1/instances/inst_missing', token)
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toEqual({ error: 'instance_not_found' })
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
})
