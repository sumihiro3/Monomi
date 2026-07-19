import { describe, expect, it, vi } from 'vitest'
import type { FocusTarget } from './types.js'
import type { WeztermFocusStrategyOptions } from './wezterm-strategy.js'
import { WEZTERM_TERM_PROGRAM, WeztermFocusStrategy } from './wezterm-strategy.js'

/** テスト用に {@link FocusTarget} を組み立てる(未指定フィールドは既定で null)。 */
function makeTarget(overrides: Partial<FocusTarget> = {}): FocusTarget {
  return {
    tty: null,
    termProgram: null,
    tmuxPane: null,
    tmuxSocket: null,
    wslDistro: null,
    wtSession: null,
    weztermPane: null,
    ...overrides,
  }
}

/** stdout（または throw する Error）を返すモック `execFile` を作る（`wsl-strategy.test.ts` 踏襲）。 */
function mockExecFile(outcome: string | Error): WeztermFocusStrategyOptions['execFile'] & {
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const fn = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args })
    if (outcome instanceof Error) {
      throw outcome
    }
    return { stdout: outcome, stderr: '' }
  })
  return Object.assign(fn, { calls }) as unknown as WeztermFocusStrategyOptions['execFile'] & {
    calls: Array<{ command: string; args: string[] }>
  }
}

describe('WeztermFocusStrategy.matchesHint（release-28-wezterm-focus FR-03b）', () => {
  const strategy = new WeztermFocusStrategy('wezterm')

  it('term_program が WezTerm のとき true', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: WEZTERM_TERM_PROGRAM }))).toBe(true)
  })

  it('term_program が Apple_Terminal のとき false', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: 'Apple_Terminal' }))).toBe(false)
  })

  it('term_program が ghostty のとき false', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: 'ghostty' }))).toBe(false)
  })

  it('term_program が null（tmux 内含む）のとき false', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: null }))).toBe(false)
  })
})

describe('WeztermFocusStrategy.focus（release-28-wezterm-focus FR-03b）', () => {
  it('command と引数配列が正しい（pane id が argv 要素として渡り、shell メタ文字が展開されない）', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    // 仮に検証をすり抜けたシェルメタ文字混入値が渡ってきても、execFile は非 shell 実行のため
    // argv の 1 要素としてそのまま渡るだけで、シェル展開されないことを確認する（二段防御の検証）。
    const injected = '3; rm -rf /'
    await strategy.focus(makeTarget({ weztermPane: injected }))

    expect(execFile.calls).toHaveLength(1)
    expect(execFile.calls[0]).toEqual({
      command: 'wezterm',
      args: ['cli', 'activate-pane', '--pane-id', injected],
    })
  })

  it('WSL interop 用に注入された command（wezterm.exe）で呼ばれる', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm.exe', { execFile })

    await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(execFile.calls[0].command).toBe('wezterm.exe')
  })

  it('exit 0（例外なし）なら ok を返す', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
  })

  it('execFile が ENOENT（PATH 上に wezterm 無し）で失敗したら not_found を返す', async () => {
    const error = Object.assign(new Error('spawn wezterm ENOENT'), { code: 'ENOENT' })
    const execFile = mockExecFile(error)
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('not_found')
  })

  it('ENOENT 以外の例外（pane 未検出等）は error を返す', async () => {
    const error = Object.assign(new Error('pane_id 3 not found'), { code: 1 })
    const execFile = mockExecFile(error)
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
  })

  it('code プロパティを持たない例外も error を返す', async () => {
    const execFile = mockExecFile(new Error('unexpected failure'))
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
  })

  it('weztermPane が null なら execFile を呼ばず not_found を返す', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: null }))

    expect(result).toBe('not_found')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('execFile にタイムアウトオプションを渡す（review-changes 修正: ハング防止）', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1)
    const options = vi.mocked(execFile).mock.calls[0]?.[2]
    expect(options?.timeout).toBeGreaterThan(0)
  })
})

describe('WeztermFocusStrategy の in-flight ガード（release-28-wezterm-focus 所見対応: f キー連打での子プロセス蓄積防止）', () => {
  /** 呼び出し側から明示的に resolve/reject できる制御可能な execFile モックを作る。 */
  function deferredExecFile(): {
    execFile: WeztermFocusStrategyOptions['execFile']
    calls: Array<{ command: string; args: string[] }>
    resolve: (outcome: { stdout: string; stderr: string }) => void
  } {
    const calls: Array<{ command: string; args: string[] }> = []
    let resolveFn: ((outcome: { stdout: string; stderr: string }) => void) | undefined
    const fn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args })
      return new Promise<{ stdout: string; stderr: string }>((resolve) => {
        resolveFn = resolve
      })
    })
    return {
      execFile: fn as unknown as WeztermFocusStrategyOptions['execFile'],
      calls,
      resolve: (outcome) => resolveFn?.(outcome),
    }
  }

  it('前回呼び出しが未完了のうちに focus() を再度呼んでも execFile は 1 回しか起動されず、両方の呼び出しが同じ結果を得る', async () => {
    const { execFile, calls, resolve } = deferredExecFile()
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    const first = strategy.focus(makeTarget({ weztermPane: '3' }))
    const second = strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(calls).toHaveLength(1)
    resolve({ stdout: '', stderr: '' })

    await expect(first).resolves.toBe('ok')
    await expect(second).resolves.toBe('ok')
    expect(calls).toHaveLength(1)
  })

  it('先の呼び出しが完了した後は、新たな focus() が改めて execFile を起動する', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    await strategy.focus(makeTarget({ weztermPane: '3' }))
    await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(execFile.calls).toHaveLength(2)
  })
})

describe('WeztermFocusStrategy の verifyActivation（release-28-wezterm-focus 所見対応: WSL interop のサイレント失敗対策）', () => {
  /** `cli activate-pane` → `cli list --format json` の順に固定 stdout を返すモック execFile を作る。 */
  function mockExecFileSequence(
    outcomes: Array<string | Error>
  ): WeztermFocusStrategyOptions['execFile'] & {
    calls: Array<{ command: string; args: string[] }>
  } {
    const calls: Array<{ command: string; args: string[] }> = []
    const queue = [...outcomes]
    const fn = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args })
      const outcome = queue.shift()
      if (outcome === undefined) {
        throw new Error('mockExecFileSequence: 想定より多く呼び出された')
      }
      if (outcome instanceof Error) {
        throw outcome
      }
      return { stdout: outcome, stderr: '' }
    })
    return Object.assign(fn, { calls }) as unknown as WeztermFocusStrategyOptions['execFile'] & {
      calls: Array<{ command: string; args: string[] }>
    }
  }

  it('verifyActivation が既定 false のときは activate-pane 成功のみで ok を返し、cli list は呼ばない', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm.exe', { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(execFile.calls).toHaveLength(1)
  })

  it('verifyActivation が true で cli list に対象 pane id が含まれていれば ok を返す', async () => {
    const execFile = mockExecFileSequence(['', JSON.stringify([{ pane_id: 3 }, { pane_id: 7 }])])
    const strategy = new WeztermFocusStrategy('wezterm.exe', { execFile, verifyActivation: true })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(execFile.calls).toHaveLength(2)
    expect(execFile.calls[1]).toEqual({
      command: 'wezterm.exe',
      args: ['cli', 'list', '--format', 'json'],
    })
  })

  it('verifyActivation が true で cli list に対象 pane id が含まれていなければ error を返す（サイレント失敗を検知しフォールバックへ進める）', async () => {
    const execFile = mockExecFileSequence(['', JSON.stringify([{ pane_id: 7 }])])
    const strategy = new WeztermFocusStrategy('wezterm.exe', { execFile, verifyActivation: true })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
  })

  it('verifyActivation が true で cli list 自体が失敗したら error を返す（検証手段が信頼できない場合は最終成功にしない）', async () => {
    const execFile = mockExecFileSequence(['', new Error('wezterm.exe cli list failed')])
    const strategy = new WeztermFocusStrategy('wezterm.exe', { execFile, verifyActivation: true })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
  })

  it('verifyActivation が true で cli list が不正な形式（配列でない JSON）を返したら error を返す', async () => {
    const execFile = mockExecFileSequence(['', JSON.stringify({ not: 'an array' })])
    const strategy = new WeztermFocusStrategy('wezterm.exe', { execFile, verifyActivation: true })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
  })
})
