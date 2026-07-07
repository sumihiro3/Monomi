import { describe, expect, it } from 'vitest'
import type { Event } from '../domain/entities.js'
import type { EventType } from '../domain/enums.js'
import { toEpochMs } from '../domain/time.js'
import { scanForRunningWork } from './running-work-resolver.js'

let seq = 0

interface EventInput {
  eventType: EventType
  /** hub 権威時刻（§0.5）。降順ページはこの値で並べる。 */
  receivedAt: number
  eventSubtype?: string | null
  toolName?: string | null
  toolSummary?: string | null
  id?: number
}

/** テスト用 Event を最小指定で生成する（id 未指定なら生成順で採番）。run-boundary-scanner.test.ts と同一パターン。 */
function makeEvent(input: EventInput): Event {
  seq += 1
  return {
    id: input.id ?? seq,
    sessionId: 's1',
    instanceId: 'i1',
    eventType: input.eventType,
    eventSubtype: input.eventSubtype ?? null,
    toolName: input.toolName ?? null,
    toolSummary: input.toolSummary ?? null,
    occurredAt: toEpochMs(input.receivedAt),
    receivedAt: toEpochMs(input.receivedAt),
  }
}

const preTool = (toolName: string, toolSummary: string | null, receivedAt: number): Event =>
  makeEvent({ eventType: 'PreToolUse', toolName, toolSummary, receivedAt })

const postTool = (toolName: string, toolSummary: string | null, receivedAt: number): Event =>
  makeEvent({ eventType: 'PostToolUse', toolName, toolSummary, receivedAt })

const stop = (receivedAt: number): Event => makeEvent({ eventType: 'Stop', receivedAt })
const sessionEnd = (receivedAt: number): Event => makeEvent({ eventType: 'SessionEnd', receivedAt })
const userPromptSubmit = (receivedAt: number): Event =>
  makeEvent({ eventType: 'UserPromptSubmit', receivedAt })
const idlePrompt = (receivedAt: number): Event =>
  makeEvent({ eventType: 'Notification', eventSubtype: 'idle_prompt', receivedAt })
const permissionPrompt = (receivedAt: number): Event =>
  makeEvent({ eventType: 'Notification', eventSubtype: 'permission_prompt', receivedAt })

describe('scanForRunningWork — selection (candidate priority, sanitization: release-16 FR-02 / release-18 FR-04)', () => {
  it('selects the Workflow PreToolUse as kind=workflow', () => {
    const page = [preTool('Workflow', 'run-release', 300)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(300),
    })
    expect(result.sessionEndFound).toBe(false)
  })

  it('a newer Task appearing before an older Workflow in the descending page does not override the Workflow', () => {
    // Descending (newest first): Task is more recent than Workflow, but Workflow still wins.
    const page = [
      preTool('Task', 'explore: look around', 300),
      preTool('Workflow', 'run-release', 200),
    ]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(200),
    })
  })

  it('a Task/Skill following (older than) the Workflow in the run does not override it either', () => {
    const page = [
      preTool('Workflow', 'run-release', 300),
      preTool('Skill', 'code-review', 200),
      preTool('Task', 'explore: look around', 100),
    ]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(300),
    })
  })

  it('no Workflow present — falls back to the latest Task as kind=agent', () => {
    const page = [
      preTool('Task', 'explore: look around', 300),
      preTool('Skill', 'code-review', 200),
    ]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({
      kind: 'agent',
      name: 'explore: look around',
      startedAt: toEpochMs(300),
    })
  })

  it('no Workflow present — falls back to the latest Skill as kind=skill', () => {
    const page = [
      preTool('Skill', 'code-review', 300),
      preTool('Task', 'explore: look around', 200),
    ]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({
      kind: 'skill',
      name: 'code-review',
      startedAt: toEpochMs(300),
    })
  })

  it('tool_name=Agent is treated the same as Task (kind=agent)', () => {
    const page = [preTool('Agent', 'reviewer: check diff', 300)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({
      kind: 'agent',
      name: 'reviewer: check diff',
      startedAt: toEpochMs(300),
    })
  })

  it('empty tool_summary on a Workflow event is ignored (falls through to Task fallback)', () => {
    const page = [preTool('Workflow', '', 300), preTool('Task', 'explore: look around', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({
      kind: 'agent',
      name: 'explore: look around',
      startedAt: toEpochMs(200),
    })
  })

  it('null tool_summary on a Skill event is ignored and yields no fallback either', () => {
    const page = [preTool('Skill', null, 300)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
    expect(result.sessionEndFound).toBe(false)
  })

  it('ignores PostToolUse events (no candidate, avoids premature extinguish on background tool completion)', () => {
    const page = [postTool('Workflow', 'run-release', 300), postTool('Task', 'explore: x', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
  })

  it('ignores tool_name values outside the Workflow/Task/Agent/Skill sets', () => {
    const page = [preTool('Bash', 'ls -la', 300)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
  })

  it('Notification(permission_prompt) is not a boundary for either candidate kind — approval wait does not close the run by itself', () => {
    const page = [permissionPrompt(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.sessionEndFound).toBe(false)
    expect(result.fallbackBoundaryReached).toBe(false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(200),
    })
  })
})

describe('scanForRunningWork — asymmetric boundaries (release-18 FR-04): Workflow closes only on SessionEnd, fallback keeps the release-16 boundary set', () => {
  it('AC-1 building block: a Workflow older than a Stop is still found — Stop is not a Workflow boundary', () => {
    const page = [stop(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(200),
    })
    expect(result.sessionEndFound).toBe(false)
  })

  it('AC-1 building block: a Workflow older than a UserPromptSubmit is still found — UserPromptSubmit is not a Workflow boundary', () => {
    const page = [userPromptSubmit(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(200),
    })
  })

  it('a Workflow older than a Notification(idle_prompt) is still found — idle_prompt is not a Workflow boundary', () => {
    const page = [idlePrompt(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(200),
    })
  })

  it('AC-2: SessionEnd is the only Workflow boundary — a Workflow older than SessionEnd is NOT found, sessionEndFound=true instead', () => {
    const page = [sessionEnd(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.sessionEndFound).toBe(true)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull() // never reached the older Workflow event to consider it as fallback either
  })

  it('AC-4: a Task/Skill fallback candidate seen before (newer than) its boundary is kept', () => {
    const page = [preTool('Skill', 'code-review', 300), stop(200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({
      kind: 'skill',
      name: 'code-review',
      startedAt: toEpochMs(300),
    })
    expect(result.fallbackBoundaryReached).toBe(true)
  })

  it('AC-4: a Task/Skill fallback candidate seen after (older than) a Stop boundary is NOT picked up', () => {
    const page = [stop(300), preTool('Skill', 'code-review', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
    expect(result.fallbackBoundaryReached).toBe(true)
  })

  it('AC-4: a Task/Skill fallback candidate seen after a UserPromptSubmit boundary is NOT picked up', () => {
    const page = [userPromptSubmit(300), preTool('Task', 'explore: look around', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.fallback).toBeNull()
    expect(result.fallbackBoundaryReached).toBe(true)
  })

  it('AC-4: a Task/Skill fallback candidate seen after a Notification(idle_prompt) boundary is NOT picked up', () => {
    const page = [idlePrompt(300), preTool('Task', 'explore: look around', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.fallback).toBeNull()
    expect(result.fallbackBoundaryReached).toBe(true)
  })

  it('SessionEnd also stops fallback collection — an older Task past SessionEnd is never examined', () => {
    const page = [sessionEnd(300), preTool('Task', 'explore: look around', 200)]
    const result = scanForRunningWork(page, null, false)
    expect(result.sessionEndFound).toBe(true)
    expect(result.fallback).toBeNull()
  })

  it('priority: a Workflow found across a fallback boundary wins over a fallback candidate found within the boundary', () => {
    // Newest first: a Skill fallback candidate, then the boundary, then an older Workflow.
    const page = [
      preTool('Skill', 'code-review', 400),
      stop(300),
      preTool('Workflow', 'run-release', 200),
    ]
    const result = scanForRunningWork(page, null, false)
    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(200),
    })
  })

  it('carries a frozen fallback and fallbackBoundaryReached=true across pages when neither a Workflow nor SessionEnd is found yet', () => {
    // First (newest) page has no boundary yet and picks up a Task fallback.
    const firstPage = [preTool('Task', 'explore: x', 300)]
    const firstResult = scanForRunningWork(firstPage, null, false)
    expect(firstResult.sessionEndFound).toBe(false)
    expect(firstResult.workflow).toBeNull()
    expect(firstResult.fallback).toEqual({
      kind: 'agent',
      name: 'explore: x',
      startedAt: toEpochMs(300),
    })
    expect(firstResult.fallbackBoundaryReached).toBe(false)

    // Second (older) page crosses the fallback boundary but still finds no Workflow/SessionEnd —
    // the caller is expected to keep paging (this function does not decide that; it only reports
    // the carry-over state).
    const secondPage = [stop(200)]
    const secondResult = scanForRunningWork(
      secondPage,
      firstResult.fallback,
      firstResult.fallbackBoundaryReached
    )
    expect(secondResult.sessionEndFound).toBe(false)
    expect(secondResult.workflow).toBeNull()
    expect(secondResult.fallback).toEqual({
      kind: 'agent',
      name: 'explore: x',
      startedAt: toEpochMs(300),
    })
    expect(secondResult.fallbackBoundaryReached).toBe(true)
  })

  it('a Workflow found in an older page beats a frozen fallback carried in from a newer page', () => {
    const firstPage = [preTool('Task', 'explore: x', 300)]
    const firstResult = scanForRunningWork(firstPage, null, false)

    // Second (older) page crosses the fallback boundary (Stop) and then finds a Workflow further
    // back — the Workflow wins even though the fallback boundary was already crossed.
    const secondPage = [stop(200), preTool('Workflow', 'run-release', 100)]
    const secondResult = scanForRunningWork(
      secondPage,
      firstResult.fallback,
      firstResult.fallbackBoundaryReached
    )
    expect(secondResult.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(100),
    })
  })
})

describe('scanForRunningWork — AC-1 regression: U8 real incident replay (background Workflow survives its own turn boundary)', () => {
  it('PreToolUse|Workflow → PostToolUse → Stop → other tool events → UserPromptSubmit → PreToolUse|Skill still resolves to the Workflow name', () => {
    // Chronological order (ascending): Workflow starts (t=300) → its own tool call completes
    // (t=400) → the turn ends with Stop (t=500) while the background Workflow keeps running via
    // subagent activity → unrelated tool calls happen during that background run (t=590, 600) →
    // the user starts a new turn (t=700) → the new turn calls an unrelated Skill (t=800). This is
    // exactly known-issues.md U8: the incident was raw_state=active with running_work showing the
    // newer Skill ("investigate") instead of the still-running Workflow ("run-release").
    //
    // `page` is receivedAt-descending (newest first), matching what
    // `EventRepository.recentPageForSession` returns.
    const page = [
      preTool('Skill', 'investigate', 800),
      userPromptSubmit(700),
      postTool('Bash', 'ls -la', 600),
      preTool('Bash', 'ls -la', 590),
      stop(500),
      postTool('Workflow', 'run-release', 400),
      preTool('Workflow', 'run-release', 300),
    ]

    const result = scanForRunningWork(page, null, false)

    expect(result.workflow).toEqual({
      kind: 'workflow',
      name: 'run-release',
      startedAt: toEpochMs(300),
    })
    expect(result.sessionEndFound).toBe(false)
    // The newer Skill (t=800) is scanned before the fallback boundary (UserPromptSubmit, t=700)
    // is crossed, so it was captured as the fallback candidate — but the Workflow found across
    // the boundary still wins per FR-04 priority (this is the U8 fix itself).
    expect(result.fallback).toEqual({
      kind: 'skill',
      name: 'investigate',
      startedAt: toEpochMs(800),
    })
  })
})
