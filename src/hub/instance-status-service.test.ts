import { beforeEach, describe, expect, it } from 'vitest'
import { type Database, openDatabase } from '../db/database.js'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { EventRepository } from '../db/repositories/event-repository.js'
import { InstanceRepository } from '../db/repositories/instance-repository.js'
import { PrStatusRepository } from '../db/repositories/pr-status-repository.js'
import { ProjectRepository } from '../db/repositories/project-repository.js'
import { SessionRepository } from '../db/repositories/session-repository.js'
import { type EpochMs, toDurationMs, toEpochMs } from '../domain/time.js'
import { EscalationThresholds } from '../status/escalation.js'
import type { RawEventPayload } from './dto.js'
import { EventIngestionService } from './event-ingestion-service.js'
import { InstanceStatusService } from './instance-status-service.js'

const DEVICE_ID = 'macmini-1'
const HOUR_MS = 3_600_000

let db: Database
let devices: DeviceRepository
let projects: ProjectRepository
let instances: InstanceRepository
let sessions: SessionRepository
let events: EventRepository
let prStatus: PrStatusRepository
let nowMs: number
let ingestion: EventIngestionService
let statusService: InstanceStatusService

function clock(): EpochMs {
  return toEpochMs(nowMs)
}

/** received_at = `at` になるようクロックを合わせて 1 イベントを ingest する。 */
function ingestAt(at: number, over: Partial<Omit<RawEventPayload, 'instance'>> = {}): void {
  nowMs = at
  ingestion.ingest({
    device_id: DEVICE_ID,
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
    occurred_at: new Date(at).toISOString(),
    ...over,
  })
}

beforeEach(() => {
  db = openDatabase(':memory:')
  devices = new DeviceRepository(db)
  projects = new ProjectRepository(db)
  instances = new InstanceRepository(db)
  sessions = new SessionRepository(db)
  events = new EventRepository(db)
  prStatus = new PrStatusRepository(db)
  nowMs = 0
  ingestion = new EventIngestionService(devices, projects, instances, sessions, events, clock)
  statusService = new InstanceStatusService(
    instances,
    sessions,
    events,
    projects,
    devices,
    prStatus
  )
  devices.upsert({
    id: DEVICE_ID,
    name: 'Mac mini',
    role: 'HUB',
    firstSeenAt: toEpochMs(1000),
    lastSeenAt: toEpochMs(1000),
  })
})

describe('InstanceStatusService.listInstances — derived status (FR-04 / §8.2)', () => {
  it('derives approval_wait with numeric priority and elapsed seconds', () => {
    ingestAt(1_000_000, { event_type: 'SessionStart' })
    ingestAt(2_000_000, { event_type: 'Notification', event_subtype: 'permission_prompt' })

    const rows = statusService.listInstances(toEpochMs(2_000_000 + 720_000))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.status.display).toBe('approval_wait')
    expect(row.status.raw_state).toBe('approval_wait')
    expect(row.status.priority).toBe(4)
    expect(row.status.elapsed_seconds).toBe(720)
    expect(row.status.is_stale).toBe(false)
    expect(row.pr.state).toBe('none')
    expect(row.project.name).toBe('monomi') // display_name auto-generated from project_key
    expect(row.device.name).toBe('Mac mini')
    expect(row.branch).toBe('feature/ai-sidecar')
    expect(row.session.last_heartbeat_at).toBeNull()
  })

  it('derives next_wait from an idle_prompt Notification', () => {
    ingestAt(1_000_000, { event_type: 'Notification', event_subtype: 'idle_prompt' })
    const rows = statusService.listInstances(toEpochMs(1_500_000))
    expect(rows[0].status.display).toBe('next_wait')
    expect(rows[0].status.priority).toBe(2)
  })

  it('escalates active to stale after the 2h threshold', () => {
    ingestAt(1_000_000, { event_type: 'PostToolUse' })
    const belowThreshold = statusService.listInstances(toEpochMs(1_000_000 + HOUR_MS))
    expect(belowThreshold[0].status.display).toBe('active')
    expect(belowThreshold[0].status.is_stale).toBe(false)

    const overThreshold = statusService.listInstances(toEpochMs(1_000_000 + 2 * HOUR_MS + 1000))
    expect(overThreshold[0].status.display).toBe('stale')
    expect(overThreshold[0].status.is_stale).toBe(true)
    expect(overThreshold[0].status.priority).toBe(5)
    expect(overThreshold[0].status.raw_state).toBe('active') // raw_state preserved under stale
  })

  it('finds the true run start across multiple event pages, not just recent events (perf review #high fix)', () => {
    // 250 ACTIVE events (> STATUS_EVENT_PAGE_SIZE=200), so status derivation must page
    // backward across a page boundary to find the true start of the run. The bulk of the
    // events are clustered tightly just before `now`; a naive "only look at the most
    // recent N events" fix would anchor transitionedAt near `now` and understate elapsed
    // time, silently missing the stale escalation this test asserts.
    const TOTAL_EVENTS = 250
    const trueStart = 1_000_000
    ingestAt(trueStart, { event_type: 'SessionStart' })
    for (let i = 1; i < TOTAL_EVENTS; i++) {
      ingestAt(trueStart + 3 * HOUR_MS + i, { event_type: 'PostToolUse' })
    }
    const lastEventAt = trueStart + 3 * HOUR_MS + (TOTAL_EVENTS - 1)
    const now = lastEventAt + 1000

    const rows = statusService.listInstances(toEpochMs(now))
    expect(rows).toHaveLength(1)
    // True elapsed since trueStart (~3h) exceeds the 2h active threshold => stale.
    // A page-truncated implementation would see only clustered recent events and
    // wrongly report 'active'.
    expect(rows[0].status.display).toBe('stale')
    expect(rows[0].status.raw_state).toBe('active')
  })

  it('does not let a closed session hide an active one within the same instance (§0.5)', () => {
    // Session A ends (closed); session B stays active — both on the same instance/path.
    nowMs = 1_000_000
    ingestion.ingest(baseEvent({ session_id: 'sess-A', event_type: 'SessionStart', at: 1_000_000 }))
    nowMs = 1_100_000
    ingestion.ingest(baseEvent({ session_id: 'sess-A', event_type: 'SessionEnd', at: 1_100_000 }))
    nowMs = 1_200_000
    ingestion.ingest(baseEvent({ session_id: 'sess-B', event_type: 'PostToolUse', at: 1_200_000 }))

    const rows = statusService.listInstances(toEpochMs(1_300_000))
    expect(rows).toHaveLength(1)
    expect(rows[0].status.display).toBe('active')
    expect(rows[0].session.id).toBe('sess-B') // representative is the active session
  })

  it('does not let an orphaned next_wait session mask a currently active one (release-7 FR-01 AC-4, OSSRadar case)', () => {
    // Session A goes idle (next_wait) 20 minutes ago and never sends SessionEnd — an orphaned
    // session left behind by e.g. a crashed/killed Claude Code process. Session B is actively
    // working right now, on the same instance/path. Pre-FR-01, A's higher raw priority
    // (next_wait=2 > active=1) would win the rollup and hide B's active status — this is the
    // B7 regression this test guards against.
    const now = 2_000_000
    nowMs = 100_000
    ingestion.ingest(baseEvent({ session_id: 'sess-A', event_type: 'SessionStart', at: 100_000 }))
    nowMs = now - 20 * 60_000
    ingestion.ingest({
      ...baseEvent({ session_id: 'sess-A', event_type: 'Notification', at: now - 20 * 60_000 }),
      event_subtype: 'idle_prompt',
    })
    nowMs = now - 3_000
    ingestion.ingest(
      baseEvent({ session_id: 'sess-B', event_type: 'PostToolUse', at: now - 3_000 })
    )

    const rows = statusService.listInstances(toEpochMs(now))
    expect(rows).toHaveLength(1)
    expect(rows[0].status.display).toBe('active')
    expect(rows[0].session.id).toBe('sess-B')
  })

  it('does not let a zero-event session masquerade as freshest and mask a live one (release-8 review-changes regression)', () => {
    // sess-A simulates a crash between sessions.upsertStarted() and events.append() (a session
    // row with zero events ever recorded). Session B is genuinely active right now, on the same
    // instance. Pre-fix, buildRow() used `now` (the query-time clock) as A's lastEventAt
    // fallback; under release-8's recency-first rollup, `now` always out-recencies any real
    // event timestamp, so A's zero-event ACTIVE would win and mask B forever. The fix uses
    // session.startedAt (a fixed past timestamp) instead, so B correctly wins on recency.
    const now = 2_000_000
    nowMs = now - 3_000
    ingestion.ingest(
      baseEvent({ session_id: 'sess-B', event_type: 'PostToolUse', at: now - 3_000 })
    )

    const instanceId = instances.listActive()[0].id
    sessions.upsertStarted(instanceId, 'sess-A-crashed', toEpochMs(now - 60_000))

    const rows = statusService.listInstances(toEpochMs(now))
    expect(rows).toHaveLength(1)
    expect(rows[0].status.display).toBe('active')
    expect(rows[0].session.id).toBe('sess-B')
  })
})

describe('InstanceStatusService.getInstanceDetail — Agent View Lv.1 (§8.2 / §10.4)', () => {
  it('returns recent_events newest-first plus the derived status', () => {
    ingestAt(1_000_000, { event_type: 'SessionStart' })
    ingestAt(2_000_000, {
      event_type: 'PostToolUse',
      tool_name: 'Bash',
      tool_summary: 'npm install',
    })
    ingestAt(3_000_000, { event_type: 'Notification', event_subtype: 'permission_prompt' })

    const instanceId = instances.listActive()[0].id
    const detail = statusService.getInstanceDetail(instanceId, toEpochMs(3_600_000))

    expect(detail).not.toBeNull()
    expect(detail!.status.display).toBe('approval_wait')
    expect(detail!.recent_events).toHaveLength(3)
    // Newest-first by occurred_at.
    expect(detail!.recent_events[0].event_type).toBe('Notification')
    expect(detail!.recent_events[0].event_subtype).toBe('permission_prompt')
    expect(detail!.recent_events[1].event_type).toBe('PostToolUse')
    expect(detail!.recent_events[1].tool_name).toBe('Bash')
    expect(detail!.recent_events[1].tool_summary).toBe('npm install')
    expect(detail!.recent_events[2].event_type).toBe('SessionStart')
    // received_at is emitted as ISO8601 (§0.5 wire format).
    expect(detail!.recent_events[0].received_at).toBe(new Date(3_000_000).toISOString())
    // FR-09 L2: each event carries a stable, distinct id (events.id) for CLI React keys.
    const ids = detail!.recent_events.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Insertion order was SessionStart, PostToolUse, Notification, so ids increase in that
    // order; newest-first output must therefore be strictly descending.
    expect(ids[0]).toBeGreaterThan(ids[1])
    expect(ids[1]).toBeGreaterThan(ids[2])
  })

  it('returns null for an unknown instance id', () => {
    expect(statusService.getInstanceDetail('inst_missing', toEpochMs(1000))).toBeNull()
  })
})

describe('InstanceStatusService — config thresholds', () => {
  it('honors a custom escalation threshold injected in the constructor', () => {
    const custom = new InstanceStatusService(
      instances,
      sessions,
      events,
      projects,
      devices,
      prStatus,
      // active escalates after 1h instead of the 2h default.
      EscalationThresholds.withDefaults({ active: toDurationMs(HOUR_MS) })
    )
    ingestAt(1_000_000, { event_type: 'PostToolUse' })
    const rows = custom.listInstances(toEpochMs(1_000_000 + HOUR_MS + 1000))
    expect(rows[0].status.display).toBe('stale')
  })
})

/** 同一 instance の別 session を ingest するためのペイロード（path 共有）。 */
function baseEvent(opts: { session_id: string; event_type: string; at: number }): RawEventPayload {
  return {
    device_id: DEVICE_ID,
    session_id: opts.session_id,
    instance: {
      remote_url: 'git@github.com:sumihiro/monomi.git',
      path: '/Users/sumihiro/dev/monomi',
      branch: 'feature/ai-sidecar',
      is_git_repo: true,
    },
    event_type: opts.event_type as RawEventPayload['event_type'],
    event_subtype: null,
    tool_name: null,
    tool_summary: null,
    occurred_at: new Date(opts.at).toISOString(),
  }
}
