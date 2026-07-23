import { describe, expect, it, vi } from 'vitest'
import type { RunOsascriptOptions } from './osascript.js'
import type { FocusTarget } from './types.js'
import type { ExecFileFn, WeztermFocusStrategyOptions } from './wezterm-strategy.js'
import {
  buildWeztermRaiseScript,
  raiseWeztermWindowDarwin,
  raiseWeztermWindowWsl,
  WEZTERM_TERM_PROGRAM,
  WeztermFocusStrategy,
} from './wezterm-strategy.js'

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

describe('WeztermFocusStrategy の command 候補配列（release-28-wezterm-focus 実機検証対応: PATH に無い場合のフォールバック）', () => {
  it('先頭候補が ENOENT なら次候補を試し、成功すれば ok を返す', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const execFile: WeztermFocusStrategyOptions['execFile'] = vi.fn(
      async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (command === 'wezterm') {
          const error = Object.assign(new Error('spawn wezterm ENOENT'), { code: 'ENOENT' })
          throw error
        }
        return { stdout: '', stderr: '' }
      }
    )
    const strategy = new WeztermFocusStrategy(
      ['wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm'],
      { execFile }
    )

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[0].command).toBe('wezterm')
    expect(calls[1].command).toBe('/Applications/WezTerm.app/Contents/MacOS/wezterm')
  })

  it('全候補が ENOENT なら not_found を返す', async () => {
    const execFile: WeztermFocusStrategyOptions['execFile'] = vi.fn(async () => {
      const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      throw error
    })
    const strategy = new WeztermFocusStrategy(['wezterm', '/opt/wezterm/wezterm'], { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('not_found')
  })

  it('先頭候補が ENOENT 以外のエラーなら次候補を試さず error を返す', async () => {
    const calls: string[] = []
    const execFile: WeztermFocusStrategyOptions['execFile'] = vi.fn(async (command: string) => {
      calls.push(command)
      const error = Object.assign(new Error('pane_id 3 not found'), { code: 1 })
      throw error
    })
    const strategy = new WeztermFocusStrategy(['wezterm', '/opt/wezterm/wezterm'], { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
    expect(calls).toEqual(['wezterm'])
  })

  it('verifyActivation 有効時、成功した候補コマンドで cli list を呼ぶ（候補探索をやり直さない）', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const execFile: WeztermFocusStrategyOptions['execFile'] = vi.fn(
      async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (command === 'wezterm') {
          const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          throw error
        }
        if (args[1] === 'list') {
          return { stdout: JSON.stringify([{ pane_id: 3 }]), stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }
    )
    const strategy = new WeztermFocusStrategy(
      ['wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm'],
      { execFile, verifyActivation: true }
    )

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(calls).toHaveLength(3)
    expect(calls[1].command).toBe('/Applications/WezTerm.app/Contents/MacOS/wezterm')
    expect(calls[2].command).toBe('/Applications/WezTerm.app/Contents/MacOS/wezterm')
  })

  it('単一文字列を渡した場合は従来どおり単一候補として扱う（後方互換）', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(execFile.calls).toHaveLength(1)
    expect(execFile.calls[0].command).toBe('wezterm')
  })
})

describe('WeztermFocusStrategy の raiseWindow（release-28-wezterm-focus 実機検証対応: OS レベルのウィンドウ前面化）', () => {
  it('raiseWindow 未指定なら activate-pane 成功のみで ok を返す（既存挙動、後方互換）', async () => {
    const execFile = mockExecFile('')
    const strategy = new WeztermFocusStrategy('wezterm', { execFile })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
  })

  it('activate-pane 成功後に raiseWindow が呼ばれ、成功すれば ok を返す', async () => {
    const execFile = mockExecFile('')
    const raiseWindow = vi.fn(async () => {})
    const strategy = new WeztermFocusStrategy('wezterm', { execFile, raiseWindow })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(raiseWindow).toHaveBeenCalledTimes(1)
  })

  it('raiseWindow が例外を投げたら error を返す（activate-pane 自体は成功していても無条件の成功にしない）', async () => {
    const execFile = mockExecFile('')
    const raiseWindow = vi.fn(async () => {
      throw new Error('WezTerm process not found via System Events')
    })
    const strategy = new WeztermFocusStrategy('wezterm', { execFile, raiseWindow })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
  })

  it('activate-pane 自体が失敗したら raiseWindow を呼ばない', async () => {
    const error = Object.assign(new Error('pane_id 3 not found'), { code: 1 })
    const execFile = mockExecFile(error)
    const raiseWindow = vi.fn(async () => {})
    const strategy = new WeztermFocusStrategy('wezterm', { execFile, raiseWindow })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
    expect(raiseWindow).not.toHaveBeenCalled()
  })

  it('verifyActivation が有効で検証に失敗したら raiseWindow を呼ばない', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const execFile: WeztermFocusStrategyOptions['execFile'] = vi.fn(
      async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (args[1] === 'list') {
          return { stdout: JSON.stringify([{ pane_id: 7 }]), stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }
    )
    const raiseWindow = vi.fn(async () => {})
    const strategy = new WeztermFocusStrategy('wezterm.exe', {
      execFile,
      verifyActivation: true,
      raiseWindow,
    })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('error')
    expect(raiseWindow).not.toHaveBeenCalled()
  })

  it('verifyActivation と raiseWindow の両方が有効で、両方成功すれば ok を返す', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const execFile: WeztermFocusStrategyOptions['execFile'] = vi.fn(
      async (command: string, args: string[]) => {
        calls.push({ command, args })
        if (args[1] === 'list') {
          return { stdout: JSON.stringify([{ pane_id: 3 }]), stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }
    )
    const raiseWindow = vi.fn(async () => {})
    const strategy = new WeztermFocusStrategy('wezterm.exe', {
      execFile,
      verifyActivation: true,
      raiseWindow,
    })

    const result = await strategy.focus(makeTarget({ weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(raiseWindow).toHaveBeenCalledTimes(1)
  })
})

describe('buildWeztermRaiseScript（release-28-wezterm-focus 実機検証対応）', () => {
  it('System Events ガード付きで WezTerm を activate する AppleScript を組み立てる', () => {
    const script = buildWeztermRaiseScript()

    expect(script).toContain('tell application "System Events"')
    expect(script).toContain('if not (exists process "WezTerm") then return "false"')
    expect(script).toContain('tell application "WezTerm"')
    expect(script).toContain('activate')
    expect(script).toContain('return "true"')
  })
})

describe('raiseWeztermWindowDarwin（release-28-wezterm-focus 実機検証対応）', () => {
  /** `runOsascript` の `exec`（`osascript.ts` の `ExecFileFn`）をモックする。 */
  function mockOsascriptExec(
    outcome: string | Error
  ): NonNullable<RunOsascriptOptions['exec']> & { calls: Array<{ script: string }> } {
    const calls: Array<{ script: string }> = []
    const fn = vi.fn(async (_command: string, args: string[]) => {
      calls.push({ script: args[1] ?? '' })
      if (outcome instanceof Error) {
        throw outcome
      }
      return { stdout: outcome, stderr: '' }
    })
    return Object.assign(fn, { calls }) as unknown as NonNullable<RunOsascriptOptions['exec']> & {
      calls: Array<{ script: string }>
    }
  }

  it('stdout が true なら成功する（例外を投げない）', async () => {
    const exec = mockOsascriptExec('true')

    await expect(raiseWeztermWindowDarwin({ exec })).resolves.toBeUndefined()
  })

  it('stdout が false（WezTerm 未起動と System Events が判定）なら例外を投げる', async () => {
    const exec = mockOsascriptExec('false')

    await expect(raiseWeztermWindowDarwin({ exec })).rejects.toThrow()
  })

  it('osascript 実行自体が失敗したら例外がそのまま伝播する', async () => {
    const exec = mockOsascriptExec(new Error('osascript failed'))

    await expect(raiseWeztermWindowDarwin({ exec })).rejects.toThrow('osascript failed')
  })
})

describe('raiseWeztermWindowWsl（release-28-wezterm-focus 実機検証対応、実 Windows/WSL2 環境では未検証）', () => {
  function mockExecFile(outcome: string | Error): ExecFileFn {
    return vi.fn(async () => {
      if (outcome instanceof Error) {
        throw outcome
      }
      return { stdout: outcome, stderr: '' }
    })
  }

  it('stdout に OK が含まれれば成功する', async () => {
    const execFile = mockExecFile('OK')

    await expect(raiseWeztermWindowWsl(execFile)).resolves.toBeUndefined()
  })

  it('stdout に NOT_FOUND が含まれれば（wezterm-gui プロセス不在）例外を投げる', async () => {
    const execFile = mockExecFile('NOT_FOUND')

    await expect(raiseWeztermWindowWsl(execFile)).rejects.toThrow()
  })

  it('powershell.exe 実行自体が失敗したら例外がそのまま伝播する', async () => {
    const execFile = mockExecFile(new Error('powershell.exe failed'))

    await expect(raiseWeztermWindowWsl(execFile)).rejects.toThrow('powershell.exe failed')
  })

  it('powershell.exe を非 shell（execFile）で呼び、wezterm-gui プロセス名をスクリプトへ埋め込む', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const execFile: ExecFileFn = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args })
      return { stdout: 'OK', stderr: '' }
    })

    await raiseWeztermWindowWsl(execFile)

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('powershell.exe')
    expect(calls[0].args).toContain('-Command')
    const script = calls[0].args[calls[0].args.length - 1]
    expect(script).toContain('Get-Process -Name "wezterm-gui"')
  })
})
