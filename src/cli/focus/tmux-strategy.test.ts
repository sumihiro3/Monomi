import { describe, expect, it, vi } from 'vitest'
import {
  parseTmuxClients,
  TmuxFocusStrategy,
  type TmuxFocusStrategyOptions,
} from './tmux-strategy.js'
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
 * `list-clients` の stdout を差し替えつつ、以降のコマンド呼び出しを記録するモック `execFile` を作る。
 *
 * @param listClientsStdout `list-clients` 呼び出しに対して返す stdout（`null` を渡すと reject する）。
 * @param onCommand `list-clients` 以外（switch-client/select-window/select-pane）が失敗すべきものは
 *   `Error` を返す関数として渡す。
 */
function mockExecFile(
  listClientsStdout: string | null,
  onCommand: (subcommand: string, args: string[]) => Error | undefined = () => undefined
): TmuxFocusStrategyOptions['execFile'] & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const fn = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args })
    const subcommand = args[2]
    if (subcommand === 'list-clients') {
      if (listClientsStdout === null) {
        throw new Error('no server running on socket')
      }
      return { stdout: listClientsStdout, stderr: '' }
    }
    const error = onCommand(subcommand, args)
    if (error) {
      throw error
    }
    return { stdout: '', stderr: '' }
  })
  return Object.assign(fn, { calls }) as unknown as TmuxFocusStrategyOptions['execFile'] & {
    calls: Array<{ command: string; args: string[] }>
  }
}

describe('parseTmuxClients（release-23-terminal-focus FR-04c AC-5）', () => {
  it('タブ区切りの tty/activity を解析する', () => {
    const stdout = '/dev/ttys001\t1000\n/dev/ttys002\t2000\n'
    expect(parseTmuxClients(stdout)).toEqual([
      { tty: '/dev/ttys001', activity: 1000 },
      { tty: '/dev/ttys002', activity: 2000 },
    ])
  })

  it('空文字列は 0 件になる', () => {
    expect(parseTmuxClients('')).toEqual([])
  })

  it('空行は無視する', () => {
    const stdout = '\n/dev/ttys001\t1000\n\n\n/dev/ttys002\t2000\n\n'
    expect(parseTmuxClients(stdout)).toEqual([
      { tty: '/dev/ttys001', activity: 1000 },
      { tty: '/dev/ttys002', activity: 2000 },
    ])
  })

  it('activity が数値化できない行は 0 として扱う（安全側フォールバック）', () => {
    expect(parseTmuxClients('/dev/ttys001\tNaN-ish')).toEqual([
      { tty: '/dev/ttys001', activity: 0 },
    ])
  })

  it('tty が空の行は破棄する', () => {
    expect(parseTmuxClients('\t1000\n/dev/ttys001\t2000')).toEqual([
      { tty: '/dev/ttys001', activity: 2000 },
    ])
  })
})

describe('TmuxFocusStrategy.switchClient（release-23-terminal-focus FR-04c AC-5）', () => {
  it('tmuxPane が null なら execFile を呼ばず tmux_detached を返す', async () => {
    const execFile = mockExecFile(null)
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(makeTarget({ tmuxSocket: '/tmp/tmux-501/default' }))

    expect(result).toEqual({ result: 'tmux_detached' })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('tmuxSocket が null なら execFile を呼ばず tmux_detached を返す', async () => {
    const execFile = mockExecFile(null)
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(makeTarget({ tmuxPane: '%3' }))

    expect(result).toEqual({ result: 'tmux_detached' })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('0 件（空 stdout）なら tmux_detached を返し、切替コマンドは発行しない', async () => {
    const execFile = mockExecFile('')
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(
      makeTarget({ tmuxPane: '%3', tmuxSocket: '/tmp/tmux-501/default' })
    )

    expect(result).toEqual({ result: 'tmux_detached' })
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('list-clients 自体が失敗（サーバー未起動など）なら tmux_detached を返す', async () => {
    const execFile = mockExecFile(null)
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(
      makeTarget({ tmuxPane: '%3', tmuxSocket: '/tmp/tmux-501/default' })
    )

    expect(result).toEqual({ result: 'tmux_detached' })
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('list-clients が正しいコマンド・引数で呼ばれる', async () => {
    const execFile = mockExecFile('/dev/ttys005\t1000\n')
    const strategy = new TmuxFocusStrategy({ execFile })

    await strategy.switchClient(makeTarget({ tmuxPane: '%3', tmuxSocket: '/tmp/tmux-501/default' }))

    expect(execFile.calls[0]).toEqual({
      command: 'tmux',
      args: [
        '-S',
        '/tmp/tmux-501/default',
        'list-clients',
        '-F',
        '#{client_tty}\t#{client_activity}',
      ],
    })
  })

  it('1 件なら そのクライアントで switch-client/select-window/select-pane を順に実行し、tty を返す', async () => {
    const execFile = mockExecFile('/dev/ttys005\t1000\n')
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(
      makeTarget({ tmuxPane: '%3', tmuxSocket: '/tmp/tmux-501/default' })
    )

    expect(result).toEqual({ result: 'ok', tty: '/dev/ttys005' })
    expect(execFile.calls.slice(1)).toEqual([
      {
        command: 'tmux',
        args: ['-S', '/tmp/tmux-501/default', 'switch-client', '-c', '/dev/ttys005', '-t', '%3'],
      },
      { command: 'tmux', args: ['-S', '/tmp/tmux-501/default', 'select-window', '-t', '%3'] },
      { command: 'tmux', args: ['-S', '/tmp/tmux-501/default', 'select-pane', '-t', '%3'] },
    ])
  })

  it('複数件なら client_activity 最大のクライアントを採用する（AC-5）', async () => {
    const execFile = mockExecFile('/dev/ttys001\t500\n/dev/ttys002\t2000\n/dev/ttys003\t1500\n')
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(
      makeTarget({ tmuxPane: '%7', tmuxSocket: '/tmp/tmux-501/default' })
    )

    expect(result).toEqual({ result: 'ok', tty: '/dev/ttys002' })
    expect(execFile.calls[1]).toEqual({
      command: 'tmux',
      args: ['-S', '/tmp/tmux-501/default', 'switch-client', '-c', '/dev/ttys002', '-t', '%7'],
    })
  })

  it('activity が同値なら list-clients の出力順で先勝ちする', async () => {
    const execFile = mockExecFile('/dev/ttys001\t1000\n/dev/ttys002\t1000\n')
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(
      makeTarget({ tmuxPane: '%1', tmuxSocket: '/tmp/tmux-501/default' })
    )

    expect(result).toEqual({ result: 'ok', tty: '/dev/ttys001' })
  })

  it('switch-client が失敗したら error を返す', async () => {
    const execFile = mockExecFile('/dev/ttys005\t1000\n', (subcommand) =>
      subcommand === 'switch-client' ? new Error('no such client') : undefined
    )
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(
      makeTarget({ tmuxPane: '%3', tmuxSocket: '/tmp/tmux-501/default' })
    )

    expect(result).toEqual({ result: 'error' })
  })

  it('select-pane が失敗したら error を返す', async () => {
    const execFile = mockExecFile('/dev/ttys005\t1000\n', (subcommand) =>
      subcommand === 'select-pane' ? new Error('cant find pane') : undefined
    )
    const strategy = new TmuxFocusStrategy({ execFile })

    const result = await strategy.switchClient(
      makeTarget({ tmuxPane: '%3', tmuxSocket: '/tmp/tmux-501/default' })
    )

    expect(result).toEqual({ result: 'error' })
  })
})
