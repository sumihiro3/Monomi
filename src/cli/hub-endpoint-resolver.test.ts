import { describe, expect, it, vi } from 'vitest'
import {
  endpointBaseUrl,
  HubEndpointResolver,
  localhostEndpoint,
  parseHubEndpoint,
  type HubEndpoint,
} from './hub-endpoint-resolver.js'

/** テスト用 fetch のシグネチャ（mock.calls の tuple 型を (url, init) に固定するため）。 */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** 型付き fetch モックを作る（`vi.fn(impl)` の calls を [url, init?] に推論させる）。 */
function mockFetch(impl: FetchImpl): ReturnType<typeof vi.fn<FetchImpl>> {
  return vi.fn(impl)
}

/** 接続不能（fetch 自体が reject）をシミュレートする。 */
function connectionRefused(): never {
  throw new TypeError('fetch failed')
}

const TAILSCALE: HubEndpoint = { host: '100.64.1.2', port: 47632, label: 'tailscale' }
const LAN: HubEndpoint = { host: '192.168.1.100', port: 47632, label: 'lan' }

describe('endpointBaseUrl', () => {
  it('builds http://host:port', () => {
    expect(endpointBaseUrl(LAN)).toBe('http://192.168.1.100:47632')
  })
})

describe('localhostEndpoint', () => {
  it('points at 127.0.0.1 with a localhost label', () => {
    expect(localhostEndpoint(47632)).toEqual({ host: '127.0.0.1', port: 47632, label: 'localhost' })
  })
})

describe('parseHubEndpoint', () => {
  it('parses host:port and classifies a Tailscale IP', () => {
    expect(parseHubEndpoint('http://100.64.1.2:47632', 47632)).toEqual(TAILSCALE)
  })

  it('classifies a private LAN IP as lan', () => {
    expect(parseHubEndpoint('http://192.168.1.100:47632', 47632)).toEqual(LAN)
  })

  it('adds the scheme and default port when missing', () => {
    expect(parseHubEndpoint('192.168.1.100', 47632)).toEqual(LAN)
  })

  it('keeps an explicit port over the default', () => {
    expect(parseHubEndpoint('http://192.168.1.100:9000', 47632)).toEqual({
      host: '192.168.1.100',
      port: 9000,
      label: 'lan',
    })
  })

  it('throws on an unparseable value', () => {
    expect(() => parseHubEndpoint('http://', 47632)).toThrow(/invalid hub endpoint/)
  })
})

describe('HubEndpointResolver.resolveReachable', () => {
  const resolver = new HubEndpointResolver()

  it('returns the first endpoint when it is reachable and does not probe the rest (FR-05 AC-1)', async () => {
    const fetchImpl = mockFetch(async () => new Response('{}', { status: 200 }))
    const chosen = await resolver.resolveReachable([TAILSCALE, LAN], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(chosen).toEqual(TAILSCALE)
    // 先頭が到達したので 2 つ目は試さない（短絡）。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://100.64.1.2:47632/api/v1/instances')
  })

  it('skips unreachable candidates and returns the first that responds, in order (FR-05 AC-1)', async () => {
    const fetchImpl = mockFetch(async (input) => {
      if (String(input).startsWith('http://100.64.1.2:47632')) {
        return connectionRefused()
      }
      return new Response('{}', { status: 200 })
    })
    const chosen = await resolver.resolveReachable([TAILSCALE, LAN], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(chosen).toEqual(LAN)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    // 優先順（tailscale → lan）で試行されている。
    expect(String(fetchImpl.mock.calls[0][0])).toContain('100.64.1.2')
    expect(String(fetchImpl.mock.calls[1][0])).toContain('192.168.1.100')
  })

  it('treats any HTTP response (even 401) as reachable', async () => {
    const fetchImpl = mockFetch(async () => new Response('unauthorized', { status: 401 }))
    const chosen = await resolver.resolveReachable([LAN], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(chosen).toEqual(LAN)
  })

  it('throws with every tried candidate URL when all are unreachable (FR-05 AC-2)', async () => {
    const fetchImpl = mockFetch(async () => connectionRefused())
    await expect(
      resolver.resolveReachable([TAILSCALE, LAN], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(
      /could not reach any hub endpoint[\s\S]*100\.64\.1\.2:47632[\s\S]*192\.168\.1\.100:47632/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('throws when no endpoint is configured', async () => {
    await expect(resolver.resolveReachable([])).rejects.toThrow(/no hub endpoint configured/)
  })

  it('honours a custom probe path and attaches an abort signal', async () => {
    const fetchImpl = mockFetch(async () => new Response('{}', { status: 200 }))
    await resolver.resolveReachable([LAN], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probePath: '/healthz',
    })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://192.168.1.100:47632/healthz')
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
