import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveInvokedPath, run, type CliDeps } from './cli.js'
import { MONOMI_VERSION } from './index.js'
import { setActiveLocale } from './i18n/index.js'
import type { InstallHooksResult } from './install-hooks/install-hooks.js'

// テスト間でアクティブロケール(モジュールレベル・シングルトン)を既定 en へリセットする規約
// (src/i18n/i18n.test.ts・instance-card.test.tsx と同じ規約)。
afterEach(() => {
  setActiveLocale('en')
})

/** テスト用の {@link CliDeps}。全ハンドラをモックにし、呼び出しの検証だけに専念する。 */
function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    installHooks: vi.fn(
      (): InstallHooksResult => ({
        settingsPath: '/fake/settings.json',
        added: 8,
        removed: 0,
      })
    ),
    uninstallHooks: vi.fn(
      (): InstallHooksResult => ({
        settingsPath: '/fake/settings.json',
        added: 0,
        removed: 8,
      })
    ),
    runHub: vi.fn(async () => {}),
    loadRole: vi.fn(() => 'hub' as const),
    ensureHubRunning: vi.fn(async () => null),
    ensureReporterUpToDate: vi.fn(() => null),
    startMemoryWatchdog: vi.fn(),
    loadLocale: vi.fn(() => 'en' as const),
    listDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(async (deviceId: string) => ({
      ok: true,
      device_id: deviceId,
      revoked: 0,
    })),
    hubPair: vi.fn(async () => {}),
    childPair: vi.fn(async () => {}),
    hubStatus: vi.fn(async () => ({ state: 'stopped' as const })),
    hubStop: vi.fn(async () => ({ stopped: false })),
    runDashboard: vi.fn(async () => {}),
    // 既定は「登録済み」にしておく — FR-03 のセットアップ確認プロンプトに関心のない既存テストが
    // 意図せずプロンプト分岐（案内ログ等）に迷い込まないようにする(FR-03 専用の describe で
    // 個別に上書きする)。
    isHooksInstalled: vi.fn(() => true),
    isSetupPromptDeclined: vi.fn(() => false),
    markSetupPromptDeclined: vi.fn(),
    isInteractive: vi.fn(() => true),
    promptConfirm: vi.fn(async () => true),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  }
}

describe('run (CLI dispatch)', () => {
  it('routes no-args to the dashboard (FR-05 AC-1)', async () => {
    const deps = makeDeps()
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.runDashboard).toHaveBeenCalledTimes(1)
    expect(deps.runHub).not.toHaveBeenCalled()
  })

  it('ensures the hub is running before showing the dashboard (release-18-npx-quickstart FR-01 AC-1/AC-2)', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      ensureHubRunning: vi.fn(async () => {
        calls.push('ensureHubRunning')
        return null
      }),
      runDashboard: vi.fn(async () => {
        calls.push('runDashboard')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.ensureHubRunning).toHaveBeenCalledTimes(1)
    // 自動起動の疎通確認を終えてからダッシュボードへ進む(順序保証)。
    expect(calls).toEqual(['ensureHubRunning', 'runDashboard'])
  })

  it('starts the memory watchdog before showing the dashboard (release-20-dashboard-heap-guard FR-01 AC-5)', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      ensureHubRunning: vi.fn(async () => {
        calls.push('ensureHubRunning')
        return null
      }),
      startMemoryWatchdog: vi.fn(() => {
        calls.push('startMemoryWatchdog')
      }),
      runDashboard: vi.fn(async () => {
        calls.push('runDashboard')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.startMemoryWatchdog).toHaveBeenCalledTimes(1)
    // ensureHubRunning(自動起動疎通確認)を終えてからウォッチドッグを起動し、その後ダッシュボードへ
    // 進む(順序保証)。
    expect(calls).toEqual(['ensureHubRunning', 'startMemoryWatchdog', 'runDashboard'])
  })

  it('collects the ensureHubRunning notice into the startupNotices array passed to runDashboard (release-25-auto-update)', async () => {
    const deps = makeDeps({
      ensureHubRunning: vi.fn(async () => 'hub updated: 0.1.0 -> 0.2.0'),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.runDashboard).toHaveBeenCalledWith(['hub updated: 0.1.0 -> 0.2.0'])
  })

  it('passes an empty startupNotices array to runDashboard when ensureHubRunning has no notice (release-25-auto-update)', async () => {
    const deps = makeDeps() // 既定の ensureHubRunning は null（notice なし）を返す。
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.runDashboard).toHaveBeenCalledWith([])
  })

  it('calls ensureReporterUpToDate after maybePromptInstallHooks and before the dashboard (release-25-auto-update FR-03)', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => true), // maybePromptInstallHooks を素通りさせる。
      ensureReporterUpToDate: vi.fn(() => {
        calls.push('ensureReporterUpToDate')
        return null
      }),
      startMemoryWatchdog: vi.fn(() => {
        calls.push('startMemoryWatchdog')
      }),
      runDashboard: vi.fn(async () => {
        calls.push('runDashboard')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.ensureReporterUpToDate).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['ensureReporterUpToDate', 'startMemoryWatchdog', 'runDashboard'])
  })

  it('collects the ensureReporterUpToDate notice into the startupNotices array passed to runDashboard (release-25-auto-update FR-03)', async () => {
    const deps = makeDeps({
      ensureReporterUpToDate: vi.fn(() => 'reporter updated: 0.1.0 -> 0.2.0'),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.runDashboard).toHaveBeenCalledWith(['reporter updated: 0.1.0 -> 0.2.0'])
  })

  it('collects both the hub and reporter notices, hub notice first (release-25-auto-update)', async () => {
    const deps = makeDeps({
      ensureHubRunning: vi.fn(async () => 'hub updated: 0.1.0 -> 0.2.0'),
      ensureReporterUpToDate: vi.fn(() => 'reporter updated: 0.1.0 -> 0.2.0'),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.runDashboard).toHaveBeenCalledWith([
      'hub updated: 0.1.0 -> 0.2.0',
      'reporter updated: 0.1.0 -> 0.2.0',
    ])
  })

  it('does not start the memory watchdog when hub autostart fails (release-20-dashboard-heap-guard FR-01 AC-5)', async () => {
    const deps = makeDeps({
      ensureHubRunning: vi.fn(async () => {
        throw new Error('could not reach hub; see ~/.monomi/hub.log')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(1)
    expect(deps.startMemoryWatchdog).not.toHaveBeenCalled()
  })

  it('aborts with exit code 1 and never shows the dashboard when hub autostart times out (FR-01 AC-4)', async () => {
    const deps = makeDeps({
      ensureHubRunning: vi.fn(async () => {
        throw new Error('could not reach hub; see ~/.monomi/hub.log')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(1)
    expect(deps.runDashboard).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('hub.log'))
  })

  it('routes "hub" to the hub server entrypoint (FR-03)', async () => {
    const deps = makeDeps()
    const code = await run(['hub'], deps)
    expect(code).toBe(0)
    expect(deps.runHub).toHaveBeenCalledTimes(1)
    expect(deps.runDashboard).not.toHaveBeenCalled()
  })

  it('does not start the memory watchdog for "hub" (release-20-dashboard-heap-guard FR-01 AC-5)', async () => {
    const deps = makeDeps()
    const code = await run(['hub'], deps)
    expect(code).toBe(0)
    expect(deps.startMemoryWatchdog).not.toHaveBeenCalled()
  })

  it('errors out when "hub" runs on a role:child device without starting the hub (FR-01 AC-2)', async () => {
    const deps = makeDeps({ loadRole: vi.fn(() => 'child' as const) })
    const code = await run(['hub'], deps)
    expect(code).toBe(1)
    expect(deps.runHub).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('role:child'))
  })

  it('routes "hub devices list" to listDevices and prints a table without starting the hub (FR-03 AC-1)', async () => {
    const deps = makeDeps({
      listDevices: vi.fn(async () => [
        {
          id: 'macmini',
          name: 'macmini.local',
          role: 'hub',
          first_seen_at: '2026-07-02T00:00:00.000Z',
          last_seen_at: '2026-07-02T06:13:20.000Z',
          has_active_token: true,
        },
        {
          id: 'macbook',
          name: 'macbook.local',
          role: 'child',
          first_seen_at: '2026-07-02T01:00:00.000Z',
          last_seen_at: '2026-07-02T05:00:00.000Z',
          has_active_token: false,
        },
      ]),
    })
    const code = await run(['hub', 'devices', 'list'], deps)
    expect(code).toBe(0)
    expect(deps.listDevices).toHaveBeenCalledTimes(1)
    expect(deps.runHub).not.toHaveBeenCalled()
    const table = (deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(table).toContain('macmini')
    expect(table).toContain('active')
    expect(table).toContain('macbook')
    expect(table).toContain('revoked')
  })

  it('does not apply the child guard to "hub devices list" (management client, not a server)', async () => {
    const deps = makeDeps({ loadRole: vi.fn(() => 'child' as const) })
    const code = await run(['hub', 'devices', 'list'], deps)
    expect(code).toBe(0)
    expect(deps.listDevices).toHaveBeenCalledTimes(1)
  })

  it('routes "hub devices revoke <id>" to revokeDevice and logs the count (FR-03 AC-2)', async () => {
    const deps = makeDeps({
      revokeDevice: vi.fn(async (id: string) => ({ ok: true, device_id: id, revoked: 2 })),
    })
    const code = await run(['hub', 'devices', 'revoke', 'macbook'], deps)
    expect(code).toBe(0)
    expect(deps.revokeDevice).toHaveBeenCalledWith('macbook')
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Revoked 2 token(s)'))
  })

  it('errors when "hub devices revoke" is missing the device_id (exit 1)', async () => {
    const deps = makeDeps()
    const code = await run(['hub', 'devices', 'revoke'], deps)
    expect(code).toBe(1)
    expect(deps.revokeDevice).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('device_id'))
  })

  it('routes "hub pair" to hubPair without starting the hub server (FR-02b)', async () => {
    const deps = makeDeps()
    const code = await run(['hub', 'pair'], deps)
    expect(code).toBe(0)
    expect(deps.hubPair).toHaveBeenCalledTimes(1)
    expect(deps.runHub).not.toHaveBeenCalled()
  })

  it('does not apply the child guard to "hub pair" (client, not a server)', async () => {
    const deps = makeDeps({ loadRole: vi.fn(() => 'child' as const) })
    const code = await run(['hub', 'pair'], deps)
    expect(code).toBe(0)
    expect(deps.hubPair).toHaveBeenCalledTimes(1)
  })

  it('routes "pair --code X" to childPair with the parsed code (FR-02b)', async () => {
    const deps = makeDeps()
    const code = await run(['pair', '--code', '482913'], deps)
    expect(code).toBe(0)
    expect(deps.childPair).toHaveBeenCalledWith({ code: '482913', hub: [] })
  })

  it('passes --hub through to childPair as a single-element array, supporting --flag=value form', async () => {
    const deps = makeDeps()
    const code = await run(['pair', '--code=482913', '--hub=http://100.64.1.2:47632'], deps)
    expect(code).toBe(0)
    expect(deps.childPair).toHaveBeenCalledWith({
      code: '482913',
      hub: ['http://100.64.1.2:47632'],
    })
  })

  it('collects repeated --hub flags into an array, preserving CLI order as priority (#4)', async () => {
    const deps = makeDeps()
    const code = await run(
      [
        'pair',
        '--code',
        '482913',
        '--hub',
        'http://100.64.1.2:47632',
        '--hub',
        'http://192.168.1.100:47632',
      ],
      deps
    )
    expect(code).toBe(0)
    expect(deps.childPair).toHaveBeenCalledWith({
      code: '482913',
      hub: ['http://100.64.1.2:47632', 'http://192.168.1.100:47632'],
    })
  })

  it('errors when "pair" is missing --code (exit 1, childPair not called)', async () => {
    const deps = makeDeps()
    const code = await run(['pair'], deps)
    expect(code).toBe(1)
    expect(deps.childPair).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('--code'))
  })

  it('errors on an unknown pair option (exit 1)', async () => {
    const deps = makeDeps()
    const code = await run(['pair', '--code', 'x', '--frob', 'y'], deps)
    expect(code).toBe(1)
    expect(deps.childPair).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('--frob'))
  })

  it('errors on an unknown "hub" subcommand (exit 1)', async () => {
    const deps = makeDeps()
    const code = await run(['hub', 'frobnicate'], deps)
    expect(code).toBe(1)
    expect(deps.runHub).not.toHaveBeenCalled()
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('frobnicate'))
  })

  it('routes "install-hooks" to installHooks and logs a summary (FR-01)', async () => {
    const deps = makeDeps()
    const code = await run(['install-hooks'], deps)
    expect(code).toBe(0)
    expect(deps.installHooks).toHaveBeenCalledTimes(1)
    expect(deps.uninstallHooks).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('/fake/settings.json'))
  })

  it('routes "uninstall-hooks" to uninstallHooks and logs a summary (FR-01 AC-4)', async () => {
    const deps = makeDeps()
    const code = await run(['uninstall-hooks'], deps)
    expect(code).toBe(0)
    expect(deps.uninstallHooks).toHaveBeenCalledTimes(1)
    expect(deps.installHooks).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('removed'))
  })

  it.each(['--version', '-v'])('%s prints the version without touching hub/hooks', async (flag) => {
    const deps = makeDeps()
    const code = await run([flag], deps)
    expect(code).toBe(0)
    expect(deps.log).toHaveBeenCalledWith(MONOMI_VERSION)
    expect(deps.runHub).not.toHaveBeenCalled()
    expect(deps.installHooks).not.toHaveBeenCalled()
  })

  it.each([
    '--help',
    '-h',
  ])('%s prints usage, including hub stop/status (FR-02 AC-4)', async (flag) => {
    const deps = makeDeps()
    const code = await run([flag], deps)
    expect(code).toBe(0)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('monomi'))
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('hub stop'))
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('hub status'))
  })

  it.each([
    '--version',
    '-v',
    '--help',
    '-h',
  ])('does not start the memory watchdog for %s (release-20-dashboard-heap-guard FR-01 AC-5)', async (flag) => {
    const deps = makeDeps()
    const code = await run([flag], deps)
    expect(code).toBe(0)
    expect(deps.startMemoryWatchdog).not.toHaveBeenCalled()
  })

  it('reports unknown commands as exit code 1 without dispatching anything', async () => {
    const deps = makeDeps()
    const code = await run(['frobnicate'], deps)
    expect(code).toBe(1)
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('frobnicate'))
    expect(deps.runDashboard).not.toHaveBeenCalled()
    expect(deps.runHub).not.toHaveBeenCalled()
    expect(deps.installHooks).not.toHaveBeenCalled()
    expect(deps.uninstallHooks).not.toHaveBeenCalled()
  })

  it('converts a thrown error from the dashboard into exit code 1 (e.g. hub not running)', async () => {
    const deps = makeDeps({
      runDashboard: vi.fn(async () => {
        throw new Error('Monomi token not found at /fake/token. Start the hub first (monomi hub).')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(1)
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('Start the hub first'))
  })

  it('converts a thrown EADDRINUSE error from "hub" into an "already running" message (FR-02)', async () => {
    const deps = makeDeps({
      runHub: vi.fn(async () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:47632')
      }),
    })
    const code = await run(['hub'], deps)
    expect(code).toBe(1)
    // 元の EADDRINUSE メッセージを含みつつ、「既に稼働中の可能性」と `hub status` への案内へ変換される。
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'))
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('monomi hub status'))
  })

  it('passes through a non-EADDRINUSE error from "hub" unchanged', async () => {
    const deps = makeDeps({
      runHub: vi.fn(async () => {
        throw new Error('boom: something else went wrong')
      }),
    })
    const code = await run(['hub'], deps)
    expect(code).toBe(1)
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('boom: something else'))
  })

  it.each([
    ['running', { state: 'running' as const, pid: 4242, port: 47632 }],
    ['stale', { state: 'stale' as const, pid: 4242 }],
    ['stopped', { state: 'stopped' as const }],
  ])('routes "hub status" to hubStatus and prints the %s state (FR-02 AC-1)', async (_label, result) => {
    const deps = makeDeps({ hubStatus: vi.fn(async () => result) })
    const code = await run(['hub', 'status'], deps)
    expect(code).toBe(0)
    expect(deps.hubStatus).toHaveBeenCalledTimes(1)
    expect(deps.runHub).not.toHaveBeenCalled()
    if (result.state === 'running') {
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('4242'))
    }
    if (result.state === 'stale') {
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('4242'))
    }
  })

  it('reports "running" without a pid when the hub answers but no pid file is tracked (e.g. pm2/launchd)', async () => {
    const deps = makeDeps({
      hubStatus: vi.fn(async () => ({ state: 'running' as const, port: 47632 })),
    })
    const code = await run(['hub', 'status'], deps)
    expect(code).toBe(0)
    const message = (deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(message).toContain('47632')
    expect(message).not.toMatch(/pid \d/)
  })

  it('includes the hub version in "hub status" output when the probe reported one (FR-01 AC-3)', async () => {
    const deps = makeDeps({
      hubStatus: vi.fn(async () => ({
        state: 'running' as const,
        pid: 4242,
        port: 47632,
        hubVersion: '0.3.0',
      })),
    })
    const code = await run(['hub', 'status'], deps)
    expect(code).toBe(0)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('0.3.0'))
  })

  it('falls back to the "unknown version" label when the probe did not report a version (FR-01 AC-3)', async () => {
    const deps = makeDeps({
      hubStatus: vi.fn(async () => ({
        state: 'running' as const,
        pid: 4242,
        port: 47632,
      })),
    })
    const code = await run(['hub', 'status'], deps)
    expect(code).toBe(0)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('unknown'))
  })

  it('does not apply the child guard to "hub status" (management command, not a server)', async () => {
    const deps = makeDeps({ loadRole: vi.fn(() => 'child' as const) })
    const code = await run(['hub', 'status'], deps)
    expect(code).toBe(0)
    expect(deps.hubStatus).toHaveBeenCalledTimes(1)
  })

  it('routes "hub stop" to hubStop and reports a stopped hub (FR-02 AC-2)', async () => {
    const deps = makeDeps({ hubStop: vi.fn(async () => ({ stopped: true, pid: 4242 })) })
    const code = await run(['hub', 'stop'], deps)
    expect(code).toBe(0)
    expect(deps.hubStop).toHaveBeenCalledTimes(1)
    expect(deps.runHub).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('4242'))
  })

  it('routes "hub stop" to hubStop and reports an already-stopped hub without erroring (FR-02 AC-2)', async () => {
    const deps = makeDeps({ hubStop: vi.fn(async () => ({ stopped: false })) })
    const code = await run(['hub', 'stop'], deps)
    expect(code).toBe(0)
    expect(deps.hubStop).toHaveBeenCalledTimes(1)
  })

  it('reports a distinct "timed out" message (not "already stopped") when the hub did not exit in time', async () => {
    const deps = makeDeps({
      hubStop: vi.fn(async () => ({ stopped: false, pid: 4242, timedOut: true })),
    })
    const code = await run(['hub', 'stop'], deps)
    expect(code).toBe(0)
    const message = (deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(message).toContain('4242')
    expect(message).not.toContain('not running')
  })

  it('does not apply the child guard to "hub stop" (management command, not a server)', async () => {
    const deps = makeDeps({ loadRole: vi.fn(() => 'child' as const) })
    const code = await run(['hub', 'stop'], deps)
    expect(code).toBe(0)
    expect(deps.hubStop).toHaveBeenCalledTimes(1)
  })
})

describe('run — first-run install-hooks setup prompt (release-18-npx-quickstart FR-03)', () => {
  it('prompts on the interactive first run and installs hooks when accepted (AC-1)', async () => {
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => false),
      isSetupPromptDeclined: vi.fn(() => false),
      isInteractive: vi.fn(() => true),
      promptConfirm: vi.fn(async () => true),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.promptConfirm).toHaveBeenCalledTimes(1)
    expect(deps.promptConfirm).toHaveBeenCalledWith(expect.stringContaining('install-hooks'))
    expect(deps.installHooks).toHaveBeenCalledTimes(1)
    expect(deps.markSetupPromptDeclined).not.toHaveBeenCalled()
    expect(deps.runDashboard).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('/fake/settings.json'))
  })

  it('persists a decline so the next run does not reprompt, and shows guidance instead (AC-2)', async () => {
    let declined = false
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => false),
      isSetupPromptDeclined: vi.fn(() => declined),
      markSetupPromptDeclined: vi.fn(() => {
        declined = true
      }),
      isInteractive: vi.fn(() => true),
      promptConfirm: vi.fn(async () => false),
    })

    const firstCode = await run([], deps)
    expect(firstCode).toBe(0)
    expect(deps.promptConfirm).toHaveBeenCalledTimes(1)
    expect(deps.markSetupPromptDeclined).toHaveBeenCalledTimes(1)
    expect(deps.installHooks).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('install-hooks'))

    const secondCode = await run([], deps)
    expect(secondCode).toBe(0)
    // 拒否が永続化された後は再プロンプトしない。
    expect(deps.promptConfirm).toHaveBeenCalledTimes(1)
    expect(deps.installHooks).not.toHaveBeenCalled()
  })

  it('shows nothing when the hooks are already registered (AC-3)', async () => {
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => true),
      promptConfirm: vi.fn(async () => true),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.promptConfirm).not.toHaveBeenCalled()
    expect(deps.installHooks).not.toHaveBeenCalled()
    expect(deps.log).not.toHaveBeenCalled()
  })

  it('skips the prompt on a non-interactive run and only shows guidance (AC-4)', async () => {
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => false),
      isSetupPromptDeclined: vi.fn(() => false),
      isInteractive: vi.fn(() => false),
      promptConfirm: vi.fn(async () => true),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.promptConfirm).not.toHaveBeenCalled()
    expect(deps.installHooks).not.toHaveBeenCalled()
    expect(deps.markSetupPromptDeclined).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledTimes(1)
  })

  it('does not block the dashboard when hooks-installed detection throws (e.g. malformed settings.json)', async () => {
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => {
        throw new Error('refusing to modify malformed JSON at /fake/settings.json')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.promptConfirm).not.toHaveBeenCalled()
    expect(deps.runDashboard).toHaveBeenCalledTimes(1)
  })

  it('does not block the dashboard when persisting a decline fails (e.g. unwritable ~/.monomi)', async () => {
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => false),
      isSetupPromptDeclined: vi.fn(() => false),
      isInteractive: vi.fn(() => true),
      promptConfirm: vi.fn(async () => false),
      markSetupPromptDeclined: vi.fn(() => {
        throw new Error('EACCES: permission denied')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.runDashboard).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('install-hooks'))
  })

  it('does not block the dashboard when installHooks fails after acceptance (e.g. unwritable settings.json)', async () => {
    const deps = makeDeps({
      isHooksInstalled: vi.fn(() => false),
      isSetupPromptDeclined: vi.fn(() => false),
      isInteractive: vi.fn(() => true),
      promptConfirm: vi.fn(async () => true),
      installHooks: vi.fn(() => {
        throw new Error('EACCES: permission denied')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(0)
    expect(deps.installHooks).toHaveBeenCalledTimes(1)
    expect(deps.runDashboard).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('install-hooks'))
  })
})

describe('run locale wiring (release-9-i18n FR-02 AC-4 / AC-6)', () => {
  it('applies the locale resolved by deps.loadLocale before rendering any text (locale: ja)', async () => {
    const deps = makeDeps({ loadLocale: vi.fn(() => 'ja' as const) })
    const code = await run(['--help'], deps)
    expect(code).toBe(0)
    expect(deps.loadLocale).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('使い方'))
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('hub stop'))
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('hub status'))
  })

  it('still uses the English default when deps.loadLocale resolves "en"', async () => {
    const deps = makeDeps()
    const code = await run(['--help'], deps)
    expect(code).toBe(0)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Usage'))
  })

  it('converts an invalid-locale failure from deps.loadLocale into exit code 1 without a stack trace escaping run()', async () => {
    const deps = makeDeps({
      loadLocale: vi.fn(() => {
        throw new Error('invalid locale "fr": expected "ja" or "en"')
      }),
    })
    const code = await run([], deps)
    expect(code).toBe(1)
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('invalid locale'))
    expect(deps.runDashboard).not.toHaveBeenCalled()
  })
})

// `npm install -g` / `npm link` は bin をシンボリックリンクとして配置するため、
// `process.argv[1]` の直接起動判定はシンボリックリンクを実体パス（realpath）へ解決してから
// 比較する必要がある（解決しないと npm 経由でグローバルインストールした `monomi` が無反応になる）。
describe('resolveInvokedPath', () => {
  let tmpDir: string

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves a symlinked bin path to the target file realpath (npm install -g / npm link layout)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-cli-invoke-'))
    const targetFile = path.join(tmpDir, 'cli.js')
    fs.writeFileSync(targetFile, '')
    const symlinkPath = path.join(tmpDir, 'monomi')
    fs.symlinkSync(targetFile, symlinkPath)

    expect(resolveInvokedPath(symlinkPath)).toBe(fs.realpathSync(targetFile))
  })

  it('returns the path unchanged when it is already a real (non-symlink) path', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-cli-invoke-'))
    const realFile = path.join(tmpDir, 'cli.js')
    fs.writeFileSync(realFile, '')

    expect(resolveInvokedPath(realFile)).toBe(fs.realpathSync(realFile))
  })

  it('falls back to the given path without throwing when it does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-cli-invoke-'))
    const missingPath = path.join(tmpDir, 'does-not-exist.js')

    expect(resolveInvokedPath(missingPath)).toBe(missingPath)
  })

  it('returns undefined when argv[1] is undefined', () => {
    expect(resolveInvokedPath(undefined)).toBeUndefined()
  })
})
