import { describe, expect, it } from 'vitest'
import { isLoopbackAddress } from './loopback.js'

/**
 * isLoopbackAddress の単体テスト（FR-02 AC-2 / review #5+#7）。
 *
 * PairController（`pair/start`）と DevicesController（`devices` 管理ルート）の双方が参照する
 * 共有判定ロジックのため、両 controller のテストとは別に判定そのものを直接検証する。
 */
describe('isLoopbackAddress', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.53',
    '127.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
  ])('treats %s as loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(true)
  })

  it.each([
    '203.0.113.7',
    '10.0.0.4',
    '192.168.1.100',
    '::ffff:10.0.0.4',
    '128.0.0.1',
  ])('treats %s as non-loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(false)
  })

  it('treats null (unknown remoteAddress) as non-loopback', () => {
    expect(isLoopbackAddress(null)).toBe(false)
  })
})
