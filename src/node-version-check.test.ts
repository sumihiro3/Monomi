import { describe, expect, it } from 'vitest'
import {
  compareVersionTriples,
  isNodeVersionSupported,
  parseMinimumNodeRange,
  parseVersionTriple,
} from './node-version-check.js'

describe('parseVersionTriple', () => {
  it('parses a plain X.Y.Z string', () => {
    expect(parseVersionTriple('22.5.0')).toEqual([22, 5, 0])
  })

  it('ignores a leading "v"', () => {
    expect(parseVersionTriple('v20.10.1')).toEqual([20, 10, 1])
  })

  it('ignores prerelease/build metadata suffixes', () => {
    expect(parseVersionTriple('24.0.0-nightly20260101')).toEqual([24, 0, 0])
  })

  it('returns null for an unparseable string', () => {
    expect(parseVersionTriple('not-a-version')).toBeNull()
  })
})

describe('parseMinimumNodeRange', () => {
  it('parses a ">=X.Y.Z" range', () => {
    expect(parseMinimumNodeRange('>=22.5.0')).toEqual([22, 5, 0])
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseMinimumNodeRange('  >=22.5.0  ')).toEqual([22, 5, 0])
  })

  it('returns null for a range without a ">=" operator', () => {
    expect(parseMinimumNodeRange('^22.5.0')).toBeNull()
  })
})

describe('compareVersionTriples', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersionTriples([22, 5, 0], [22, 5, 0])).toBe(0)
  })

  it('returns a positive number when the first is greater (major)', () => {
    expect(compareVersionTriples([24, 0, 0], [22, 5, 0])).toBeGreaterThan(0)
  })

  it('returns a negative number when the first is smaller (minor)', () => {
    expect(compareVersionTriples([22, 4, 9], [22, 5, 0])).toBeLessThan(0)
  })

  it('compares patch when major/minor are equal', () => {
    expect(compareVersionTriples([22, 5, 1], [22, 5, 0])).toBeGreaterThan(0)
    expect(compareVersionTriples([22, 5, 0], [22, 5, 1])).toBeLessThan(0)
  })
})

// AC-1: 下限未満・境界値・下限以上を網羅する。
describe('isNodeVersionSupported (AC-1)', () => {
  const MINIMUM_RANGE = '>=22.5.0'

  it('rejects a major version below the minimum (e.g. v20.x)', () => {
    expect(isNodeVersionSupported('20.18.0', MINIMUM_RANGE)).toBe(false)
  })

  it('rejects the same major but a lower minor version', () => {
    expect(isNodeVersionSupported('22.4.9', MINIMUM_RANGE)).toBe(false)
  })

  it('accepts the exact boundary version', () => {
    expect(isNodeVersionSupported('22.5.0', MINIMUM_RANGE)).toBe(true)
  })

  it('accepts a patch version above the boundary', () => {
    expect(isNodeVersionSupported('22.5.1', MINIMUM_RANGE)).toBe(true)
  })

  it('accepts a later major version (e.g. v24.x)', () => {
    expect(isNodeVersionSupported('24.3.0', MINIMUM_RANGE)).toBe(true)
  })

  it('tolerates a leading "v" in the current version', () => {
    expect(isNodeVersionSupported('v22.5.0', MINIMUM_RANGE)).toBe(true)
  })

  it('treats an unparseable current version as unsupported', () => {
    expect(isNodeVersionSupported('not-a-version', MINIMUM_RANGE)).toBe(false)
  })

  it('treats an unparseable minimum range as unsupported', () => {
    expect(isNodeVersionSupported('24.0.0', '^22.5.0')).toBe(false)
  })
})
