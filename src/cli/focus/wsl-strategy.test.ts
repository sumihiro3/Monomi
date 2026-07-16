import { describe, expect, it, vi } from 'vitest'
import type { WslFocusStrategyOptions } from './wsl-strategy.js'
import { WslFocusStrategy } from './wsl-strategy.js'

/** stdout（または throw する Error）を返すモック `execFile` を作る。 */
function mockExecFile(
  outcome: string | Error
): WslFocusStrategyOptions['execFile'] & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const fn = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args })
    if (outcome instanceof Error) {
      throw outcome
    }
    return { stdout: outcome, stderr: '' }
  })
  return Object.assign(fn, { calls }) as unknown as WslFocusStrategyOptions['execFile'] & {
    calls: Array<{ command: string; args: string[] }>
  }
}

describe('WslFocusStrategy.focus（release-23-terminal-focus FR-04c AC-7）', () => {
  it('powershell.exe を正しい引数（非対話・プロファイル無し）で呼ぶ', async () => {
    const execFile = mockExecFile('OK')
    const strategy = new WslFocusStrategy({ execFile })

    await strategy.focus('/dev/pts/3')

    expect(execFile.calls).toHaveLength(1)
    expect(execFile.calls[0].command).toBe('powershell.exe')
    expect(execFile.calls[0].args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ])
  })

  it('スクリプトは WindowsTerminal プロセスと SetForegroundWindow を参照する', async () => {
    const execFile = mockExecFile('OK')
    const strategy = new WslFocusStrategy({ execFile })

    await strategy.focus(null)

    const script = execFile.calls[0].args[3]
    expect(script).toContain('WindowsTerminal')
    expect(script).toContain('SetForegroundWindow')
  })

  it('stdout に OK が含まれれば ok を返す', async () => {
    const execFile = mockExecFile('OK\n')
    const strategy = new WslFocusStrategy({ execFile })

    const result = await strategy.focus('/dev/pts/3')

    expect(result).toBe('ok')
  })

  it('stdout に NOT_FOUND が含まれれば not_found を返す（Windows Terminal 未起動）', async () => {
    const execFile = mockExecFile('NOT_FOUND\n')
    const strategy = new WslFocusStrategy({ execFile })

    const result = await strategy.focus('/dev/pts/3')

    expect(result).toBe('not_found')
  })

  it('予期しない stdout は error を返す', async () => {
    const execFile = mockExecFile('something unexpected')
    const strategy = new WslFocusStrategy({ execFile })

    const result = await strategy.focus('/dev/pts/3')

    expect(result).toBe('error')
  })

  it('execFile が失敗（powershell.exe 不在など）したら error を返す', async () => {
    const execFile = mockExecFile(new Error('spawn powershell.exe ENOENT'))
    const strategy = new WslFocusStrategy({ execFile })

    const result = await strategy.focus('/dev/pts/3')

    expect(result).toBe('error')
  })

  it('tty は best-effort のため参照しなくても呼び出せる（null でも動作する）', async () => {
    const execFile = mockExecFile('OK')
    const strategy = new WslFocusStrategy({ execFile })

    const result = await strategy.focus(null)

    expect(result).toBe('ok')
  })
})
