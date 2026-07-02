import { describe, expect, it } from 'vitest'
import { epochMsNow, toDurationMs, toEpochMs } from './time.js'

describe('toEpochMs / toDurationMs', () => {
  it('brand a plain number without changing its runtime value', () => {
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(toDurationMs(7_200_000)).toBe(7_200_000)
  })

  it('still behave like plain numbers for arithmetic (branding is compile-time only)', () => {
    const start = toEpochMs(1_000)
    const elapsed = toDurationMs(500)
    expect(start + elapsed).toBe(1_500)
  })
})

describe('epochMsNow', () => {
  it('returns the current time as an EpochMs', () => {
    const before = Date.now()
    const now = epochMsNow()
    const after = Date.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(after)
  })
})
