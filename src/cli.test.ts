import { afterEach, describe, expect, it, vi } from 'vitest'
import { run, type CliDeps } from './cli.js'
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
    loadLocale: vi.fn(() => 'en' as const),
    listDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(async (deviceId: string) => ({
      ok: true,
      device_id: deviceId,
      revoked: 0,
    })),
    hubPair: vi.fn(async () => {}),
    childPair: vi.fn(async () => {}),
    runDashboard: vi.fn(async () => {}),
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

  it('routes "hub" to the hub server entrypoint (FR-03)', async () => {
    const deps = makeDeps()
    const code = await run(['hub'], deps)
    expect(code).toBe(0)
    expect(deps.runHub).toHaveBeenCalledTimes(1)
    expect(deps.runDashboard).not.toHaveBeenCalled()
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

  it.each(['--help', '-h'])('%s prints usage', async (flag) => {
    const deps = makeDeps()
    const code = await run([flag], deps)
    expect(code).toBe(0)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('monomi'))
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

  it('converts a thrown error from "hub" into exit code 1 (e.g. port already in use)', async () => {
    const deps = makeDeps({
      runHub: vi.fn(async () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:47632')
      }),
    })
    const code = await run(['hub'], deps)
    expect(code).toBe(1)
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'))
  })
})

describe('run locale wiring (release-9-i18n FR-02 AC-4 / AC-6)', () => {
  it('applies the locale resolved by deps.loadLocale before rendering any text (locale: ja)', async () => {
    const deps = makeDeps({ loadLocale: vi.fn(() => 'ja' as const) })
    const code = await run(['--help'], deps)
    expect(code).toBe(0)
    expect(deps.loadLocale).toHaveBeenCalledTimes(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('使い方'))
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
