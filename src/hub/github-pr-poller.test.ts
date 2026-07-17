import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Database, openDatabase } from '../db/database.js'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { InstanceRepository } from '../db/repositories/instance-repository.js'
import { PrStatusRepository } from '../db/repositories/pr-status-repository.js'
import { ProjectRepository } from '../db/repositories/project-repository.js'
import type { ProjectKeyKind } from '../domain/enums.js'
import { toEpochMs } from '../domain/time.js'
import { type ExecFileFn, GithubPrPoller } from './github-pr-poller.js'

let db: Database
let devices: DeviceRepository
let projects: ProjectRepository
let instances: InstanceRepository
let prStatus: PrStatusRepository

/** 1 回の `execFile` 呼び出し記録。 */
interface RecordedCall {
  command: string
  args: string[]
}

/** `gh pr list --repo <repo> --head <branch>` の呼び出しを識別するキー。 */
function prListKey(repo: string, branch: string): string {
  return `${repo}#${branch}`
}

/**
 * テスト用の `ExecFileFn` フェイク。
 *
 * `gh auth status` は `authOk`（既定 true）で成否を切り替え、`gh pr list ...` は
 * `prListResponses`（`repo#branch` キーの JSON stdout マップ、既定 `[]`）を返す。
 * `prListError` に一致する `repo#branch` は例外を投げる（AC-3 の個別失敗シミュレーション用）。
 * すべての呼び出しを `calls` へ記録するので、AC-1（重複排除）等の呼び出し回数検証に使える。
 */
function fakeExecFile(options: {
  authOk?: boolean
  prListResponses?: Record<string, string>
  prListError?: Set<string>
}): { execFile: ExecFileFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const execFile: ExecFileFn = async (command, args) => {
    calls.push({ command, args })
    if (command !== 'gh') {
      throw new Error(`unexpected command: ${command}`)
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      if (options.authOk === false) {
        throw new Error('gh: not authenticated (exit 1)')
      }
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const repo = args[args.indexOf('--repo') + 1]
      const branch = args[args.indexOf('--head') + 1]
      const key = prListKey(repo, branch)
      if (options.prListError?.has(key)) {
        throw new Error(`gh: repository or branch not found for ${key}`)
      }
      return { stdout: options.prListResponses?.[key] ?? '[]', stderr: '' }
    }
    throw new Error(`unexpected gh invocation: ${args.join(' ')}`)
  }
  return { execFile, calls }
}

/** `calls` から `gh pr list` の呼び出しだけを絞り込む。 */
function prListCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list')
}

/** DI 可能な fake timer（`setIntervalFn`/`clearIntervalFn` の呼び出し記録 + `unref` スパイ）。 */
function fakeTimer() {
  const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>
  const setIntervalFn = vi.fn(
    (_handler: () => void, _ms: number): ReturnType<typeof setInterval> => timer
  )
  const clearIntervalFn = vi.fn((_timer: ReturnType<typeof setInterval>): void => {})
  return { timer, setIntervalFn, clearIntervalFn }
}

/** project を findOrCreate し、その projectId で instance を 1 件登録するテストヘルパー。 */
function registerInstance(params: {
  deviceId: string
  projectKeyValue: string
  projectKeyKind: ProjectKeyKind
  path: string
  branch: string | null
}): { projectId: string; instanceId: string } {
  const project = projects.findOrCreateByKey({
    value: params.projectKeyValue,
    kind: params.projectKeyKind,
  })
  const instance = instances.upsert(project.id, params.deviceId, params.path, params.branch)
  return { projectId: project.id, instanceId: instance.id }
}

beforeEach(() => {
  db = openDatabase(':memory:')
  devices = new DeviceRepository(db)
  projects = new ProjectRepository(db)
  instances = new InstanceRepository(db)
  prStatus = new PrStatusRepository(db)

  for (const id of ['dev-1', 'dev-2', 'dev-3']) {
    devices.upsert({
      id,
      name: id,
      role: 'HUB',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    })
  }
})

describe('GithubPrPoller.pollOnce', () => {
  it('AC-1: dedupes the same (project_id, branch) across multiple instances into a single gh call', async () => {
    const { projectId } = registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    registerInstance({
      deviceId: 'dev-2',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-2/widget',
      branch: 'feature/x',
    })
    registerInstance({
      deviceId: 'dev-3',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-3/widget',
      branch: 'feature/y',
    })

    const { execFile, calls } = fakeExecFile({ prListResponses: {} })
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile })

    await poller.pollOnce()

    const listCalls = prListCalls(calls)
    expect(listCalls).toHaveLength(2)
    const branches = listCalls.map((c) => c.args[c.args.indexOf('--head') + 1]).sort()
    expect(branches).toEqual(['feature/x', 'feature/y'])
    // 重複排除された 2 つの instance のどちらの upsert も同じ projectId に書き込まれる。
    expect(prStatus.findByProjectBranch(projectId, 'feature/x')).not.toBeNull()
  })

  it('excludes non-GitHub / non-GIT_REMOTE projects and instances without a branch', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'gitlab.com/acme/other',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/other',
      branch: 'main',
    })
    registerInstance({
      deviceId: 'dev-2',
      projectKeyValue: 'local:dev-2:/home/dev-2/proj',
      projectKeyKind: 'LOCAL_NO_REMOTE',
      path: '/dev-2/proj',
      branch: 'main',
    })
    registerInstance({
      deviceId: 'dev-3',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-3/widget',
      branch: null,
    })

    const { execFile, calls } = fakeExecFile({})
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile })

    await poller.pollOnce()

    expect(prListCalls(calls)).toHaveLength(0)
  })

  it('AC-2: no open PR upserts state:none and clears a previously PR_WAIT (awaiting_review) row', async () => {
    const { projectId } = registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    prStatus.upsert({
      projectId,
      branch: 'feature/x',
      prNumber: 7,
      state: 'awaiting_review',
      isDraft: false,
      url: 'https://github.com/acme/widget/pull/7',
      checkedAt: toEpochMs(1000),
    })

    const { execFile } = fakeExecFile({
      prListResponses: { [prListKey('acme/widget', 'feature/x')]: '[]' },
    })
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      now: () => toEpochMs(2000),
    })

    await poller.pollOnce()

    const status = prStatus.findByProjectBranch(projectId, 'feature/x')
    expect(status).not.toBeNull()
    expect(status?.state).toBe('none')
    expect(status?.prNumber).toBeNull()
    expect(status?.url).toBeNull()
    expect(status?.isDraft).toBe(false)
    expect(status?.checkedAt).toBe(toEpochMs(2000))
  })

  it('maps an open draft PR with no review decision to awaiting_review + is_draft:true (FR-02 wiring)', async () => {
    const { projectId } = registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile } = fakeExecFile({
      prListResponses: {
        [prListKey('acme/widget', 'feature/x')]: JSON.stringify([
          {
            number: 12,
            state: 'OPEN',
            reviewDecision: null,
            isDraft: true,
            url: 'https://github.com/acme/widget/pull/12',
          },
        ]),
      },
    })
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile })

    await poller.pollOnce()

    const status = prStatus.findByProjectBranch(projectId, 'feature/x')
    expect(status?.state).toBe('awaiting_review')
    expect(status?.isDraft).toBe(true)
    expect(status?.prNumber).toBe(12)
    expect(status?.url).toBe('https://github.com/acme/widget/pull/12')
  })

  it('picks the highest PR number when multiple PRs exist for the same branch', async () => {
    const { projectId } = registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile } = fakeExecFile({
      prListResponses: {
        [prListKey('acme/widget', 'feature/x')]: JSON.stringify([
          {
            number: 5,
            state: 'CLOSED',
            reviewDecision: null,
            isDraft: false,
            url: 'https://github.com/acme/widget/pull/5',
          },
          {
            number: 10,
            state: 'OPEN',
            reviewDecision: 'APPROVED',
            isDraft: false,
            url: 'https://github.com/acme/widget/pull/10',
          },
        ]),
      },
    })
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile })

    await poller.pollOnce()

    const status = prStatus.findByProjectBranch(projectId, 'feature/x')
    expect(status?.prNumber).toBe(10)
    expect(status?.state).toBe('approved')
  })

  it('prefers an OPEN PR over a higher-numbered CLOSED/MERGED PR for the same branch (e.g. duplicate PRs targeting different bases)', async () => {
    const { projectId } = registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile } = fakeExecFile({
      prListResponses: {
        [prListKey('acme/widget', 'feature/x')]: JSON.stringify([
          {
            number: 50,
            state: 'OPEN',
            reviewDecision: null,
            isDraft: false,
            url: 'https://github.com/acme/widget/pull/50',
          },
          {
            number: 51,
            state: 'CLOSED',
            reviewDecision: null,
            isDraft: false,
            url: 'https://github.com/acme/widget/pull/51',
          },
        ]),
      },
    })
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile })

    await poller.pollOnce()

    const status = prStatus.findByProjectBranch(projectId, 'feature/x')
    expect(status?.prNumber).toBe(50)
    expect(status?.state).toBe('awaiting_review')
  })

  it('AC-3: an individual branch gh failure does not affect other branches and keeps the previous value', async () => {
    const { projectId: okProjectId } = registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/ok-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/ok-repo',
      branch: 'ok-branch',
    })
    const { projectId: badProjectId } = registerInstance({
      deviceId: 'dev-2',
      projectKeyValue: 'github.com/acme/bad-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-2/bad-repo',
      branch: 'bad-branch',
    })
    // bad-branch は以前の値を保持しているはず(前回値保持の確認対象)。
    prStatus.upsert({
      projectId: badProjectId,
      branch: 'bad-branch',
      prNumber: 42,
      state: 'approved',
      isDraft: false,
      url: 'https://github.com/acme/bad-repo/pull/42',
      checkedAt: toEpochMs(500),
    })

    const { execFile } = fakeExecFile({
      prListResponses: {
        [prListKey('acme/ok-repo', 'ok-branch')]: JSON.stringify([
          {
            number: 1,
            state: 'OPEN',
            reviewDecision: null,
            isDraft: false,
            url: 'https://github.com/acme/ok-repo/pull/1',
          },
        ]),
      },
      prListError: new Set([prListKey('acme/bad-repo', 'bad-branch')]),
    })
    const logger = vi.fn()
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile, logger })

    await expect(poller.pollOnce()).resolves.toBeUndefined()

    const okStatus = prStatus.findByProjectBranch(okProjectId, 'ok-branch')
    expect(okStatus?.state).toBe('awaiting_review')

    const badStatus = prStatus.findByProjectBranch(badProjectId, 'bad-branch')
    expect(badStatus).toEqual({
      id: badStatus?.id,
      projectId: badProjectId,
      branch: 'bad-branch',
      prNumber: 42,
      state: 'approved',
      isDraft: false,
      url: 'https://github.com/acme/bad-repo/pull/42',
      checkedAt: toEpochMs(500),
    })
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger.mock.calls[0]?.[0]).toContain('bad-branch')
  })

  it('sanitizes control characters from reporter-controlled branch/repo/error text before logging', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/bad-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/bad-repo',
      branch: 'bad\x1b]0;pwned\x07-branch',
    })
    const { execFile } = fakeExecFile({
      prListError: new Set([prListKey('acme/bad-repo', 'bad\x1b]0;pwned\x07-branch')]),
    })
    const logger = vi.fn()
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile, logger })

    await poller.pollOnce()

    expect(logger).toHaveBeenCalledTimes(1)
    const logged = String(logger.mock.calls[0]?.[0])
    expect(logged).not.toContain('\x1b')
    expect(logged).not.toContain('\x07')
    expect(logged).toContain('bad]0;pwned-branch')
  })

  it('serializes overlapping pollOnce() calls via an in-flight guard (review-changes: prevents stale-write races)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const calls: RecordedCall[] = []
    const execFile: ExecFileFn = async (command, args) => {
      calls.push({ command, args })
      if (args[0] === 'pr' && args[1] === 'list') {
        await gate
      }
      return { stdout: '[]', stderr: '' }
    }
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile })

    const firstCycle = poller.pollOnce()
    const secondCycle = poller.pollOnce()
    await secondCycle

    // 2 回目は前回サイクルが完了していないため即 return し、gh を一切呼ばない。
    expect(prListCalls(calls)).toHaveLength(1)

    releaseGate?.()
    await firstCycle

    // 1 回目のサイクルが完了した後も、2 回目由来の追加呼び出しは発生しない。
    expect(prListCalls(calls)).toHaveLength(1)
  })

  it('allowedRepos restricts polling to the listed owner/repo entries (confused-deputy mitigation)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    registerInstance({
      deviceId: 'dev-2',
      projectKeyValue: 'github.com/acme/other-secret-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-2/other',
      branch: 'main',
    })
    const { execFile, calls } = fakeExecFile({ prListResponses: {} })
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      allowedRepos: ['acme/widget'],
    })

    await poller.pollOnce()

    const listCalls = prListCalls(calls)
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]?.args[listCalls[0].args.indexOf('--repo') + 1]).toBe('acme/widget')
  })

  it('an empty allowedRepos array means no restriction (back-compat with the pre-fix default)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile, calls } = fakeExecFile({ prListResponses: {} })
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      allowedRepos: [],
    })

    await poller.pollOnce()

    expect(prListCalls(calls)).toHaveLength(1)
  })

  it('does not re-check gh auth status when only some branches in a cycle fail (isolated failure, not revocation)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/ok-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/ok-repo',
      branch: 'ok-branch',
    })
    registerInstance({
      deviceId: 'dev-2',
      projectKeyValue: 'github.com/acme/bad-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-2/bad-repo',
      branch: 'bad-branch',
    })
    const { execFile, calls } = fakeExecFile({
      prListResponses: { [prListKey('acme/ok-repo', 'ok-branch')]: '[]' },
      prListError: new Set([prListKey('acme/bad-repo', 'bad-branch')]),
    })
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile })

    await poller.pollOnce()

    expect(calls.filter((c) => c.args[0] === 'auth')).toHaveLength(0)
  })

  it('AC-4 (runtime extension): disables the poller when an entire cycle fails and gh auth status now fails too', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const calls: RecordedCall[] = []
    const execFile: ExecFileFn = async (command, args) => {
      calls.push({ command, args })
      if (args[0] === 'auth' && args[1] === 'status') {
        throw new Error('gh: not authenticated (exit 1)')
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        throw new Error('gh: authentication required')
      }
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`)
    }
    const logger = vi.fn()
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile, logger })

    await poller.pollOnce()

    expect(calls.filter((c) => c.args[0] === 'auth')).toHaveLength(1)
    expect(logger.mock.calls.some((call) => String(call[0]).includes('認証が失効'))).toBe(true)
  })

  it('stop() aborts an in-flight poll cycle instead of leaving its child process running unbounded', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const execFile: ExecFileFn = (_command, args, options) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('gh: aborted')))
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    }
    const logger = vi.fn()
    const poller = new GithubPrPoller(instances, projects, prStatus, { execFile, logger })

    const cycle = poller.pollOnce()
    poller.stop()
    await expect(cycle).resolves.toBeUndefined()

    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger.mock.calls[0]?.[0]).toContain('aborted')
  })
})

describe('GithubPrPoller.start / stop', () => {
  it('AC-4: disables polling and logs a single warning when gh is unavailable/unauthenticated', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile, calls } = fakeExecFile({ authOk: false })
    const logger = vi.fn()
    const { setIntervalFn, clearIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      logger,
      setIntervalFn,
      clearIntervalFn,
    })

    await poller.start()
    await poller.start() // 2 回目も no-op（警告は 1 回のみ）

    expect(poller.isRunning()).toBe(false)
    expect(logger).toHaveBeenCalledTimes(1)
    expect(setIntervalFn).not.toHaveBeenCalled()
    // auth status の確認 1 回のみで、pr list へは一切進まない。
    expect(calls).toHaveLength(1)
    expect(prListCalls(calls)).toHaveLength(0)
  })

  it('AC-5: enabled:false makes start() a complete no-op (no gh invocation at all)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile, calls } = fakeExecFile({})
    const { setIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      enabled: false,
      setIntervalFn,
    })

    await poller.start()

    expect(poller.isRunning()).toBe(false)
    expect(calls).toHaveLength(0)
    expect(setIntervalFn).not.toHaveBeenCalled()
  })

  it('AC-6: start() schedules an unref-ed timer at the configured interval, and stop() clears it', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile } = fakeExecFile({
      prListResponses: { [prListKey('acme/widget', 'feature/x')]: '[]' },
    })
    const { timer, setIntervalFn, clearIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      intervalMs: 5 * 60_000,
      setIntervalFn,
      clearIntervalFn,
    })

    await poller.start()

    expect(poller.isRunning()).toBe(true)
    expect(setIntervalFn).toHaveBeenCalledTimes(1)
    expect(setIntervalFn.mock.calls[0]?.[1]).toBe(5 * 60_000)
    expect(timer.unref).toHaveBeenCalledTimes(1)

    poller.stop()

    expect(clearIntervalFn).toHaveBeenCalledWith(timer)
    expect(poller.isRunning()).toBe(false)

    // 2 回目の stop() は冪等（何も起きない）。
    poller.stop()
    expect(clearIntervalFn).toHaveBeenCalledTimes(1)
  })

  it('start() is idempotent while already running (no duplicate gh auth check or timer)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    const { execFile, calls } = fakeExecFile({
      prListResponses: { [prListKey('acme/widget', 'feature/x')]: '[]' },
    })
    const { setIntervalFn, clearIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      setIntervalFn,
      clearIntervalFn,
    })

    await poller.start()
    const callsAfterFirstStart = calls.length
    await poller.start()

    expect(calls).toHaveLength(callsAfterFirstStart)
    expect(setIntervalFn).toHaveBeenCalledTimes(1)
  })

  it('warns once at start() when allowedRepos is unset and targets span multiple owners/orgs (confused-deputy awareness)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    registerInstance({
      deviceId: 'dev-2',
      // reporter が申告した別 owner の repo（悪意ある reporter を想定した本来分離すべき対象）。
      projectKeyValue: 'github.com/private-org/secret-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-2/secret',
      branch: 'main',
    })
    const { execFile } = fakeExecFile({ prListResponses: {} })
    const logger = vi.fn()
    const { setIntervalFn, clearIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      logger,
      setIntervalFn,
      clearIntervalFn,
    })

    await poller.start()

    expect(logger).toHaveBeenCalledTimes(1)
    const logged = String(logger.mock.calls[0]?.[0])
    expect(logged).toContain('allowed_repos')
  })

  it('does not warn at start() when allowedRepos is unset but all targets share a single owner (avoids false positives)', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    registerInstance({
      deviceId: 'dev-2',
      projectKeyValue: 'github.com/acme/other',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-2/other',
      branch: 'main',
    })
    const { execFile } = fakeExecFile({ prListResponses: {} })
    const logger = vi.fn()
    const { setIntervalFn, clearIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      logger,
      setIntervalFn,
      clearIntervalFn,
    })

    await poller.start()

    expect(logger).not.toHaveBeenCalled()
  })

  it('does not warn at start() when allowedRepos is explicitly configured, even if targets span multiple owners', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    registerInstance({
      deviceId: 'dev-2',
      projectKeyValue: 'github.com/private-org/secret-repo',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-2/secret',
      branch: 'main',
    })
    const { execFile } = fakeExecFile({ prListResponses: {} })
    const logger = vi.fn()
    const { setIntervalFn, clearIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      logger,
      setIntervalFn,
      clearIntervalFn,
      allowedRepos: ['acme/widget'],
    })

    await poller.start()

    expect(logger).not.toHaveBeenCalled()
  })

  it('B15: a synchronous collectTargets() failure (e.g. DB closed mid-shutdown) is caught, not an unhandled rejection', async () => {
    registerInstance({
      deviceId: 'dev-1',
      projectKeyValue: 'github.com/acme/widget',
      projectKeyKind: 'GIT_REMOTE',
      path: '/dev-1/widget',
      branch: 'feature/x',
    })
    // 1回目（`start()` 自身の `warnIfAllowedReposUnrestricted()` 経由の同期呼び出し）は正常応答させ、
    // `pollOnce()`（初回のバックグラウンド起動・timer コールバック）からの2回目以降でのみ、DB が
    // シャットダウン中に閉じられた状況を模した同期例外を投げる。
    const realListActive = instances.listActive.bind(instances)
    let callCount = 0
    vi.spyOn(instances, 'listActive').mockImplementation(() => {
      callCount += 1
      if (callCount === 1) {
        return realListActive()
      }
      throw new Error('the database connection is not open')
    })
    const { execFile } = fakeExecFile({ prListResponses: {} })
    const logger = vi.fn()
    const { setIntervalFn, clearIntervalFn } = fakeTimer()
    const poller = new GithubPrPoller(instances, projects, prStatus, {
      execFile,
      logger,
      setIntervalFn,
      clearIntervalFn,
    })

    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      // start() の初回 pollOnce() はバックグラウンド起動（await しない設計、review-changes 修正）
      // のため、await start() 直後はまだ settle していない。マイクロタスクを1周させて確定させる。
      await poller.start()
      await new Promise((resolve) => setImmediate(resolve))

      // setInterval コールバック経路（AC-4 の全件失敗検知の手前）も同じ catch でガードされていること
      // を確認する。
      const handler = setIntervalFn.mock.calls[0]?.[0]
      handler?.()
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }

    expect(unhandledRejections).toHaveLength(0)
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('the database connection is not open')
    )
  })
})
