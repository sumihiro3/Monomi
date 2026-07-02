import { describe, expect, it } from 'vitest'
import { toDurationMs } from '../domain/time.js'
import { InstanceStatusRollup } from './instance-status-rollup.js'
import { StatusPriority, type RepresentedStatus } from './status-priority.js'
import { createStatusResult, type StatusResult } from './status-result.js'

const rollup = new InstanceStatusRollup()

/**
 * 表示ステータスから StatusResult を作るヘルパー。rawState は rollup の判定に無関係
 * （優先度と経過時間のみで比較される）なのでプレースホルダを入れる。
 */
function sr(display: RepresentedStatus, elapsedMs = 0): StatusResult {
  return createStatusResult('ACTIVE', display, toDurationMs(elapsedMs), display === 'STALE')
}

describe('StatusPriority — §5.2 ordering (single source of priority)', () => {
  const priority = new StatusPriority()

  it('orders 放置 > 権限待ち > PR待ち > 次の指示待ち > 稼働中 > closed', () => {
    expect(priority.priorityOf('STALE')).toBeGreaterThan(priority.priorityOf('APPROVAL_WAIT'))
    expect(priority.priorityOf('APPROVAL_WAIT')).toBeGreaterThan(priority.priorityOf('PR_WAIT'))
    expect(priority.priorityOf('PR_WAIT')).toBeGreaterThan(priority.priorityOf('NEXT_WAIT'))
    expect(priority.priorityOf('NEXT_WAIT')).toBeGreaterThan(priority.priorityOf('ACTIVE'))
    expect(priority.priorityOf('ACTIVE')).toBeGreaterThan(priority.priorityOf('CLOSED'))
  })
})

describe('InstanceStatusRollup.rollup — representative selection (FR-04 AC-4/AC-5, §5.3)', () => {
  it('picks the higher-priority status across sessions (approval_wait over active)', () => {
    expect(rollup.rollup([sr('ACTIVE'), sr('APPROVAL_WAIT')]).display).toBe('APPROVAL_WAIT')
  })

  it('does not let a closed session hide an active one (§0.5)', () => {
    expect(rollup.rollup([sr('CLOSED'), sr('ACTIVE')]).display).toBe('ACTIVE')
    expect(rollup.rollup([sr('ACTIVE'), sr('CLOSED')]).display).toBe('ACTIVE')
  })

  it('ranks stale (放置) above everything', () => {
    expect(rollup.rollup([sr('APPROVAL_WAIT'), sr('STALE'), sr('NEXT_WAIT')]).display).toBe('STALE')
  })

  it('ranks pr_wait above next_wait but below approval_wait (§5.2)', () => {
    expect(rollup.rollup([sr('NEXT_WAIT'), sr('PR_WAIT')]).display).toBe('PR_WAIT')
    expect(rollup.rollup([sr('APPROVAL_WAIT'), sr('PR_WAIT')]).display).toBe('APPROVAL_WAIT')
  })

  it('is independent of session ordering', () => {
    const sessions = [sr('ACTIVE'), sr('CLOSED'), sr('APPROVAL_WAIT'), sr('NEXT_WAIT')]
    expect(rollup.rollup(sessions).display).toBe('APPROVAL_WAIT')
    expect(rollup.rollup([...sessions].reverse()).display).toBe('APPROVAL_WAIT')
  })

  it('returns the single session as-is', () => {
    expect(rollup.rollup([sr('NEXT_WAIT')]).display).toBe('NEXT_WAIT')
  })

  it('breaks ties on equal priority by the longer-elapsed session', () => {
    const rep = rollup.rollup([sr('NEXT_WAIT', 1000), sr('NEXT_WAIT', 5000)])
    expect(rep.elapsedMs).toBe(5000)
  })

  it('throws on an empty session list', () => {
    expect(() => rollup.rollup([])).toThrow(/empty/)
  })
})
