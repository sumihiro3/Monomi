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

describe('scanForRunningWork — selection (FR-02 AC-1/2/3/6)', () => {
  it('AC-1: selects the Workflow PreToolUse as kind=workflow', () => {
    const page = [preTool('Workflow', 'run-release', 300)]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toEqual({ kind: 'workflow', name: 'run-release' })
    expect(result.boundaryFound).toBe(false)
  })

  it('AC-2: a newer Task appearing before an older Workflow in the descending page does not override the Workflow', () => {
    // Descending (newest first): Task is more recent than Workflow, but Workflow still wins.
    const page = [
      preTool('Task', 'explore: look around', 300),
      preTool('Workflow', 'run-release', 200),
    ]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toEqual({ kind: 'workflow', name: 'run-release' })
  })

  it('AC-2: a Task/Skill following (older than) the Workflow in the run does not override it either', () => {
    const page = [
      preTool('Workflow', 'run-release', 300),
      preTool('Skill', 'code-review', 200),
      preTool('Task', 'explore: look around', 100),
    ]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toEqual({ kind: 'workflow', name: 'run-release' })
  })

  it('AC-3: no Workflow present — falls back to the latest Task as kind=agent', () => {
    const page = [
      preTool('Task', 'explore: look around', 300),
      preTool('Skill', 'code-review', 200),
    ]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({ kind: 'agent', name: 'explore: look around' })
  })

  it('AC-3: no Workflow present — falls back to the latest Skill as kind=skill', () => {
    const page = [
      preTool('Skill', 'code-review', 300),
      preTool('Task', 'explore: look around', 200),
    ]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({ kind: 'skill', name: 'code-review' })
  })

  it('AC-3: tool_name=Agent is treated the same as Task (kind=agent)', () => {
    const page = [preTool('Agent', 'reviewer: check diff', 300)]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({ kind: 'agent', name: 'reviewer: check diff' })
  })

  it('AC-6: empty tool_summary on a Workflow event is ignored (falls through to Task fallback)', () => {
    const page = [preTool('Workflow', '', 300), preTool('Task', 'explore: look around', 200)]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toEqual({ kind: 'agent', name: 'explore: look around' })
  })

  it('AC-6: null tool_summary on a Skill event is ignored and yields no fallback either', () => {
    const page = [preTool('Skill', null, 300)]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
    expect(result.boundaryFound).toBe(false)
  })

  it('ignores PostToolUse events (no candidate, avoids premature extinguish on background tool completion)', () => {
    const page = [postTool('Workflow', 'run-release', 300), postTool('Task', 'explore: x', 200)]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
  })

  it('ignores tool_name values outside the Workflow/Task/Agent/Skill sets', () => {
    const page = [preTool('Bash', 'ls -la', 300)]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
  })
})

describe('scanForRunningWork — boundary detection (run closes on Stop/idle_prompt/SessionEnd/UserPromptSubmit)', () => {
  it('AC-4: Stop closes the run — boundaryFound=true, no workflow, no fallback picked up from before it', () => {
    const page = [stop(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null)
    expect(result.boundaryFound).toBe(true)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
  })

  it('AC-4: Notification(idle_prompt) closes the run', () => {
    const page = [idlePrompt(300), preTool('Task', 'explore: x', 200)]
    const result = scanForRunningWork(page, null)
    expect(result.boundaryFound).toBe(true)
    expect(result.fallback).toBeNull()
  })

  it('AC-4: SessionEnd closes the run', () => {
    const page = [sessionEnd(300), preTool('Skill', 'code-review', 200)]
    const result = scanForRunningWork(page, null)
    expect(result.boundaryFound).toBe(true)
    expect(result.fallback).toBeNull()
  })

  it('AC-5: UserPromptSubmit closes the run so the previous turn name is not carried over', () => {
    const page = [userPromptSubmit(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null)
    expect(result.boundaryFound).toBe(true)
    expect(result.workflow).toBeNull()
    expect(result.fallback).toBeNull()
  })

  it('Notification(permission_prompt) is NOT a boundary — approval wait does not close the run by itself', () => {
    const page = [permissionPrompt(300), preTool('Workflow', 'run-release', 200)]
    const result = scanForRunningWork(page, null)
    expect(result.boundaryFound).toBe(false)
    expect(result.workflow).toEqual({ kind: 'workflow', name: 'run-release' })
  })

  it('a candidate found before the boundary in the same page still resolves as the answer', () => {
    // Newest first: Task candidate, then Workflow, then the run-closing Stop further back.
    const page = [
      preTool('Task', 'explore: x', 300),
      preTool('Workflow', 'run-release', 200),
      stop(100),
    ]
    const result = scanForRunningWork(page, null)
    expect(result.workflow).toEqual({ kind: 'workflow', name: 'run-release' })
  })

  it('carries the fallback across pages when neither a Workflow nor a boundary is found yet', () => {
    // First (newest) page has no boundary and a Task fallback; caller would carry `fallback` into
    // the next (older) page call, which then finds no further candidate but hits the boundary.
    const firstPage = [preTool('Task', 'explore: x', 300)]
    const firstResult = scanForRunningWork(firstPage, null)
    expect(firstResult.boundaryFound).toBe(false)
    expect(firstResult.workflow).toBeNull()
    expect(firstResult.fallback).toEqual({ kind: 'agent', name: 'explore: x' })

    const secondPage = [stop(100)]
    const secondResult = scanForRunningWork(secondPage, firstResult.fallback)
    expect(secondResult.boundaryFound).toBe(true)
    expect(secondResult.fallback).toEqual({ kind: 'agent', name: 'explore: x' })
  })
})
