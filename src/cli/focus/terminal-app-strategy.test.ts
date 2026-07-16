import { describe, expect, it, vi } from 'vitest'
import type { ExecFileFn } from './osascript.js'
import {
  buildTerminalAppFocusScript,
  TERMINAL_APP_TERM_PROGRAM,
  TerminalAppStrategy,
} from './terminal-app-strategy.js'
import type { FocusTarget } from './types.js'

/** テスト用に {@link FocusTarget} を組み立てる（未指定フィールドは既定で null）。 */
function makeTarget(overrides: Partial<FocusTarget> = {}): FocusTarget {
  return {
    tty: null,
    termProgram: null,
    tmuxPane: null,
    tmuxSocket: null,
    wslDistro: null,
    wtSession: null,
    ...overrides,
  }
}

/**
 * 発行された `command`/`args` を記録しつつ指定 stdout を返す（または reject する）モック
 * `ExecFileFn` を作る。
 *
 * @param outcome 通常は返す stdout。`Error` を渡すと exec 自体が reject する
 *   （osascript 実行失敗・Terminal.app 未起動等の再現用）。
 */
function mockExec(
  outcome: string | Error
): ExecFileFn & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const fn = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args })
    if (outcome instanceof Error) {
      throw outcome
    }
    return { stdout: outcome, stderr: '' }
  })
  return Object.assign(fn, { calls }) as unknown as ExecFileFn & {
    calls: Array<{ command: string; args: string[] }>
  }
}

describe('buildTerminalAppFocusScript（release-23-terminal-focus FR-04b AC-3）', () => {
  it('tty をエスケープした上で tty of aTab との比較式に埋め込む', () => {
    const script = buildTerminalAppFocusScript('/dev/ttys003')
    expect(script).toContain('tell application "Terminal"')
    expect(script).toContain('if tty of t is "/dev/ttys003" then')
    expect(script).toContain('return "true"')
    expect(script).toContain('return "false"')
  })

  it('見つかったタブのウィンドウを frontmost にし、タブを selected にして activate する', () => {
    const script = buildTerminalAppFocusScript('/dev/ttys003')
    expect(script).toContain('set frontmost of foundWindow to true')
    expect(script).toContain('set selected of foundTab to true')
    expect(script).toContain('activate')
  })

  it('tty に含まれる引用符・バックスラッシュはエスケープされ、文字列リテラルから抜け出せない', () => {
    const malicious = '" & (do shell script "rm -rf ~") & "'
    const script = buildTerminalAppFocusScript(malicious)
    expect(script).not.toContain(`is "${malicious}"`)
    expect(script).toContain('if tty of t is "\\" & (do shell script \\"rm -rf ~\\") & \\"" then')
  })
})

describe('TerminalAppStrategy.matchesHint（AC-6）', () => {
  const strategy = new TerminalAppStrategy()

  it('term_program が Apple_Terminal のとき true', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: TERMINAL_APP_TERM_PROGRAM }))).toBe(true)
  })

  it('term_program が Ghostty のとき false', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: 'ghostty' }))).toBe(false)
  })

  it('term_program が null（tmux 内含む）のとき false', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: null }))).toBe(false)
  })
})

describe('TerminalAppStrategy.focus（AC-3）', () => {
  it('osascript を execFile（非 shell）で "osascript" "-e" <script> として発行する', async () => {
    const exec = mockExec('true')
    const strategy = new TerminalAppStrategy({ exec })

    await strategy.focus('/dev/ttys003')

    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0]?.command).toBe('osascript')
    expect(exec.calls[0]?.args[0]).toBe('-e')
    expect(exec.calls[0]?.args[1]).toBe(buildTerminalAppFocusScript('/dev/ttys003'))
  })

  it('stdout が "true" なら ok を返す', async () => {
    const strategy = new TerminalAppStrategy({ exec: mockExec('true') })

    await expect(strategy.focus('/dev/ttys003')).resolves.toBe('ok')
  })

  it('stdout が "false"（対象タブなし）なら not_found を返す', async () => {
    const strategy = new TerminalAppStrategy({ exec: mockExec('false') })

    await expect(strategy.focus('/dev/ttys003')).resolves.toBe('not_found')
  })

  it('stdout の前後空白は無視して判定する（osascript.ts の trim 済み結果を前提）', async () => {
    const strategy = new TerminalAppStrategy({ exec: mockExec('true\n') })

    await expect(strategy.focus('/dev/ttys003')).resolves.toBe('ok')
  })

  it('osascript 実行自体が失敗（Terminal.app 未起動・権限不足等）したら error を返す', async () => {
    const strategy = new TerminalAppStrategy({
      exec: mockExec(new Error('Application isn’t running')),
    })

    await expect(strategy.focus('/dev/ttys003')).resolves.toBe('error')
  })
})
