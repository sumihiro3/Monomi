import { describe, expect, it } from 'vitest'
import type { Event } from '../domain/entities.js'
import type { EventType } from '../domain/enums.js'
import { toDurationMs, toEpochMs } from '../domain/time.js'
import { EscalationThresholds } from './escalation.js'
import { StatusDeriver } from './status-deriver.js'

const HOUR = 3_600_000
const MINUTE = 60_000

const deriver = new StatusDeriver()
/** 既定閾値: active 2h / approval_wait 6h / next_wait 24h / pr_wait 72h。 */
const thresholds = EscalationThresholds.withDefaults()

let seq = 0

interface EventInput {
  eventType: EventType
  /** hub 権威時刻（§0.5）。status 導出はこの値を使う。 */
  receivedAt: number
  /** クライアント時刻。既定では received_at と同値（status 導出には使われない）。 */
  occurredAt?: number
  eventSubtype?: string | null
  id?: number
  sessionId?: string
}

/** テスト用 Event を最小指定で生成する。 */
function makeEvent(input: EventInput): Event {
  seq += 1
  return {
    id: input.id ?? seq,
    sessionId: input.sessionId ?? 's1',
    instanceId: 'i1',
    eventType: input.eventType,
    eventSubtype: input.eventSubtype ?? null,
    toolName: null,
    toolSummary: null,
    occurredAt: toEpochMs(input.occurredAt ?? input.receivedAt),
    receivedAt: toEpochMs(input.receivedAt),
  }
}

const notif = (subtype: string, receivedAt: number, extra: Partial<EventInput> = {}): Event =>
  makeEvent({ eventType: 'Notification', eventSubtype: subtype, receivedAt, ...extra })

describe('StatusDeriver.deriveForSession — raw_state mapping (FR-04 AC-1)', () => {
  it('maps Notification(permission_prompt) to approval_wait', () => {
    const r = deriver.deriveForSession(
      [notif('permission_prompt', 1000)],
      toEpochMs(1000),
      thresholds,
      false
    )
    expect(r.rawState).toBe('APPROVAL_WAIT')
    expect(r.display).toBe('APPROVAL_WAIT')
    expect(r.isStale).toBe(false)
    expect(r.priority).toBe(4)
  })

  it('maps Notification(idle_prompt) to next_wait', () => {
    const r = deriver.deriveForSession(
      [notif('idle_prompt', 1000)],
      toEpochMs(1000),
      thresholds,
      false
    )
    expect(r.rawState).toBe('NEXT_WAIT')
    expect(r.display).toBe('NEXT_WAIT')
    expect(r.priority).toBe(2)
  })

  it.each<[EventType, string]>([
    ['SessionStart', 'ACTIVE'],
    ['UserPromptSubmit', 'ACTIVE'],
    ['PreToolUse', 'ACTIVE'],
    ['PostToolUse', 'ACTIVE'],
    ['Stop', 'NEXT_WAIT'],
    ['SessionEnd', 'CLOSED'],
  ])('maps %s to %s', (eventType, expected) => {
    const r = deriver.deriveForSession(
      [makeEvent({ eventType, receivedAt: 0 })],
      toEpochMs(0),
      thresholds,
      false
    )
    expect(r.rawState).toBe(expected)
  })

  it('represents a closed session at the lowest priority and never stale', () => {
    const r = deriver.deriveForSession(
      [makeEvent({ eventType: 'SessionEnd', receivedAt: 0 })],
      toEpochMs(1000 * HOUR),
      thresholds,
      false
    )
    expect(r.display).toBe('CLOSED')
    expect(r.priority).toBe(0)
    expect(r.isStale).toBe(false)
  })

  it('picks the latest state-bearing event by received_at, ignoring array order', () => {
    // PostToolUse (received 2000) is newer than the permission prompt (received 1000),
    // even though it is listed first in the array.
    const events = [
      makeEvent({ eventType: 'PostToolUse', receivedAt: 2000 }),
      notif('permission_prompt', 1000),
    ]
    expect(deriver.deriveForSession(events, toEpochMs(2000), thresholds, false).rawState).toBe(
      'ACTIVE'
    )
  })

  it('ignores auxiliary WorktreeCreate/WorktreeRemove events for state', () => {
    const events = [
      notif('idle_prompt', 1000),
      makeEvent({ eventType: 'WorktreeCreate', receivedAt: 2000 }),
    ]
    // The worktree event is newer but is not state-bearing, so idle_prompt still wins.
    expect(deriver.deriveForSession(events, toEpochMs(2000), thresholds, false).rawState).toBe(
      'NEXT_WAIT'
    )
  })

  it('falls back to active/0 when there are no state-bearing events', () => {
    const r = deriver.deriveForSession(
      [makeEvent({ eventType: 'WorktreeCreate', receivedAt: 0 })],
      toEpochMs(100 * HOUR),
      thresholds,
      false
    )
    expect(r.display).toBe('ACTIVE')
    expect(r.isStale).toBe(false)
    expect(r.elapsedMs).toBe(0)
  })

  it('falls back to active/0 for an empty event list', () => {
    expect(deriver.deriveForSession([], toEpochMs(0), thresholds, false).display).toBe('ACTIVE')
  })
})

describe('StatusDeriver.deriveForSession — elapsed-time escalation (FR-04 AC-2)', () => {
  const active = [makeEvent({ eventType: 'PostToolUse', receivedAt: 0 })]

  it('stays active before the 2h threshold', () => {
    const r = deriver.deriveForSession(active, toEpochMs(1 * HOUR), thresholds, false)
    expect(r.display).toBe('ACTIVE')
    expect(r.isStale).toBe(false)
  })

  it('escalates active to stale once the event recedes past 2h', () => {
    const r = deriver.deriveForSession(active, toEpochMs(3 * HOUR), thresholds, false)
    expect(r.display).toBe('STALE')
    expect(r.isStale).toBe(true)
    // The underlying raw_state is preserved even after escalating to STALE.
    expect(r.rawState).toBe('ACTIVE')
    expect(r.priority).toBe(5)
  })

  it('uses the approval_wait threshold (6h) for approval_wait', () => {
    const approval = [notif('permission_prompt', 0)]
    expect(deriver.deriveForSession(approval, toEpochMs(5 * HOUR), thresholds, false).display).toBe(
      'APPROVAL_WAIT'
    )
    expect(deriver.deriveForSession(approval, toEpochMs(7 * HOUR), thresholds, false).display).toBe(
      'STALE'
    )
  })

  it('uses the next_wait threshold (24h) for next_wait', () => {
    const idle = [notif('idle_prompt', 0)]
    expect(deriver.deriveForSession(idle, toEpochMs(23 * HOUR), thresholds, false).display).toBe(
      'NEXT_WAIT'
    )
    expect(deriver.deriveForSession(idle, toEpochMs(25 * HOUR), thresholds, false).display).toBe(
      'STALE'
    )
  })

  it('honors config-overridden thresholds', () => {
    const tight = EscalationThresholds.withDefaults({ active: toDurationMs(30 * MINUTE) })
    expect(deriver.deriveForSession(active, toEpochMs(45 * MINUTE), tight, false).display).toBe(
      'STALE'
    )
  })
})

describe('StatusDeriver.deriveForSession — clock does not reset on repeated idle (FR-04 AC-3, §0.5)', () => {
  it('keeps the transition anchored to the first idle across repeated idle_prompt fires', () => {
    const idles = [
      notif('idle_prompt', 0),
      notif('idle_prompt', MINUTE),
      notif('idle_prompt', 2 * MINUTE),
    ]
    const now = 24 * HOUR + 30_000 // 30s past 24h measured from the FIRST idle (t=0)

    const r = deriver.deriveForSession(idles, toEpochMs(now), thresholds, false)

    // Anchored to the first idle => elapsed is measured from t=0, so it is stale.
    expect(r.elapsedMs).toBe(now)
    expect(r.display).toBe('STALE')
    // Had the clock (incorrectly) reset to the last idle (2min), elapsed would be
    // 24h+30s-2min < 24h and it would still read NEXT_WAIT. The assertion above
    // fails in that buggy case, which is exactly the §0.5 guarantee under test.
  })

  it('does reset the clock when a real state change (active) interrupts the idle run', () => {
    const events = [
      notif('idle_prompt', 0),
      makeEvent({ eventType: 'PostToolUse', receivedAt: 100 * MINUTE }),
      notif('idle_prompt', 200 * MINUTE),
    ]
    const r = deriver.deriveForSession(
      events,
      toEpochMs(200 * MINUTE + 5 * HOUR),
      thresholds,
      false
    )

    // The active event breaks the run, so the transition is the second idle (200min).
    expect(r.elapsedMs).toBe(5 * HOUR)
    expect(r.display).toBe('NEXT_WAIT')
  })
})

describe('StatusDeriver.deriveForSession — PR waiting overlay (§5.2)', () => {
  it('shows pr_wait for a next_wait session with an open PR', () => {
    const idle = [notif('idle_prompt', 0)]
    expect(deriver.deriveForSession(idle, toEpochMs(1 * HOUR), thresholds, true).display).toBe(
      'PR_WAIT'
    )
  })

  it('keeps active over pr_wait while the session is active (§5.2)', () => {
    const active = [makeEvent({ eventType: 'PostToolUse', receivedAt: 0 })]
    expect(deriver.deriveForSession(active, toEpochMs(1 * HOUR), thresholds, true).display).toBe(
      'ACTIVE'
    )
  })

  it('keeps approval_wait over pr_wait (approval outranks PR)', () => {
    const approval = [notif('permission_prompt', 0)]
    expect(deriver.deriveForSession(approval, toEpochMs(1 * HOUR), thresholds, true).display).toBe(
      'APPROVAL_WAIT'
    )
  })

  it('uses the pr_wait threshold (72h) rather than next_wait (24h) for a PR-waiting session', () => {
    const idle = [notif('idle_prompt', 0)]
    // 30h would be stale under the 24h next_wait threshold, but not under 72h pr_wait.
    expect(deriver.deriveForSession(idle, toEpochMs(30 * HOUR), thresholds, true).display).toBe(
      'PR_WAIT'
    )
    expect(deriver.deriveForSession(idle, toEpochMs(73 * HOUR), thresholds, true).display).toBe(
      'STALE'
    )
  })
})

describe('StatusDeriver.deriveForSession — received_at is the authoritative clock (§0.5)', () => {
  it('measures elapsed from received_at and ignores occurred_at (client skew)', () => {
    // occurred_at is ancient (t=0) but the hub received it at 10h; now is 11h.
    const event = [makeEvent({ eventType: 'PostToolUse', occurredAt: 0, receivedAt: 10 * HOUR })]
    const r = deriver.deriveForSession(event, toEpochMs(11 * HOUR), thresholds, false)

    // Elapsed is 1h (from received_at), so it is NOT stale. Using occurred_at would
    // have yielded 11h and (incorrectly) STALE.
    expect(r.elapsedMs).toBe(1 * HOUR)
    expect(r.display).toBe('ACTIVE')
  })
})
