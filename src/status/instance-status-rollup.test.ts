import { describe, expect, it } from 'vitest'
import { type EpochMs, toDurationMs, toEpochMs } from '../domain/time.js'
import { InstanceStatusRollup, type RollupEntry } from './instance-status-rollup.js'
import { type RepresentedStatus, StatusPriority } from './status-priority.js'
import { createStatusResult, type StatusResult } from './status-result.js'

const rollup = new InstanceStatusRollup()

/** テスト内の時刻計算の基準アンカー（意味を持たない単なる原点）。 */
const NOW = toEpochMs(10_000_000)

/** rollup エントリの既定の直近イベント時刻（差し替えなければ「新しい」扱いになる基準点）。 */
const DEFAULT_LAST_EVENT_AT = toEpochMs(NOW - 60_000) // 1分前

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
  lastEventAt: EpochMs = DEFAULT_LAST_EVENT_AT
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

describe('InstanceStatusRollup.rollup — recency prioritization (release-8 FR-02)', () => {
  it('AC-1: picks the freshest lastEventAt unconditionally, regardless of priority', () => {
    // 古い session が高優先度 (next_wait) でも、最新イベント時刻を持つ active が代表になる。
    // release-7 では 15分閾値内なら next_wait が選ばれていた（priority ベース）。
    const oldNextWait = entry('NEXT_WAIT', 0, toEpochMs(NOW - 10 * 60_000)) // 10分前
    const freshActive = entry('ACTIVE', 0, toEpochMs(NOW - 1_000)) // 1秒前
    expect(rollup.rollup([oldNextWait, freshActive]).display).toBe('ACTIVE')
    expect(rollup.rollup([freshActive, oldNextWait]).display).toBe('ACTIVE')
  })

  it('AC-1 (B8 regression): session replay 15min within threshold. new session (fresh lastEventAt) wins over old', () => {
    // B8 バグの再現ケース: session 再開時に新しい session_id が払い出され、新 session の
    // lastEventAt が最新なら、古い session（15分以内でも古い状態）に覆い隠されない。
    // 逆が release-7 の問題だった: 古い session が 15分閾値内にいると、古い状態で選ばれていた。
    const oldSession = entry('NEXT_WAIT', 0, toEpochMs(NOW - 10 * 60_000))
    const newSession = entry('ACTIVE', 0, toEpochMs(NOW - 100)) // 再開後の新 session
    expect(rollup.rollup([oldSession, newSession]).display).toBe('ACTIVE')
    expect(rollup.rollup([newSession, oldSession]).display).toBe('ACTIVE')
  })

  it('AC-2: tiebreak on identical lastEventAt by highest priority (ms precision, rare in practice)', () => {
    // 完全同一 lastEventAt の複数 session は priority で比較（ms精度なので実運用ではほぼ発生しない）。
    const timestamp = toEpochMs(NOW - 60_000)
    const rep = rollup.rollup([
      entry('ACTIVE', 0, timestamp),
      entry('APPROVAL_WAIT', 0, timestamp),
      entry('NEXT_WAIT', 0, timestamp),
    ])
    expect(rep.display).toBe('APPROVAL_WAIT')
  })

  it('AC-4 regression: 15min boundary cases now use recency, not threshold-based inclusion', () => {
    // release-7 では 15分ちょうどが境界（ちょうどなら除外）だったが、release-8 は単純に
    // 最新を選ぶので、15分云々は無関係。最新が複数あれば priority で判定する。
    const old = entry('NEXT_WAIT', 0, toEpochMs(NOW - 20 * 60_000)) // 20分前（明らかに古い）
    const recent = entry('ACTIVE', 0, toEpochMs(NOW - 3_000)) // 3秒前（圧倒的に新しい）
    expect(rollup.rollup([old, recent]).display).toBe('ACTIVE')
  })

  it('AC-5 regression: same lastEventAt multiple sessions use priority as tiebreaker', () => {
    const same = toEpochMs(NOW - 60_000)
    const rep = rollup.rollup([entry('NEXT_WAIT', 5000, same), entry('APPROVAL_WAIT', 1000, same)])
    // lastEventAt が同じなので priority で比較 → approval_wait が高優先度
    expect(rep.display).toBe('APPROVAL_WAIT')
  })

  it('§0.5 invariant holds even under recency-first: a freshest closed session never hides an older live one', () => {
    // closed の lastEventAt がどれだけ新しくても、他に live な (非 closed) session が
    // 1つでもあれば代表にはなれない。recency 優先化は live な session 同士の比較にのみ働く。
    const olderActive = entry('ACTIVE', 0, toEpochMs(NOW - 10 * 60_000)) // 10分前
    const freshestClosed = entry('CLOSED', 0, toEpochMs(NOW - 1_000)) // 1秒前
    expect(rollup.rollup([olderActive, freshestClosed]).display).toBe('ACTIVE')
    expect(rollup.rollup([freshestClosed, olderActive]).display).toBe('ACTIVE')
  })

  it('closed becomes the representative only when every session in the instance is closed', () => {
    const olderClosed = entry('CLOSED', 0, toEpochMs(NOW - 10 * 60_000))
    const fresherClosed = entry('CLOSED', 0, toEpochMs(NOW - 1_000))
    expect(rollup.rollup([olderClosed, fresherClosed]).display).toBe('CLOSED')
  })
})

describe('InstanceStatusRollup.rollup — orphaned (zombie) live session exclusion (release-19 FR-01, B9)', () => {
  it('AC-4: a truly ACTIVE (non-stale) session is never excluded, even with a fresher CLOSED sibling (B8 invariant)', () => {
    // ACTIVE は isStale===false なので、CLOSED がどれだけ新しくても除外対象にならない。
    const olderActive = entry('ACTIVE', 0, toEpochMs(NOW - 10 * 60_000)) // 10分前・非stale
    const freshestClosed = entry('CLOSED', 0, toEpochMs(NOW - 1_000)) // 1秒前
    expect(rollup.rollup([olderActive, freshestClosed]).display).toBe('ACTIVE')
    expect(rollup.rollup([freshestClosed, olderActive]).display).toBe('ACTIVE')
  })

  it('AC-1/AC-2 (B9 repro & fix): a STALE live session older than the latest CLOSED is excluded as orphaned, so the latest CLOSED becomes representative', () => {
    // B9 再現: 異常終了で CLOSED になれなかった孤立 session が放置(STALE)閾値を超えて残り、
    // 別 session が正常終了(CLOSED)した直後もこの孤立 STALE が代表を乗っ取っていた。
    const orphanedStale = entry('STALE', 0, toEpochMs(NOW - 10 * 60_000)) // 10分前・STALE
    const latestClosed = entry('CLOSED', 0, toEpochMs(NOW - 1_000)) // 1秒前
    const rep = rollup.rollup([orphanedStale, latestClosed])
    expect(rep.display).toBe('CLOSED')
    // instance-status-service.ts:173 の indexOf 逆引き契約: 合成せず入力の status を参照同一で返す。
    expect(rep).toBe(latestClosed.status)
    expect(rollup.rollup([latestClosed, orphanedStale]).display).toBe('CLOSED')
  })

  it('AC-6: with no CLOSED session in the instance at all, orphan exclusion does not apply (out of scope; pure recency as before)', () => {
    // AC-5 のテストと同じ STALE entry を使うが、CLOSED が instance に存在しないため除外は
    // 発動せず、release-8 の recency 優先化どおり「最も新しい lastEventAt」が代表になる。
    const staleButFreshest = entry('STALE', 0, toEpochMs(NOW - 10 * 60_000)) // 10分前
    const olderNextWait = entry('NEXT_WAIT', 0, toEpochMs(NOW - 20 * 60_000)) // 20分前・より古い
    expect(rollup.rollup([staleButFreshest, olderNextWait]).display).toBe('STALE')
    expect(rollup.rollup([olderNextWait, staleButFreshest]).display).toBe('STALE')
  })
})
