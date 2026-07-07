import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePaths } from '../config/paths.js'
import { ensureHubRunning, type SpawnFn } from './hub-autostart.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-hub-autostart-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** 型付き spawn モックを作る（実 `child_process.spawn` を呼ばず `unref` だけ持つオブジェクトを返す）。 */
function mockSpawn(unref: () => void = vi.fn()): SpawnFn {
  return vi.fn(() => ({ unref })) as unknown as SpawnFn
}

describe('ensureHubRunning (FR-01)', () => {
  it('AC-1: spawns the hub and waits for it to become reachable before resolving', async () => {
    // クリーン環境（~/.monomi 自体が未作成）を模す。paths.home 自体は存在しない子ディレクトリ。
    const paths = resolvePaths(path.join(tmpDir, '.monomi'))
    let reachableCalls = 0
    const isReachable = vi.fn(async () => {
      reachableCalls += 1
      // 1回目（既に稼働中か確認）は false。spawn 後のリトライ2回目で true になる。
      return reachableCalls > 1
    })
    const unref = vi.fn()
    const spawn = mockSpawn(unref)
    const sleep = vi.fn(async () => {})

    await ensureHubRunning(paths, 'hub', 47632, {
      isReachable,
      spawn,
      sleep,
      cliEntry: '/fake/dist/bin.js',
      timeoutMs: 1000,
      pollIntervalMs: 100,
    })

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

  it('AC-2: skips spawn when the hub already answers on the configured port', async () => {
    const paths = resolvePaths(tmpDir)
    const isReachable = vi.fn(async () => true)
    const spawn = mockSpawn()

    await ensureHubRunning(paths, 'hub', 47632, { isReachable, spawn })

    expect(spawn).not.toHaveBeenCalled()
    expect(isReachable).toHaveBeenCalledTimes(1)
  })

  it('AC-3: does nothing on role:child (no reachability check, no spawn)', async () => {
    const paths = resolvePaths(tmpDir)
    const isReachable = vi.fn(async () => false)
    const spawn = mockSpawn()

    await ensureHubRunning(paths, 'child', 47632, { isReachable, spawn })

    expect(isReachable).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('AC-4: throws an error referencing hub.log when reachability never succeeds within the timeout', async () => {
    const paths = resolvePaths(tmpDir)
    const isReachable = vi.fn(async () => false)
    const spawn = mockSpawn()
    const sleep = vi.fn(async () => {})

    await expect(
      ensureHubRunning(paths, 'hub', 47632, {
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
