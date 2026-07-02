import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePaths, type MonomiPaths } from '../config/paths.js'
import { createHubApiClient } from './hub-api-client.js'

let tmpDir: string
let paths: MonomiPaths

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

/** 型付き fetch モックを作る。 */
function mockFetch(impl: FetchImpl): ReturnType<typeof vi.fn<FetchImpl>> {
  return vi.fn(impl)
}

/** hub_endpoints ブロックシーケンス付きの child config を tmp に書く。 */
function writeChildConfig(endpoints: string[]): void {
  const lines = ['role: child', 'hub_endpoints:', ...endpoints.map((e) => `  - ${e}`)]
  fs.writeFileSync(paths.configFile, `${lines.join('\n')}\n`, 'utf8')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-hubclient-'))
  paths = resolvePaths(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('createHubApiClient', () => {
  it('probes config.hub_endpoints in order and wires the client to the first reachable (FR-05 AC-1)', async () => {
    writeChildConfig(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'])
    fs.writeFileSync(paths.tokenFile, 'tok-child', 'utf8')

    const fetchImpl = mockFetch(async (input) => {
      const url = String(input)
      if (url.startsWith('http://100.64.1.2:47632')) {
        // Tailscale 候補は不達。
        return connectionRefused()
      }
      return jsonResponse(200, { generated_at: '2026-07-02T00:00:00.000Z', instances: [] })
    })

    const client = await createHubApiClient(paths, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await client.listInstances()

    // 優先順で tailscale → lan を試行し、到達した lan へ配線される。
    expect(String(fetchImpl.mock.calls[0][0])).toContain('100.64.1.2')
    // 実リクエスト（listInstances）は到達した lan に Bearer 付きで飛ぶ。
    const authedCall = fetchImpl.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.headers !== undefined
    )
    expect(String(authedCall?.[0])).toBe('http://192.168.1.100:47632/api/v1/instances')
    expect((authedCall?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer tok-child',
    })
  })

  it('throws with every tried URL when all hub_endpoints are unreachable (FR-05 AC-2)', async () => {
    writeChildConfig(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'])
    fs.writeFileSync(paths.tokenFile, 'tok-child', 'utf8')
    const fetchImpl = mockFetch(async () => connectionRefused())

    await expect(
      createHubApiClient(paths, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(
      /could not reach any hub endpoint[\s\S]*100\.64\.1\.2:47632[\s\S]*192\.168\.1\.100:47632/
    )
  })

  it('falls back to localhost for the hub role (management commands hit the local hub)', async () => {
    fs.writeFileSync(paths.configFile, 'role: hub\nport: 47632\n', 'utf8')
    fs.writeFileSync(paths.tokenFile, 'tok-hub', 'utf8')
    const fetchImpl = mockFetch(async () =>
      jsonResponse(200, { generated_at: '2026-07-02T00:00:00.000Z', instances: [] })
    )

    const client = await createHubApiClient(paths, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await client.listInstances()

    expect(String(fetchImpl.mock.calls[0][0])).toContain('http://127.0.0.1:47632')
  })

  it('fails clearly when the local token is missing (before any probe)', async () => {
    writeChildConfig(['http://192.168.1.100:47632'])
    const fetchImpl = mockFetch(async () => jsonResponse(200, {}))

    await expect(
      createHubApiClient(paths, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/token not found/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
