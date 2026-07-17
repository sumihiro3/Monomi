import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePaths } from '../config/paths.js'
import { setActiveLocale, t } from '../i18n/index.js'
import { ensureHubRunning, type HubStopFn, type SpawnFn } from './hub-autostart.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-hub-autostart-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  setActiveLocale('en')
})

/** 型付き spawn モックを作る（実 `child_process.spawn` を呼ばず `unref` だけ持つオブジェクトを返す）。 */
function mockSpawn(unref: () => void = vi.fn()): SpawnFn {
  return vi.fn(() => ({ unref })) as unknown as SpawnFn
}

describe('ensureHubRunning (FR-01)', () => {
  it('AC-1: spawns the hub and waits for it to become reachable before resolving', async () => {
    // クリーン環境（~/.monomi 自体が未作成）を模す。paths.home 自体は存在しない子ディレクトリ。
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    const probeVersion = vi.fn(async () => ({ reachable: false }))
    const isReachable = vi.fn(async () => true)
    const unref = vi.fn()
    const spawn = mockSpawn(unref)
    const sleep = vi.fn(async () => {})

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      isReachable,
      spawn,
      sleep,
      cliEntry: '/fake/dist/bin.js',
      timeoutMs: 1000,
      pollIntervalMs: 100,
    })

    expect(notice).toBeNull()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/fake/dist/bin.js', 'hub'],
      expect.objectContaining({ detached: true })
    )
    // detached spawn は unref してダッシュボード終了後も hub を生存させ、親プロセスの終了を妨げない。
    expect(unref).toHaveBeenCalledTimes(1)
    // 起動完了を待つため、疎通確認の間はリトライ(sleep)する。
    expect(sleep).toHaveBeenCalledTimes(1)
    // クリーン環境から呼ばれても ~/.monomi と hub.log がここで作成される。
    expect(fs.existsSync(paths.hubLogFile)).toBe(true)
  })

  it('AC-2: skips spawn when the hub already answers on the configured port with a matching version', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: '0.2.0' }))
    const hubStop = vi.fn<HubStopFn>()
    const spawn = mockSpawn()

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      spawn,
      hubStop,
      selfVersion: '0.2.0',
    })

    expect(notice).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
    expect(hubStop).not.toHaveBeenCalled()
    expect(probeVersion).toHaveBeenCalledTimes(1)
  })

  it('AC-3: does nothing on role:child (no probe, no spawn)', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: false }))
    const spawn = mockSpawn()
    const hubStop = vi.fn<HubStopFn>()

    const notice = await ensureHubRunning(paths, 'child', 47632, { probeVersion, spawn, hubStop })

    expect(notice).toBeNull()
    expect(probeVersion).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(hubStop).not.toHaveBeenCalled()
  })

  it('AC-4: throws an error referencing hub.log when reachability never succeeds within the timeout', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: false }))
    const isReachable = vi.fn(async () => false)
    const spawn = mockSpawn()
    const sleep = vi.fn(async () => {})

    await expect(
      ensureHubRunning(paths, 'hub', 47632, {
        probeVersion,
        isReachable,
        spawn,
        sleep,
        timeoutMs: 300,
        pollIntervalMs: 100,
      })
    ).rejects.toThrow(paths.hubLogFile)

    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('ensureHubRunning (FR-02: hub version match + auto-restart)', () => {
  it('AC-1: an older hub version is stopped and respawned, returning an update notice', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: '0.1.0' }))
    const hubStop = vi.fn<HubStopFn>(async () => ({ stopped: true, pid: 4242 }))
    const isReachable = vi.fn(async () => true)
    const spawn = mockSpawn()
    const sleep = vi.fn(async () => {})

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      hubStop,
      isReachable,
      spawn,
      sleep,
      selfVersion: '0.2.0',
      autoUpdate: true,
      cliEntry: '/fake/dist/bin.js',
    })

    expect(hubStop).toHaveBeenCalledTimes(1)
    expect(hubStop).toHaveBeenCalledWith(paths)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(notice).toBe(t('autoUpdate.hubRestarted', { hubVersion: '0.1.0', selfVersion: '0.2.0' }))
  })

  it('AC-2: a graceful-stop timeout does not escalate to SIGKILL and returns a warning notice, hub left running', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: '0.1.0' }))
    const hubStop = vi.fn<HubStopFn>(async () => ({ stopped: false, pid: 4242, timedOut: true }))
    const spawn = mockSpawn()

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      hubStop,
      spawn,
      selfVersion: '0.2.0',
      autoUpdate: true,
    })

    expect(hubStop).toHaveBeenCalledTimes(1)
    // SIGKILL エスカレーションはしない — hubStop（graceful のみ）以外の停止手段を一切呼ばない。
    expect(spawn).not.toHaveBeenCalled()
    expect(notice).toBe(t('autoUpdate.restartFailed', { hubVersion: '0.1.0' }))
  })

  it('AC-3: a newer hub version leaves the hub untouched and returns a "CLI outdated" notice', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: '9.9.9' }))
    const hubStop = vi.fn<HubStopFn>()
    const spawn = mockSpawn()

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      hubStop,
      spawn,
      selfVersion: '0.2.0',
      autoUpdate: true,
    })

    expect(hubStop).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(notice).toBe(t('autoUpdate.cliOutdated', { hubVersion: '9.9.9', selfVersion: '0.2.0' }))
  })

  it('AC-4: a matching hub version calls neither stop nor spawn', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: '0.2.0' }))
    const hubStop = vi.fn<HubStopFn>()
    const spawn = mockSpawn()

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      hubStop,
      spawn,
      selfVersion: '0.2.0',
      autoUpdate: true,
    })

    expect(hubStop).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(notice).toBeNull()
  })

  it('AC-5: role:child never probes hub version or restarts, even with a stale-looking setup', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: '0.1.0' }))
    const hubStop = vi.fn<HubStopFn>()
    const spawn = mockSpawn()

    const notice = await ensureHubRunning(paths, 'child', 47632, {
      probeVersion,
      hubStop,
      spawn,
      selfVersion: '0.2.0',
      autoUpdate: true,
    })

    expect(probeVersion).not.toHaveBeenCalled()
    expect(hubStop).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(notice).toBeNull()
  })

  it('AC-6: auto_update:false suppresses stop/spawn and returns a mismatch notice only', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: '0.1.0' }))
    const hubStop = vi.fn<HubStopFn>()
    const spawn = mockSpawn()

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      hubStop,
      spawn,
      selfVersion: '0.2.0',
      autoUpdate: false,
    })

    expect(hubStop).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(notice).toBe(
      t('autoUpdate.hubMismatchSuppressed', { hubVersion: '0.1.0', selfVersion: '0.2.0' })
    )
  })

  it('treats a missing hub version header (unknown) the same as "older" and updates', async () => {
    const paths = resolvePaths(tmpDir)
    const probeVersion = vi.fn(async () => ({ reachable: true, version: undefined }))
    const hubStop = vi.fn<HubStopFn>(async () => ({ stopped: true, pid: 4242 }))
    const isReachable = vi.fn(async () => true)
    const spawn = mockSpawn()
    const sleep = vi.fn(async () => {})

    const notice = await ensureHubRunning(paths, 'hub', 47632, {
      probeVersion,
      hubStop,
      isReachable,
      spawn,
      sleep,
      selfVersion: '0.2.0',
      autoUpdate: true,
    })

    expect(hubStop).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(notice).toBe(
      t('autoUpdate.hubRestarted', {
        hubVersion: t('cli.hubStatus.versionUnknown'),
        selfVersion: '0.2.0',
      })
    )
  })
})
