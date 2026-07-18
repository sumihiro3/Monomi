import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MonomiPaths, resolvePaths } from '../config/paths.js'
import type { ExecFileFn } from './github-pr-poller.js'
import { type HubHandle, serve } from './serve.js'

/**
 * `serve()` の hub.pid 書き込み/削除の往復テスト（FR-02）と GitHub PR ポーラーの起動/停止配線
 * （release-27 FR-01b）。詳細な bootstrap/HTTP 往復の検証は `http-server.test.ts`、poller 本体の
 * 挙動（対象抽出・`gh` 呼び出し・マッピング・エラー処理）の検証は `github-pr-poller.test.ts` が
 * 既に担うため、ここでは serve() からの配線（start/stop のタイミング・config 由来の enabled 分岐）
 * のみに絞る。
 */

let tmpDir: string
let paths: MonomiPaths
let hub: HubHandle | undefined

/**
 * `GithubPrPoller` の `gh` 実行差し替え既定スタブ。`gh auth status` を無条件成功として扱い、
 * 実 `gh` CLI（導入状況・認証状態がテスト環境依存）を一切起動しない決定的なテストにする。
 * 対象 DB は instance を持たないため `collectTargets()` が空になり、`gh pr list` 自体は
 * どのテストからも実際には呼ばれない。
 */
const stubGithubPrPollExecFile: ExecFileFn = async () => ({ stdout: '[]', stderr: '' })

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-serve-lifecycle-'))
  paths = resolvePaths(tmpDir)
})

afterEach(async () => {
  if (hub !== undefined) {
    await hub.close()
    hub = undefined
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('serve() hub.pid lifecycle (FR-02)', () => {
  it('writes its own pid to hub.pid after a successful listen', async () => {
    hub = await serve({
      paths,
      port: 0,
      hostname: 'macmini.local',
      logger: () => {},
      githubPrPollExecFile: stubGithubPrPollExecFile,
    })
    expect(fs.existsSync(paths.hubPidFile)).toBe(true)
    expect(fs.readFileSync(paths.hubPidFile, 'utf8').trim()).toBe(String(process.pid))
  })

  it('removes hub.pid on close() (the SIGINT/SIGTERM graceful-shutdown path)', async () => {
    hub = await serve({
      paths,
      port: 0,
      hostname: 'macmini.local',
      logger: () => {},
      githubPrPollExecFile: stubGithubPrPollExecFile,
    })
    expect(fs.existsSync(paths.hubPidFile)).toBe(true)

    await hub.close()
    hub = undefined // already closed here; avoid a second close() in afterEach

    expect(fs.existsSync(paths.hubPidFile)).toBe(false)
  })

  it('overwrites a stale pre-existing hub.pid unconditionally (self-recovery, known-issue U10)', async () => {
    fs.mkdirSync(paths.home, { recursive: true })
    fs.writeFileSync(paths.hubPidFile, '999999')

    hub = await serve({
      paths,
      port: 0,
      hostname: 'macmini.local',
      logger: () => {},
      githubPrPollExecFile: stubGithubPrPollExecFile,
    })

    expect(fs.readFileSync(paths.hubPidFile, 'utf8').trim()).toBe(String(process.pid))
  })
})

describe('serve() GitHub PR poller wiring (release-27 FR-01b)', () => {
  it('starts the poller after listen and stops its timer on close() so it cannot block process exit (AC-6)', async () => {
    hub = await serve({
      paths,
      port: 0,
      hostname: 'macmini.local',
      logger: () => {},
      githubPrPollExecFile: stubGithubPrPollExecFile,
    })
    const poller = hub.githubPrPoller
    expect(poller.isRunning()).toBe(true)

    await hub.close()
    hub = undefined // already closed here; avoid a second close() in afterEach

    expect(poller.isRunning()).toBe(false)
  })

  it('does not start the poller when github_pr_poll.enabled is false in config.yml (AC-5)', async () => {
    fs.mkdirSync(paths.home, { recursive: true })
    fs.writeFileSync(paths.configFile, 'github_pr_poll:\n  enabled: false\n')

    const execFile = vi.fn(stubGithubPrPollExecFile)
    hub = await serve({
      paths,
      port: 0,
      hostname: 'macmini.local',
      logger: () => {},
      githubPrPollExecFile: execFile,
    })

    expect(hub.githubPrPoller.isRunning()).toBe(false)
    // enabled:false is a full no-op (per requirements.md AC-5): it must not even probe `gh`.
    expect(execFile).not.toHaveBeenCalled()
  })
})
