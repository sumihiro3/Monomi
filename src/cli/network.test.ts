import type os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { buildCandidateUrls, detectReachableHosts, isTailscaleIpv4 } from './network.js'

/** テスト用に `os.networkInterfaces()` の戻り値を組み立てる。 */
function iface(
  address: string,
  opts: { internal?: boolean; family?: 'IPv4' | 'IPv6' } = {}
): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: opts.family ?? 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: opts.internal ?? false,
    cidr: `${address}/24`,
  } as os.NetworkInterfaceInfo
}

describe('isTailscaleIpv4', () => {
  it.each([
    '100.64.0.0',
    '100.69.239.59',
    '100.127.255.255',
  ])('accepts %s inside 100.64.0.0/10', (addr) => {
    expect(isTailscaleIpv4(addr)).toBe(true)
  })

  it.each([
    '100.63.0.1',
    '100.128.0.1',
    '192.168.1.100',
    '10.0.0.1',
    'not-an-ip',
  ])('rejects %s outside the CGNAT range', (addr) => {
    expect(isTailscaleIpv4(addr)).toBe(false)
  })
})

describe('detectReachableHosts', () => {
  it('classifies Tailscale first, then LAN, skipping loopback and IPv6', () => {
    const networkInterfaces = vi.fn(() => ({
      lo0: [
        iface('127.0.0.1', { internal: true }),
        iface('::1', { internal: true, family: 'IPv6' }),
      ],
      en0: [iface('192.168.1.100'), iface('fe80::1', { family: 'IPv6' })],
      utun1: [iface('100.69.239.59')],
    }))
    const result = detectReachableHosts({ networkInterfaces, tailscaleIp: () => null })
    expect(result).toEqual([
      { host: '100.69.239.59', label: 'tailscale' },
      { host: '192.168.1.100', label: 'lan' },
    ])
  })

  it('de-duplicates repeated addresses across interfaces', () => {
    const networkInterfaces = vi.fn(() => ({
      en0: [iface('192.168.1.100')],
      en1: [iface('192.168.1.100')],
    }))
    const result = detectReachableHosts({ networkInterfaces, tailscaleIp: () => null })
    expect(result).toEqual([{ host: '192.168.1.100', label: 'lan' }])
  })

  it('falls back to `tailscale ip -4` only when no CGNAT interface is present', () => {
    const networkInterfaces = vi.fn(() => ({ en0: [iface('192.168.1.100')] }))
    const tailscaleIp = vi.fn(() => ['100.100.100.100'])
    const result = detectReachableHosts({ networkInterfaces, tailscaleIp })
    expect(tailscaleIp).toHaveBeenCalledTimes(1)
    expect(result).toEqual([
      { host: '100.100.100.100', label: 'tailscale' },
      { host: '192.168.1.100', label: 'lan' },
    ])
  })

  it('does not invoke the tailscale fallback when a CGNAT interface already exists', () => {
    const networkInterfaces = vi.fn(() => ({ utun1: [iface('100.69.239.59')] }))
    const tailscaleIp = vi.fn(() => ['100.100.100.100'])
    detectReachableHosts({ networkInterfaces, tailscaleIp })
    expect(tailscaleIp).not.toHaveBeenCalled()
  })

  it('returns an empty list when only loopback exists', () => {
    const networkInterfaces = vi.fn(() => ({
      lo0: [iface('127.0.0.1', { internal: true })],
    }))
    expect(detectReachableHosts({ networkInterfaces, tailscaleIp: () => null })).toEqual([])
  })
})

describe('buildCandidateUrls', () => {
  it('formats detected hosts as http://host:port preserving order', () => {
    const networkInterfaces = vi.fn(() => ({
      en0: [iface('192.168.1.100')],
      utun1: [iface('100.69.239.59')],
    }))
    expect(buildCandidateUrls(47632, { networkInterfaces, tailscaleIp: () => null })).toEqual([
      'http://100.69.239.59:47632',
      'http://192.168.1.100:47632',
    ])
  })
})
