import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config/config.js'
import { resolvePaths, type MonomiPaths } from '../config/paths.js'
import { normalizeEndpointUrl, runChildPair, runHubPair } from './pairing-client.js'

let tmpDir: string
let paths: MonomiPaths
let logs: string[]

const log = (message: string): void => {
  logs.push(message)
}

/** JSON レスポンスを組み立てる（undici の global Response を使う）。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 接続不能（fetch 自体が reject）をシミュレートする。 */
function connectionRefused(): never {
  throw new TypeError('fetch failed')
}

/** テスト用 fetch のシグネチャ（mock.calls の tuple 型を (url, init) に固定するため）。 */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** 型付き fetch モックを作る（`vi.fn(impl)` の calls を [url, init?] に推論させる）。 */
function mockFetch(impl: FetchImpl): ReturnType<typeof vi.fn<FetchImpl>> {
  return vi.fn(impl)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-pairclient-'))
  paths = resolvePaths(tmpDir)
  fs.mkdirSync(tmpDir, { recursive: true })
  logs = []
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('normalizeEndpointUrl', () => {
  it('adds scheme and default port when missing', () => {
    expect(normalizeEndpointUrl('192.168.1.100', 47632)).toBe('http://192.168.1.100:47632')
  })
  it('keeps an explicit port', () => {
    expect(normalizeEndpointUrl('192.168.1.100:9000', 47632)).toBe('http://192.168.1.100:9000')
  })
  it('accepts a full URL and strips any path', () => {
    expect(normalizeEndpointUrl('http://host:8080/foo', 47632)).toBe('http://host:8080')
  })
})

describe('runHubPair', () => {
  it('prints the code, ttl and Tailscale-first candidate URLs (FR-02b / AC-1)', async () => {
    const fetchImpl = mockFetch(async (input) => {
      expect(String(input)).toBe('http://127.0.0.1:47632/api/v1/pair/start')
      return jsonResponse(200, {
        code: '482913',
        expires_at: '2026-07-02T00:05:00.000Z',
        ttl_seconds: 300,
      })
    })
    await runHubPair({
      paths,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      network: {
        networkInterfaces: () => ({
          en0: [
            {
              address: '192.168.1.100',
              family: 'IPv4',
              internal: false,
              netmask: '255.255.255.0',
              mac: '00:00:00:00:00:00',
              cidr: '192.168.1.100/24',
            } as os.NetworkInterfaceInfo,
          ],
          utun1: [
            {
              address: '100.69.239.59',
              family: 'IPv4',
              internal: false,
              netmask: '255.255.255.0',
              mac: '00:00:00:00:00:00',
              cidr: '100.69.239.59/24',
            } as os.NetworkInterfaceInfo,
          ],
        }),
        tailscaleIp: () => null,
      },
      log,
    })
    const output = logs.join('\n')
    expect(output).toContain('482913')
    expect(output).toContain('5 minutes')
    expect(output).toContain('monomi pair --code 482913 --hub http://100.69.239.59:47632')
    expect(output).toContain('monomi pair --code 482913 --hub http://192.168.1.100:47632')
    // Tailscale が LAN より前に出ること。
    expect(output.indexOf('100.69.239.59')).toBeLessThan(output.indexOf('192.168.1.100'))
  })

  it('errors with a "is it running" hint when the local hub is unreachable', async () => {
    const fetchImpl = mockFetch(async () => connectionRefused())
    await expect(
      runHubPair({ paths, fetchImpl: fetchImpl as unknown as typeof fetch, log })
    ).rejects.toThrow(/could not reach the local hub/)
  })
})

describe('runChildPair', () => {
  /** hub_endpoints と device_id を持つ config を tmp に用意する。 */
  function writeChildConfig(endpoints: string[], deviceId?: string): void {
    const lines = ['role: child', 'hub_endpoints:']
    for (const e of endpoints) {
      lines.push(`  - ${e}`)
    }
    if (deviceId !== undefined) {
      lines.push(`device_id: ${deviceId}`)
    }
    fs.writeFileSync(paths.configFile, `${lines.join('\n')}\n`, 'utf8')
  }

  it('tries endpoints in order, claims on the first reachable, and saves token + config (AC-3)', async () => {
    writeChildConfig(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'], 'macbook')
    const fetchImpl = mockFetch(async (input) => {
      const url = String(input)
      if (url.startsWith('http://100.64.1.2:47632')) {
        return connectionRefused()
      }
      return jsonResponse(200, { token: 'tok-abc', device_id: 'macbook', role: 'child' })
    })

    await runChildPair(
      { code: '482913', hub: [] },
      {
        paths,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        hostname: () => 'macbook.local',
        log,
      }
    )

    // token は 600 で保存され、内容は claim レスポンスの token。
    expect(fs.readFileSync(paths.tokenFile, 'utf8')).toBe('tok-abc')
    expect(fs.statSync(paths.tokenFile).mode & 0o777).toBe(0o600)

    // config は role:child / 両 endpoint / device_id を保持。
    const config = loadConfig(paths)
    expect(config.role).toBe('child')
    expect(config.deviceId).toBe('macbook')
    expect(config.hubEndpoints).toEqual(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'])

    // 申告 payload の device_id/name を確認（既存 config の device_id を使う）。
    const claimCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('192.168.1.100'))
    const body = JSON.parse((claimCall?.[1] as RequestInit).body as string)
    expect(body).toEqual({ code: '482913', device_id: 'macbook', name: 'macbook.local' })
  })

  it('stops immediately on an authoritative hub rejection and does not try other endpoints (AC-5)', async () => {
    writeChildConfig(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'], 'macbook')
    const fetchImpl = mockFetch(async () =>
      jsonResponse(400, { error: 'code_expired', message: 'pairing code has expired' })
    )

    await expect(
      runChildPair(
        { code: '482913', hub: [] },
        { paths, fetchImpl: fetchImpl as unknown as typeof fetch, log }
      )
    ).rejects.toThrow(/code_expired/)

    // 最初の到達で確定的に失敗 → 2 つ目は試さない。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(paths.tokenFile)).toBe(false)
  })

  it('fails listing every tried URL when all endpoints are unreachable (FR-05 AC-2)', async () => {
    writeChildConfig(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'], 'macbook')
    const fetchImpl = mockFetch(async () => connectionRefused())

    await expect(
      runChildPair(
        { code: '482913', hub: [] },
        { paths, fetchImpl: fetchImpl as unknown as typeof fetch, log }
      )
    ).rejects.toThrow(/could not reach any hub endpoint[\s\S]*100\.64\.1\.2[\s\S]*192\.168\.1\.100/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(paths.tokenFile)).toBe(false)
  })

  it('errors when there is no endpoint to try (empty --hub array and no config)', async () => {
    await expect(
      runChildPair(
        { code: '482913', hub: [] },
        { paths, fetchImpl: vi.fn() as unknown as typeof fetch, log }
      )
    ).rejects.toThrow(/no hub endpoint/)
  })

  it('uses --hub as the highest-priority endpoint, normalizes it, and derives device_id from hostname', async () => {
    // config 無し → device_id は hostname 由来、endpoints は --hub のみ。
    const fetchImpl = mockFetch(async () =>
      jsonResponse(200, { token: 'tok-xyz', device_id: 'mymac', role: 'child' })
    )

    await runChildPair(
      { code: '111111', hub: ['10.0.0.5'] },
      { paths, fetchImpl: fetchImpl as unknown as typeof fetch, hostname: () => 'MyMac.local', log }
    )

    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://10.0.0.5:47632/api/v1/pair/claim')
    const config = loadConfig(paths)
    expect(config.role).toBe('child')
    expect(config.deviceId).toBe('mymac')
    expect(config.hubEndpoints).toEqual(['http://10.0.0.5:47632'])
    expect(fs.readFileSync(paths.tokenFile, 'utf8')).toBe('tok-xyz')
  })

  it('puts --hub before existing config endpoints and de-duplicates on persist', async () => {
    writeChildConfig(['http://192.168.1.100:47632'], 'macbook')
    const fetchImpl = mockFetch(async () =>
      jsonResponse(200, { token: 'tok-1', device_id: 'macbook', role: 'child' })
    )

    await runChildPair(
      { code: '222222', hub: ['http://100.64.1.2:47632'] },
      { paths, fetchImpl: fetchImpl as unknown as typeof fetch, log }
    )

    const config = loadConfig(paths)
    expect(config.hubEndpoints).toEqual(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'])
  })

  it('normalizes a scheme-less config hub_endpoints value the same way as --hub (#2)', async () => {
    // config の hub_endpoints に scheme 無しの値（host:port のみ）を書いておく。
    writeChildConfig(['192.168.1.100:47632'], 'macbook')
    const fetchImpl = mockFetch(async () =>
      jsonResponse(200, { token: 'tok-cfg', device_id: 'macbook', role: 'child' })
    )

    await runChildPair(
      { code: '444444', hub: [] },
      { paths, fetchImpl: fetchImpl as unknown as typeof fetch, log }
    )

    // claim は http:// を補った正規化後の URL に送られる。
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://192.168.1.100:47632/api/v1/pair/claim')

    // config への書き戻しも正規化済み（http:// 付き）になる。
    const config = loadConfig(paths)
    expect(config.hubEndpoints).toEqual(['http://192.168.1.100:47632'])
  })

  it('accepts multiple --hub values, tries them in CLI order ahead of config endpoints (#4)', async () => {
    writeChildConfig(['http://192.168.1.100:47632'], 'macbook')
    const fetchImpl = mockFetch(async (input) => {
      const url = String(input)
      if (url.startsWith('http://10.0.0.1:47632')) {
        return connectionRefused()
      }
      return jsonResponse(200, { token: 'tok-multi', device_id: 'macbook', role: 'child' })
    })

    await runChildPair(
      { code: '333333', hub: ['10.0.0.1', '10.0.0.2:9000'] },
      { paths, fetchImpl: fetchImpl as unknown as typeof fetch, log }
    )

    // 到達順序: --hub の1件目 → --hub の2件目 → 既存 config の順。
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      'http://10.0.0.1:47632/api/v1/pair/claim',
      'http://10.0.0.2:9000/api/v1/pair/claim',
    ])
    const config = loadConfig(paths)
    expect(config.hubEndpoints).toEqual([
      'http://10.0.0.1:47632',
      'http://10.0.0.2:9000',
      'http://192.168.1.100:47632',
    ])
  })
})
