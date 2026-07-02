import { describe, expect, it } from 'vitest'
import type { Event } from '../domain/entities.js'
import type { EventType } from '../domain/enums.js'
import { toEpochMs } from '../domain/time.js'
import { collectStateBearingDescending } from './raw-state-resolver.js'
import { StateTransitionFinder } from './state-transition-finder.js'

const MINUTE = 60_000
const finder = new StateTransitionFinder()

let seq = 0

interface EventInput {
  eventType: EventType
  /** hub 権威時刻（§0.5）。status 導出はこの値を使う。 */
  receivedAt: number
  eventSubtype?: string | null
  id?: number
}

/** テスト用 Event を最小指定で生成する（id 未指定なら生成順で採番）。 */
function makeEvent(input: EventInput): Event {
  seq += 1
  return {
    id: input.id ?? seq,
    sessionId: 's1',
    instanceId: 'i1',
    eventType: input.eventType,
    eventSubtype: input.eventSubtype ?? null,
    toolName: null,
    toolSummary: null,
    occurredAt: toEpochMs(input.receivedAt),
    receivedAt: toEpochMs(input.receivedAt),
  }
}

const notif = (subtype: string, receivedAt: number, id?: number): Event =>
  makeEvent({ eventType: 'Notification', eventSubtype: subtype, receivedAt, id })

/**
 * 呼び出し規約に沿った入力（状態イベントのみ・received_at 降順）を、順不同の生イベントから
 * 生成するヘルパー。テストは finder の「降順・単一パス」契約だけを検証する。
 */
const descending = (events: Event[]): Event[] => collectStateBearingDescending(events)

describe('StateTransitionFinder.find — descending single-pass contract (FR-08 P1)', () => {
  it('anchors a single event to its own received_at', () => {
    const events = descending([notif('idle_prompt', 5 * MINUTE)])
    const t = finder.find(events, 'NEXT_WAIT')
    expect(t.rawState).toBe('NEXT_WAIT')
    expect(t.transitionedAt).toBe(5 * MINUTE)
  })

  it('anchors a contiguous same-state run to its earliest event (idle does not reset — §0.5)', () => {
    // Three idle fires. Provided out of order to prove find relies on the shared
    // descending array (built by collectStateBearingDescending), not the raw order.
    const events = descending([
      notif('idle_prompt', 2 * MINUTE),
      notif('idle_prompt', 0),
      notif('idle_prompt', MINUTE),
    ])
    const t = finder.find(events, 'NEXT_WAIT')
    // Anchored to the FIRST (oldest) idle, not the most recent one.
    expect(t.transitionedAt).toBe(0)
  })

  it('resets the anchor at a real state change and only walks the newest run', () => {
    // Timeline (oldest→newest): idle@0, active@100min, idle@200min.
    // The active event breaks the run, so the current NEXT_WAIT run is just idle@200min.
    const events = descending([
      notif('idle_prompt', 0),
      makeEvent({ eventType: 'PostToolUse', receivedAt: 100 * MINUTE }),
      notif('idle_prompt', 200 * MINUTE),
    ])
    const t = finder.find(events, 'NEXT_WAIT')
    expect(t.transitionedAt).toBe(200 * MINUTE)
  })

  it('breaks the run on the first differing state even if the same state reappears earlier', () => {
    // Timeline (oldest→newest): approval@0, idle@10min, approval@20min, approval@30min.
    // Newest run of APPROVAL_WAIT is [30min, 20min]; the idle@10min breaks it, so the
    // earlier approval@0 is NOT reachable.
    const events = descending([
      notif('permission_prompt', 0),
      notif('idle_prompt', 10 * MINUTE),
      notif('permission_prompt', 20 * MINUTE),
      notif('permission_prompt', 30 * MINUTE),
    ])
    const t = finder.find(events, 'APPROVAL_WAIT')
    expect(t.transitionedAt).toBe(20 * MINUTE)
  })

  it('uses id as a stable tiebreaker within the same received_at', () => {
    // Same received_at; the newest is the higher id. All same state → anchor to lowest id.
    const events = descending([
      notif('idle_prompt', 1000, 7),
      notif('idle_prompt', 1000, 3),
      notif('idle_prompt', 1000, 5),
    ])
    // Sanity: descending order is by (received_at desc, id desc) → ids [7,5,3].
    expect(events.map((e) => e.id)).toEqual([7, 5, 3])
    const t = finder.find(events, 'NEXT_WAIT')
    expect(t.transitionedAt).toBe(1000)
  })

  it('throws when there are no state-bearing events', () => {
    expect(() => finder.find([], 'ACTIVE')).toThrow(/no state-bearing events/)
  })

  it('throws when currentState disagrees with the latest (head) event', () => {
    const events = descending([notif('idle_prompt', 0)])
    // The head event is NEXT_WAIT, so claiming ACTIVE is a calling-convention violation.
    expect(() => finder.find(events, 'ACTIVE')).toThrow(/does not match the latest event state/)
  })
})
