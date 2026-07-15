import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../db/database.js'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { EventRepository } from '../db/repositories/event-repository.js'
import { InstanceRepository } from '../db/repositories/instance-repository.js'
import { ProjectRepository } from '../db/repositories/project-repository.js'
import { SessionRepository } from '../db/repositories/session-repository.js'
import { toEpochMs, type EpochMs } from '../domain/time.js'
import type { RawEventPayload } from './dto.js'
import { EventIngestionService } from './event-ingestion-service.js'

const DEVICE_ID = 'macmini-1'

let db: Database
let devices: DeviceRepository
let projects: ProjectRepository
let instances: InstanceRepository
let sessions: SessionRepository
let events: EventRepository
let nowMs: number
let ingestion: EventIngestionService

/** テスト用の可制御クロック（received_at を決定的にするため）。 */
function clock(): EpochMs {
  return toEpochMs(nowMs)
}

/** FR-03 AC-3 相当: 認証済み device を先に登録しておく。 */
function seedHubDevice(): void {
  devices.upsert({
    id: DEVICE_ID,
    name: 'Mac mini',
    role: 'HUB',
    firstSeenAt: toEpochMs(1000),
    lastSeenAt: toEpochMs(1000),
  })
}

/** ペイロードの override（instance は部分指定を許す）。 */
type PayloadOverride = Partial<Omit<RawEventPayload, 'instance'>> & {
  instance?: Partial<RawEventPayload['instance']>
}

/** 既定値つきの正常ペイロードを組み立てる。 */
function payload(over: PayloadOverride = {}): RawEventPayload {
  const { instance, ...rest } = over
  return {
    device_id: DEVICE_ID,
    session_id: 'sess-1',
    instance: {
      remote_url: 'git@github.com:sumihiro/monomi.git',
      path: '/Users/sumihiro/dev/monomi',
      branch: 'main',
      is_git_repo: true,
      ...instance,
    },
    event_type: 'PostToolUse',
    event_subtype: null,
    tool_name: null,
    tool_summary: null,
    occurred_at: '2026-07-01T05:12:03Z',
    ...rest,
  }
}

beforeEach(() => {
  db = openDatabase(':memory:')
  devices = new DeviceRepository(db)
  projects = new ProjectRepository(db)
  instances = new InstanceRepository(db)
  sessions = new SessionRepository(db)
  events = new EventRepository(db)
  nowMs = 2_000_000
  ingestion = new EventIngestionService(devices, projects, instances, sessions, events, clock)
  seedHubDevice()
})

describe('EventIngestionService.ingest — normalization idempotency (§0.1 / FR-03 AC-2)', () => {
  it('collapses SSH and HTTPS forms of the same repo into a single projects row', () => {
    const ssh = ingestion.ingest(
      payload({ instance: { remote_url: 'git@github.com:sumihiro/monomi.git' } })
    )
    nowMs += 1000
    const https = ingestion.ingest(
      payload({ instance: { remote_url: 'https://github.com/sumihiro/monomi.git' } })
    )

    expect(https.projectId).toBe(ssh.projectId)
    expect(https.projectKey.value).toBe('github.com/sumihiro/monomi')
    const projectCount = db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }
    expect(projectCount.c).toBe(1)
    // Same device+path → one instance too.
    const instanceCount = db.prepare('SELECT COUNT(*) c FROM instances').get() as { c: number }
    expect(instanceCount.c).toBe(1)
  })

  it('produces a nogit: key when is_git_repo is false and a local: key when git has no remote', () => {
    const nogit = ingestion.ingest(
      payload({
        instance: { remote_url: null, path: '/tmp/scratch', branch: null, is_git_repo: false },
      })
    )
    const local = ingestion.ingest(
      payload({
        session_id: 'sess-2',
        instance: {
          remote_url: null,
          path: '/Users/sumihiro/dev/local-repo',
          branch: 'main',
          is_git_repo: true,
        },
      })
    )

    expect(nogit.projectKey.kind).toBe('NO_GIT')
    expect(nogit.projectKey.value).toBe(`nogit:${DEVICE_ID}:/tmp/scratch`)
    expect(local.projectKey.kind).toBe('LOCAL_NO_REMOTE')
    expect(local.projectKey.value).toBe(`local:${DEVICE_ID}:/Users/sumihiro/dev/local-repo`)
  })
})

describe('EventIngestionService.ingest — event storage (§0.5 / FR-01)', () => {
  it('stamps received_at from the hub clock, independent of occurred_at', () => {
    nowMs = 5_555_000
    const { event } = ingestion.ingest(payload({ occurred_at: '2020-01-01T00:00:00Z' }))

    expect(event.receivedAt).toBe(5_555_000)
    expect(event.occurredAt).toBe(Date.parse('2020-01-01T00:00:00Z'))
    expect(event.receivedAt).not.toBe(event.occurredAt)
  })

  it('records a permission_prompt Notification with its event_subtype', () => {
    const { event } = ingestion.ingest(
      payload({ event_type: 'Notification', event_subtype: 'permission_prompt' })
    )
    expect(event.eventType).toBe('Notification')
    expect(event.eventSubtype).toBe('permission_prompt')
  })

  it('records an idle_prompt Notification and a Stop event', () => {
    const idle = ingestion.ingest(
      payload({ event_type: 'Notification', event_subtype: 'idle_prompt' })
    )
    nowMs += 1000
    const stop = ingestion.ingest(payload({ event_type: 'Stop' }))

    expect(idle.event.eventSubtype).toBe('idle_prompt')
    expect(stop.event.eventType).toBe('Stop')
    const count = db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }
    expect(count.c).toBe(2)
  })

  it('marks the session ended on SessionEnd, using event_subtype as the reason', () => {
    ingestion.ingest(payload({ event_type: 'SessionStart' }))
    nowMs += 1000
    ingestion.ingest(payload({ event_type: 'SessionEnd', event_subtype: 'clear' }))

    const s = sessions.findById('sess-1')
    expect(s?.endReason).toBe('clear')
    expect(s?.endedAt).toBe(Date.parse('2026-07-01T05:12:03Z'))
  })

  it('touches the device last_seen_at to received_at while preserving first_seen_at', () => {
    nowMs = 9_000_000
    ingestion.ingest(payload())
    const d = devices.findById(DEVICE_ID)
    expect(d?.firstSeenAt).toBe(1000) // preserved
    expect(d?.lastSeenAt).toBe(9_000_000) // touched to received_at
  })
})

describe('EventIngestionService.ingest — terminal capture (release-23 FR-02c / FR-02 AC-1 / AC-5)', () => {
  it('updates the session terminal snapshot when payload.terminal is present', () => {
    nowMs = 3_000_000
    ingestion.ingest(
      payload({
        terminal: {
          tty: '/dev/ttys003',
          term_program: 'Apple_Terminal',
          tmux_pane: null,
          tmux_socket: null,
          wsl_distro: null,
          wt_session: null,
        },
      })
    )

    const s = sessions.findById('sess-1')
    expect(s?.terminal).toEqual({
      tty: '/dev/ttys003',
      termProgram: 'Apple_Terminal',
      tmuxPane: null,
      tmuxSocket: null,
      wslDistro: null,
      wtSession: null,
      seenAt: 3_000_000,
    })
  })

  it('keeps the existing terminal snapshot when a later payload omits the terminal key (old reporter compat, AC-1/AC-5)', () => {
    nowMs = 3_000_000
    ingestion.ingest(
      payload({
        terminal: {
          tty: '/dev/ttys003',
          term_program: 'Apple_Terminal',
          tmux_pane: null,
          tmux_socket: null,
          wsl_distro: null,
          wt_session: null,
        },
      })
    )

    nowMs = 4_000_000
    // 旧 reporter 相当（terminal キー自体が無い）ペイロード。2xx 相当で受理され続ける（AC-1）
    // うえ、既存のターミナルスナップショットを NULL 上書きしない（AC-5）。
    expect(() => ingestion.ingest(payload({ event_type: 'PreToolUse' }))).not.toThrow()

    const s = sessions.findById('sess-1')
    expect(s?.terminal).toEqual({
      tty: '/dev/ttys003',
      termProgram: 'Apple_Terminal',
      tmuxPane: null,
      tmuxSocket: null,
      wslDistro: null,
      wtSession: null,
      seenAt: 3_000_000,
    })
  })

  it('adopts an explicit null-tty snapshot from a new reporter (AC-5: terminal object present but tty unresolved)', () => {
    nowMs = 3_000_000
    ingestion.ingest(
      payload({
        terminal: {
          tty: '/dev/ttys003',
          term_program: 'Apple_Terminal',
          tmux_pane: null,
          tmux_socket: null,
          wsl_distro: null,
          wt_session: null,
        },
      })
    )

    nowMs = 4_000_000
    ingestion.ingest(
      payload({
        event_type: 'PreToolUse',
        terminal: {
          tty: null,
          term_program: 'Apple_Terminal',
          tmux_pane: null,
          tmux_socket: null,
          wsl_distro: null,
          wt_session: null,
        },
      })
    )

    const s = sessions.findById('sess-1')
    expect(s?.terminal).toEqual({
      tty: null,
      termProgram: 'Apple_Terminal',
      tmuxPane: null,
      tmuxSocket: null,
      wslDistro: null,
      wtSession: null,
      seenAt: 4_000_000,
    })
  })

  it('leaves the session terminal as null when no reporter has ever sent terminal info', () => {
    ingestion.ingest(payload())
    const s = sessions.findById('sess-1')
    expect(s?.terminal).toBeNull()
  })
})

describe('EventIngestionService.ingest — validation & invariants', () => {
  it('rejects a payload missing required fields (zod)', () => {
    expect(() => ingestion.ingest({ device_id: DEVICE_ID })).toThrow()
  })

  it('rejects an unknown event_type', () => {
    expect(() => ingestion.ingest(payload({ event_type: 'Nope' as never }))).toThrow()
  })

  it('rejects a non-ISO8601 occurred_at', () => {
    expect(() => ingestion.ingest(payload({ occurred_at: 'yesterday' }))).toThrow()
  })

  it('throws when the device_id is not registered (§0.3 auth invariant)', () => {
    expect(() => ingestion.ingest(payload({ device_id: 'ghost' }))).toThrow(/unknown device_id/)
  })
})
