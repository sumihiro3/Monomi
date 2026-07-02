import { describe, expect, it, vi } from 'vitest'
import { run, type CliDeps } from './cli.js'
import type { InstallHooksResult } from './install-hooks/install-hooks.js'

/** テスト用の {@link CliDeps}。全ハンドラをモックにし、呼び出しの検証だけに専念する。 */
function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    installHooks: vi.fn((): InstallHooksResult => ({
      settingsPath: '/fake/settings.json',
      added: 8,
      removed: 0,
    })),
    uninstallHooks: vi.fn((): InstallHooksResult => ({
      settingsPath: '/fake/settings.json',
      added: 0,
      removed: 8,
    })),
    runHub: vi.fn(async () => {}),
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
    expect(deps.log).toHaveBeenCalledWith('0.0.1')
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
