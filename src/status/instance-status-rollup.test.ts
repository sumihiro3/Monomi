import { describe, expect, it } from 'vitest'
import { type EpochMs, toDurationMs, toEpochMs } from '../domain/time.js'
import { InstanceStatusRollup, type RollupEntry } from './instance-status-rollup.js'
import { type RepresentedStatus, StatusPriority } from './status-priority.js'
import { createStatusResult, type StatusResult } from './status-result.js'

const rollup = new InstanceStatusRollup()

/** テスト内の時刻計算の基準アンカー（意味を持たない単なる原点）。 */
const NOW = toEpochMs(10_000_000)

/** 15分閾値の内側(生存扱い)・外側(孤立 session 扱い)の直近イベント時刻。 */
const LIVE_LAST_EVENT_AT = toEpochMs(NOW - 60_000) // 1分前
const STALE_LAST_EVENT_AT = toEpochMs(NOW - 20 * 60_000) // 20分前（15分閾値超）

/**
 * 表示ステータスから StatusResult を作るヘルパー。rawState は rollup の判定に無関係
 * （優先度と経過時間のみで比較される）なのでプレースホルダを入れる。
 */
function sr(display: RepresentedStatus, elapsedMs = 0): StatusResult {
  return createStatusResult('ACTIVE', display, toDurationMs(elapsedMs), display === 'STALE')
}

/** 既定で「直近イベントが1分前(生存扱い)」の RollupEntry を作るヘルパー。 */
function entry(
  display: RepresentedStatus,
  elapsedMs = 0,
  lastEventAt: EpochMs = LIVE_LAST_EVENT_AT
): RollupEntry {
  return { status: sr(display, elapsedMs), lastEventAt }
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
    expect(rollup.rollup([entry('ACTIVE'), entry('APPROVAL_WAIT')]).display).toBe('APPROVAL_WAIT')
  })

  it('does not let a closed session hide an active one (§0.5)', () => {
    expect(rollup.rollup([entry('CLOSED'), entry('ACTIVE')]).display).toBe('ACTIVE')
    expect(rollup.rollup([entry('ACTIVE'), entry('CLOSED')]).display).toBe('ACTIVE')
  })

  it('ranks stale (放置) above everything', () => {
    expect(
      rollup.rollup([entry('APPROVAL_WAIT'), entry('STALE'), entry('NEXT_WAIT')]).display
    ).toBe('STALE')
  })

  it('ranks pr_wait above next_wait but below approval_wait (§5.2)', () => {
    expect(rollup.rollup([entry('NEXT_WAIT'), entry('PR_WAIT')]).display).toBe('PR_WAIT')
    expect(rollup.rollup([entry('APPROVAL_WAIT'), entry('PR_WAIT')]).display).toBe('APPROVAL_WAIT')
  })

  it('is independent of session ordering', () => {
    const sessions = [entry('ACTIVE'), entry('CLOSED'), entry('APPROVAL_WAIT'), entry('NEXT_WAIT')]
    expect(rollup.rollup(sessions).display).toBe('APPROVAL_WAIT')
    expect(rollup.rollup([...sessions].reverse()).display).toBe('APPROVAL_WAIT')
  })

  it('returns the single session as-is', () => {
    expect(rollup.rollup([entry('NEXT_WAIT')]).display).toBe('NEXT_WAIT')
  })

  it('breaks ties on equal priority by the longer-elapsed session', () => {
    const rep = rollup.rollup([entry('NEXT_WAIT', 1000), entry('NEXT_WAIT', 5000)])
    expect(rep.elapsedMs).toBe(5000)
  })

  it('throws on an empty session list', () => {
    expect(() => rollup.rollup([])).toThrow(/empty/)
  })
})

describe('InstanceStatusRollup.rollup — stale session exclusion (release-7 FR-01)', () => {
  it('AC-1: excludes a session whose last event is 15+ minutes older than the freshest session', () => {
    // 孤立 session (next_wait, 20分前) が高優先度でも、生存している active session が代表になる。
    const rep = rollup.rollup([
      entry('NEXT_WAIT', 0, STALE_LAST_EVENT_AT),
      entry('ACTIVE', 0, LIVE_LAST_EVENT_AT),
    ])
    expect(rep.display).toBe('ACTIVE')
  })

  it('AC-2 regression: when all sessions are within 15 minutes of each other, highest priority wins as before', () => {
    const rep = rollup.rollup([
      entry('ACTIVE', 0, LIVE_LAST_EVENT_AT),
      entry('APPROVAL_WAIT', 0, LIVE_LAST_EVENT_AT),
    ])
    expect(rep.display).toBe('APPROVAL_WAIT')
  })

  it('AC-3: a single session is never excluded, however old its last event is (nothing fresher to compare against)', () => {
    const rep = rollup.rollup([entry('NEXT_WAIT', 0, STALE_LAST_EVENT_AT)])
    expect(rep.display).toBe('NEXT_WAIT')
  })

  it('AC-4 (OSSRadar case): orphaned next_wait session (20min ago) + current active session (seconds ago) => active wins', () => {
    const orphan = entry('NEXT_WAIT', 0, toEpochMs(NOW - 20 * 60_000))
    const current = entry('ACTIVE', 0, toEpochMs(NOW - 3_000))
    expect(rollup.rollup([orphan, current]).display).toBe('ACTIVE')
    expect(rollup.rollup([current, orphan]).display).toBe('ACTIVE')
  })

  it('does not exclude every session just because the freshest one is itself >15min old in wall-clock terms (relative basis, not absolute now)', () => {
    // review-changes で検出された回帰の再現ケース: 孤立 session (2時間前) と、長時間の
    // ツール実行中で新規イベントが無い稼働中 session (20分前) がどちらも「壁時計基準の now」
    // からは15分を超えて古い。絶対時刻基準だと両方 stale 扱いされ全件フォールバック経由で
    // 孤立 session の next_wait が代表に選ばれてしまう(バグ)。instance 内の最新イベントを
    // 基準にする相対判定なら、稼働中 session だけが候補に残り active が代表になる。
    const orphan = entry('NEXT_WAIT', 0, toEpochMs(NOW - 2 * 60 * 60_000))
    const longRunningActive = entry('ACTIVE', 0, toEpochMs(NOW - 20 * 60_000))
    expect(rollup.rollup([orphan, longRunningActive]).display).toBe('ACTIVE')
    expect(rollup.rollup([longRunningActive, orphan]).display).toBe('ACTIVE')
  })

  it('treats a session exactly at the 15-minute threshold relative to the freshest session as stale (boundary is exclusive of liveness)', () => {
    const freshest = toEpochMs(NOW - 60_000)
    const atThreshold = toEpochMs(freshest - 15 * 60_000)
    const rep = rollup.rollup([entry('NEXT_WAIT', 0, atThreshold), entry('ACTIVE', 0, freshest)])
    expect(rep.display).toBe('ACTIVE')
  })
})
