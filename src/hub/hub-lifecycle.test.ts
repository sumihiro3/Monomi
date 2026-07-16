import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MonomiPaths, resolvePaths } from '../config/paths.js'
import {
  hubStatus,
  hubStop,
  isPortReachable,
  isProcessAlive,
  probeHub,
  readHubPidFile,
  removeHubPidFile,
  writeHubPidFile,
} from './hub-lifecycle.js'

/** テスト用 fetch のシグネチャ（mock.calls の tuple 型を (url, init) に固定するため）。 */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** 型付き fetch モックを作る（`vi.fn(impl)` の calls を [url, init?] に推論させる）。 */
function mockFetch(impl: FetchImpl): ReturnType<typeof vi.fn<FetchImpl>> {
  return vi.fn(impl)
}

let tmpDir: string
let paths: MonomiPaths

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-hub-lifecycle-'))
  paths = resolvePaths(tmpDir)
  fs.mkdirSync(paths.home, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('pid file round trip', () => {
  it('writes and reads back the pid unchanged', () => {
    writeHubPidFile(paths, 4242)
    expect(readHubPidFile(paths)).toBe(4242)
  })

  it('returns undefined when the pid file does not exist', () => {
    expect(readHubPidFile(paths)).toBeUndefined()
  })

  it('returns undefined for garbage (non-numeric) content instead of throwing', () => {
    fs.writeFileSync(paths.hubPidFile, 'not-a-pid')
    expect(readHubPidFile(paths)).toBeUndefined()
  })

  it('returns undefined for an empty/whitespace-only pid file', () => {
    fs.writeFileSync(paths.hubPidFile, '   \n')
    expect(readHubPidFile(paths)).toBeUndefined()
  })

  it('overwrites an existing pid file unconditionally (stale pid self-recovery)', () => {
    writeHubPidFile(paths, 111)
    writeHubPidFile(paths, 222)
    expect(readHubPidFile(paths)).toBe(222)
  })

  it('removeHubPidFile deletes the file and is a no-op when already absent', () => {
    writeHubPidFile(paths, 4242)
    removeHubPidFile(paths)
    expect(fs.existsSync(paths.hubPidFile)).toBe(false)
    expect(() => removeHubPidFile(paths)).not.toThrow()
  })
})

describe('isProcessAlive', () => {
  it('reports the current process as alive using the real process.kill(pid, 0)', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('returns true when kill(pid, 0) does not throw', () => {
    const kill = vi.fn() as unknown as typeof process.kill
    expect(isProcessAlive(4242, { kill })).toBe(true)
    expect(kill).toHaveBeenCalledWith(4242, 0)
  })

  it('returns false when kill throws ESRCH (no such process, NFR: no un-verified kill)', () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }) as unknown as typeof process.kill
    expect(isProcessAlive(4242, { kill })).toBe(false)
  })

  it('returns true when kill throws EPERM (process exists under a different owner)', () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    }) as unknown as typeof process.kill
    expect(isProcessAlive(4242, { kill })).toBe(true)
  })
})

describe('probeHub (FR-01 AC-4: reads X-Monomi-Hub-Version, undefined when missing)', () => {
  it('reports reachable:true and reads the version header when present', async () => {
    const fetchImpl = mockFetch(
      async () => new Response('{}', { status: 200, headers: { 'X-Monomi-Hub-Version': '0.3.0' } })
    )
    await expect(
      probeHub(47632, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toEqual({ reachable: true, version: '0.3.0' })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:47632/api/v1/instances')
  })

  it('reports reachable:true with version undefined when the header is missing (version unknown)', async () => {
    const fetchImpl = mockFetch(async () => new Response('{}', { status: 200 }))
    await expect(
      probeHub(47632, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toEqual({ reachable: true, version: undefined })
  })

  it('still reads the version header on a non-2xx response (401 is "reachable" too)', async () => {
    const fetchImpl = mockFetch(
      async () =>
        new Response('unauthorized', {
          status: 401,
          headers: { 'X-Monomi-Hub-Version': '0.3.0' },
        })
    )
    await expect(
      probeHub(47632, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toEqual({ reachable: true, version: '0.3.0' })
  })

  it('returns reachable:false and no version when fetch rejects (connection refused / timeout)', async () => {
    const fetchImpl = mockFetch(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(
      probeHub(47632, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toEqual({ reachable: false })
  })

  it('honours a custom probe path', async () => {
    const fetchImpl = mockFetch(async () => new Response('{}', { status: 200 }))
    await probeHub(47632, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probePath: '/healthz',
    })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:47632/healthz')
  })
})

describe('isPortReachable (thin wrapper over probeHub, reachability only)', () => {
  it('treats any HTTP response (even 401) as reachable', async () => {
    const fetchImpl = mockFetch(async () => new Response('unauthorized', { status: 401 }))
    await expect(
      isPortReachable(47632, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toBe(true)
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:47632/api/v1/instances')
  })

  it('returns false when fetch rejects (connection refused / timeout)', async () => {
    const fetchImpl = mockFetch(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(
      isPortReachable(47632, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toBe(false)
  })

  it('honours a custom probe path', async () => {
    const fetchImpl = mockFetch(async () => new Response('{}', { status: 200 }))
    await isPortReachable(47632, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probePath: '/healthz',
    })
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:47632/healthz')
  })
})

describe('hubStatus (FR-02 AC-1: 3-state discrimination / FR-01 AC-3・AC-4: hubVersion)', () => {
  it('reports "running" with pid+port+hubVersion when the pid file matches a live process and the port answers with a version', async () => {
    writeHubPidFile(paths, 4242)
    const result = await hubStatus(paths, 47632, {
      isAlive: (pid) => pid === 4242,
      probe: async () => ({ reachable: true, version: '0.3.0' }),
    })
    expect(result).toEqual({ state: 'running', pid: 4242, port: 47632, hubVersion: '0.3.0' })
  })

  it('reports "running" with hubVersion undefined when the port answers but the version header is missing (version unknown, AC-4)', async () => {
    writeHubPidFile(paths, 4242)
    const result = await hubStatus(paths, 47632, {
      isAlive: (pid) => pid === 4242,
      probe: async () => ({ reachable: true, version: undefined }),
    })
    expect(result).toEqual({ state: 'running', pid: 4242, port: 47632, hubVersion: undefined })
  })

  it('reports "running" without a pid when no pid file exists but the port answers (externally-managed hub, e.g. pm2/launchd)', async () => {
    const result = await hubStatus(paths, 47632, {
      isAlive: () => false,
      probe: async () => ({ reachable: true, version: '0.3.0' }),
    })
    expect(result).toEqual({ state: 'running', pid: undefined, port: 47632, hubVersion: '0.3.0' })
  })

  it('reports "stale" when the pid file exists but the process is no longer alive, regardless of port', async () => {
    writeHubPidFile(paths, 4242)
    const probe = vi.fn(async () => ({ reachable: true, version: '0.3.0' }))
    const result = await hubStatus(paths, 47632, {
      isAlive: () => false,
      probe, // even if something else answers on the port, stale pid wins
    })
    expect(result).toEqual({ state: 'stale', pid: 4242 })
    // stale 判定は port 疎通確認より優先し、疎通確認自体を行わない（余計な HTTP 往復を避ける）。
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports "stopped" when there is no pid file and the port does not answer', async () => {
    const result = await hubStatus(paths, 47632, {
      probe: async () => ({ reachable: false }),
    })
    expect(result).toEqual({ state: 'stopped' })
  })
})

describe('hubStop (FR-02 AC-2: no un-verified kill, no error when already stopped)', () => {
  it('sends SIGTERM only after confirming the pid is alive, polls until dead, then removes the pid file', async () => {
    writeHubPidFile(paths, 4242)
    let aliveCalls = 0
    const isAlive = vi.fn(() => {
      aliveCalls += 1
      // alive for the pre-signal check + the first poll, then reports dead.
      return aliveCalls <= 2
    })
    const sendSignal = vi.fn()
    const sleep = vi.fn(async () => {})

    const result = await hubStop(paths, {
      isAlive,
      sendSignal,
      sleep,
      waitMs: 1000,
      pollIntervalMs: 10,
    })

    expect(sendSignal).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(result).toEqual({ stopped: true, pid: 4242 })
    expect(readHubPidFile(paths)).toBeUndefined()
  })

  it('reports stopped:false and does not send any signal when there is no pid file (no-op)', async () => {
    const sendSignal = vi.fn()
    const result = await hubStop(paths, { sendSignal })
    expect(result).toEqual({ stopped: false, pid: undefined })
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('self-heals a stale pid file: cleans it up without signaling an absent process (no-op)', async () => {
    writeHubPidFile(paths, 4242)
    const sendSignal = vi.fn()
    const result = await hubStop(paths, { isAlive: () => false, sendSignal })
    expect(result).toEqual({ stopped: false, pid: 4242 })
    expect(sendSignal).not.toHaveBeenCalled()
    expect(readHubPidFile(paths)).toBeUndefined()
  })

  it('gives up waiting after waitMs, keeps the pid file, and reports timedOut (process still alive)', async () => {
    writeHubPidFile(paths, 4242)
    const sendSignal = vi.fn()
    const sleep = vi.fn(async () => {})

    const result = await hubStop(paths, {
      isAlive: () => true, // never reports dead
      sendSignal,
      sleep,
      waitMs: 30,
      pollIntervalMs: 10,
    })

    expect(sendSignal).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(result).toEqual({ stopped: false, pid: 4242, timedOut: true })
    // まだ生存中と判断しているため、pid を見失わないよう pid ファイルは削除しない。
    expect(readHubPidFile(paths)).toBe(4242)
  })
})
