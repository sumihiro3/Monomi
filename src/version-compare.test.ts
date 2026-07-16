import { describe, expect, it } from 'vitest'
import { compareVersion } from './version-compare.js'

describe('compareVersion', () => {
  it('returns "older" when other is a lower patch version', () => {
    expect(compareVersion('0.1.0', '0.2.0')).toBe('older')
  })

  it('returns "older" when other is a lower minor version', () => {
    expect(compareVersion('0.1.9', '0.2.0')).toBe('older')
  })

  it('returns "older" when other is a lower major version', () => {
    expect(compareVersion('1.9.9', '2.0.0')).toBe('older')
  })

  it('returns "same" when both versions are equal', () => {
    expect(compareVersion('0.2.0', '0.2.0')).toBe('same')
  })

  it('returns "newer" when other is a higher version', () => {
    expect(compareVersion('0.3.0', '0.2.0')).toBe('newer')
  })

  it('tolerates a leading "v" on both sides', () => {
    expect(compareVersion('v0.2.0', 'v0.2.0')).toBe('same')
    expect(compareVersion('v0.1.0', 'v0.2.0')).toBe('older')
    expect(compareVersion('v0.3.0', 'v0.2.0')).toBe('newer')
  })

  it('ignores prerelease/build metadata suffixes', () => {
    expect(compareVersion('0.2.0-nightly20260101', '0.2.0')).toBe('same')
    expect(compareVersion('0.1.0-beta.1', '0.2.0')).toBe('older')
  })

  it('returns "unknown" when other is undefined', () => {
    expect(compareVersion(undefined, '0.2.0')).toBe('unknown')
  })

  it('returns "unknown" when other is an empty string', () => {
    expect(compareVersion('', '0.2.0')).toBe('unknown')
  })

  it('returns "unknown" when other is a non-numeric string', () => {
    expect(compareVersion('not-a-version', '0.2.0')).toBe('unknown')
  })

  it('returns "unknown" when self is unparseable, even if other is valid', () => {
    expect(compareVersion('0.2.0', 'not-a-version')).toBe('unknown')
  })

  it('defaults self to MONOMI_VERSION when omitted', async () => {
    const { MONOMI_VERSION } = await import('./version.js')
    expect(compareVersion(MONOMI_VERSION)).toBe('same')
  })
})
