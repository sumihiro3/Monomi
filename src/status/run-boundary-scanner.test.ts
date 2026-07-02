import { describe, expect, it } from 'vitest'
import type { Event } from '../domain/entities.js'
import type { EventType } from '../domain/enums.js'
import { toEpochMs } from '../domain/time.js'
import { scanForRunBoundary } from './run-boundary-scanner.js'

let seq = 0

interface EventInput {
  eventType: EventType
  /** hub 権威時刻（§0.5）。status 導出はこの値を使う。 */
  receivedAt: number
  eventSubtype?: string | null
  id?: number
}

/** テスト用 Event を最小指定で生成する（id 未指定なら生成順で採番）。state-transition-finder.test.ts と同一パターン。 */
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

const notif = (subtype: string, receivedAt: number): Event =>
  makeEvent({ eventType: 'Notification', eventSubtype: subtype, receivedAt })

const active = (receivedAt: number): Event => makeEvent({ eventType: 'PostToolUse', receivedAt })

/** raw_state を持たない補助イベント（instance 登録用。§7.1）。 */
const auxiliary = (receivedAt: number): Event =>
  makeEvent({ eventType: 'WorktreeCreate', receivedAt })

describe('scanForRunBoundary — single-page boundary detection (§0.5 / §5.2)', () => {
  it('establishes currentState from the first state-bearing event when none was carried in', () => {
    // Descending page (newest first), all ACTIVE.
    const page = [active(300), active(200), active(100)]
    const result = scanForRunBoundary(page, null)
    expect(result.boundaryFound).toBe(false)
    expect(result.state).toBe('ACTIVE')
  })

  it('reports no boundary and leaves state unchanged when the whole page continues the carried-in run', () => {
    const page = [active(300), active(200), active(100)]
    const result = scanForRunBoundary(page, 'ACTIVE')
    expect(result.boundaryFound).toBe(false)
    expect(result.state).toBe('ACTIVE')
  })

  it('detects a boundary when a differing raw_state appears mid-page and keeps the established state', () => {
    // Newest-first: two ACTIVE events, then an older NEXT_WAIT event that breaks the run.
    const page = [active(300), active(200), notif('idle_prompt', 100)]
    const result = scanForRunBoundary(page, null)
    expect(result.boundaryFound).toBe(true)
    // State reflects the current run (ACTIVE), not the differing event that created the boundary.
    expect(result.state).toBe('ACTIVE')
  })

  it('detects a boundary against a state carried in from a previous page', () => {
    // currentState was APPROVAL_WAIT from an earlier page; this page opens with a differing state.
    const page = [notif('idle_prompt', 100)]
    const result = scanForRunBoundary(page, 'APPROVAL_WAIT')
    expect(result.boundaryFound).toBe(true)
    expect(result.state).toBe('APPROVAL_WAIT')
  })

  it('ignores state-less auxiliary events without disturbing the run or falsely finding a boundary', () => {
    const page = [active(400), auxiliary(300), active(200), auxiliary(100)]
    const result = scanForRunBoundary(page, null)
    expect(result.boundaryFound).toBe(false)
    expect(result.state).toBe('ACTIVE')
  })

  it('returns boundaryFound=false and state=null when the page has no state-bearing events', () => {
    const page = [auxiliary(200), auxiliary(100)]
    const result = scanForRunBoundary(page, null)
    expect(result.boundaryFound).toBe(false)
    expect(result.state).toBeNull()
  })

  it('returns boundaryFound=false for an empty page, leaving the carried-in state untouched', () => {
    const result = scanForRunBoundary([], 'NEXT_WAIT')
    expect(result.boundaryFound).toBe(false)
    expect(result.state).toBe('NEXT_WAIT')
  })
})
