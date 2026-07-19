import { describe, expect, it, vi } from 'vitest'
import { defaultIsWsl, FocusService } from './focus-service.js'
import type { FocusResult, FocusTarget, Strategy, TmuxStrategy, WslStrategy } from './types.js'
import { WeztermFocusStrategy } from './wezterm-strategy.js'

/** テスト用に {@link FocusTarget} を組み立てる（未指定フィールドは既定で null）。 */
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

/**
 * モック {@link Strategy} を作る。
 *
 * @param matchesHint `matchesHint` の戻り値（並べ替え順を制御する）。
 * @param outcome 通常は `focus()` の戻り値。`Error` を渡すと `focus()` がそれを throw する
 *   （strategy 例外の丸め込み検証用）。
 * @param calls 呼び出し順序を検証するための共有ログ配列（省略可）。
 */
function mockStrategy(
  name: string,
  matchesHint: boolean,
  outcome: FocusResult | Error,
  calls: string[] = []
): Strategy & { focus: ReturnType<typeof vi.fn>; matchesHint: ReturnType<typeof vi.fn> } {
  return {
    matchesHint: vi.fn(() => matchesHint),
    focus: vi.fn(async (_target: FocusTarget) => {
      calls.push(name)
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    }),
  }
}

/** モック {@link TmuxStrategy} を作る。 */
function mockTmuxStrategy(
  outcome: Awaited<ReturnType<TmuxStrategy['switchClient']>> | Error
): TmuxStrategy & { switchClient: ReturnType<typeof vi.fn> } {
  return {
    switchClient: vi.fn(async (_target: FocusTarget) => {
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    }),
  }
}

/** モック {@link WslStrategy} を作る。 */
function mockWslStrategy(
  outcome: FocusResult | Error
): WslStrategy & { focus: ReturnType<typeof vi.fn> } {
  return {
    focus: vi.fn(async (_tty: string | null) => {
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    }),
  }
}

/** darwin プラットフォーム固定の {@link FocusService} を作る簡便ヘルパー。 */
function makeDarwinService(options: {
  darwinStrategies: Strategy[]
  tmuxStrategy?: TmuxStrategy
  wslStrategy?: WslStrategy
}): FocusService {
  return new FocusService({
    darwinStrategies: options.darwinStrategies,
    tmuxStrategy: options.tmuxStrategy ?? mockTmuxStrategy(new Error('unused')),
    wslStrategy: options.wslStrategy ?? mockWslStrategy('error'),
    platform: 'darwin',
  })
}

describe('FocusService.focus (FR-04d AC-6)', () => {
  it('returns no_terminal when the target itself is null (caller skipped the null check)', async () => {
    const strategy = mockStrategy('a', true, 'ok')
    const service = makeDarwinService({ darwinStrategies: [strategy] })

    const result = await service.focus(null)

    expect(result).toBe('no_terminal')
    expect(strategy.focus).not.toHaveBeenCalled()
  })

  it('returns no_terminal when tty and tmuxPane are both null', async () => {
    const strategy = mockStrategy('a', true, 'ok')
    const service = makeDarwinService({ darwinStrategies: [strategy] })

    const result = await service.focus(makeTarget())

    expect(result).toBe('no_terminal')
    expect(strategy.focus).not.toHaveBeenCalled()
  })

  it('tries tmux first when tmuxPane is present, and skips darwin strategies on tmux_detached', async () => {
    const tmux = mockTmuxStrategy({ result: 'tmux_detached' })
    const darwinStrategy = mockStrategy('a', true, 'ok')
    const service = makeDarwinService({
      darwinStrategies: [darwinStrategy],
      tmuxStrategy: tmux,
    })

    const result = await service.focus(makeTarget({ tmuxPane: '%3', tty: '/dev/ttys009' }))

    expect(result).toBe('tmux_detached')
    expect(tmux.switchClient).toHaveBeenCalledTimes(1)
    expect(darwinStrategy.focus).not.toHaveBeenCalled()
  })

  it('propagates tmux switchClient error without falling back to darwin strategies', async () => {
    const tmux = mockTmuxStrategy({ result: 'error' })
    const darwinStrategy = mockStrategy('a', true, 'ok')
    const service = makeDarwinService({
      darwinStrategies: [darwinStrategy],
      tmuxStrategy: tmux,
    })

    const result = await service.focus(makeTarget({ tmuxPane: '%3' }))

    expect(result).toBe('error')
    expect(darwinStrategy.focus).not.toHaveBeenCalled()
  })

  it('continues with the outer client tty returned by a successful tmux switch', async () => {
    const tmux = mockTmuxStrategy({ result: 'ok', tty: '/dev/ttys777' })
    const darwinStrategy = mockStrategy('a', true, 'ok')
    const service = makeDarwinService({
      darwinStrategies: [darwinStrategy],
      tmuxStrategy: tmux,
    })

    // tty（内側 pts 相当）は tmux 切替後の外側クライアント TTY で上書きされ、そちらが使われる。
    const result = await service.focus(
      makeTarget({ tmuxPane: '%3', tty: '/dev/ttys001-inner-pts' })
    )

    expect(result).toBe('ok')
    // strategy 側は target.tty を参照するため、tmux 切替後の外側クライアント TTY へ差し替えた
    // target が渡ることを確認する（release-28-wezterm-focus FR-04-pre）。
    expect(darwinStrategy.focus).toHaveBeenCalledWith(
      makeTarget({ tmuxPane: '%3', tty: '/dev/ttys777' })
    )
  })

  it('treats a tmux switch success without a resolvable tty as no_terminal', async () => {
    // 型上 tty は string（null になり得ない）だが、実装の防御的分岐（tty === null チェック）を
    // 直接確認するため、意図的に型を無視して null 相当の戻り値を注入する。
    const tmux: TmuxStrategy = {
      switchClient: vi.fn(async () => ({ result: 'ok', tty: null }) as never),
    }
    const darwinStrategy = mockStrategy('a', true, 'ok')
    const service = makeDarwinService({ darwinStrategies: [darwinStrategy], tmuxStrategy: tmux })

    const result = await service.focus(makeTarget({ tmuxPane: '%3', tty: '/dev/ttys001' }))

    expect(result).toBe('no_terminal')
    expect(darwinStrategy.focus).not.toHaveBeenCalled()
  })

  it('tries the term_program-matching strategy first on darwin', async () => {
    const calls: string[] = []
    const ghostty = mockStrategy('ghostty', false, 'ok', calls)
    const terminalApp = mockStrategy('terminalApp', true, 'ok', calls)
    const service = makeDarwinService({ darwinStrategies: [ghostty, terminalApp] })

    const result = await service.focus(
      makeTarget({ tty: '/dev/ttys003', termProgram: 'Apple_Terminal' })
    )

    expect(result).toBe('ok')
    expect(calls).toEqual(['terminalApp'])
    expect(ghostty.focus).not.toHaveBeenCalled()
  })

  it('falls through to the next strategy in array order when the first returns not_found', async () => {
    const calls: string[] = []
    const first = mockStrategy('first', false, 'not_found', calls)
    const second = mockStrategy('second', false, 'ok', calls)
    const service = makeDarwinService({ darwinStrategies: [first, second] })

    const result = await service.focus(makeTarget({ tty: '/dev/ttys003' }))

    expect(result).toBe('ok')
    expect(calls).toEqual(['first', 'second'])
  })

  it('preserves array order as a plain round-robin when no hint matches (e.g. inside tmux, TERM_PROGRAM=tmux)', async () => {
    const calls: string[] = []
    const first = mockStrategy('first', false, 'ok', calls)
    const second = mockStrategy('second', false, 'ok', calls)
    const service = makeDarwinService({ darwinStrategies: [first, second] })

    await service.focus(makeTarget({ tty: '/dev/ttys003', termProgram: 'tmux' }))

    expect(calls).toEqual(['first'])
    expect(second.focus).not.toHaveBeenCalled()
  })

  it('returns not_found when every darwin strategy misses', async () => {
    const first = mockStrategy('first', false, 'not_found')
    const second = mockStrategy('second', false, 'not_found')
    const service = makeDarwinService({ darwinStrategies: [first, second] })

    const result = await service.focus(makeTarget({ tty: '/dev/ttys003' }))

    expect(result).toBe('not_found')
  })

  it('returns not_found when no darwin strategies are configured', async () => {
    const service = makeDarwinService({ darwinStrategies: [] })

    const result = await service.focus(makeTarget({ tty: '/dev/ttys003' }))

    expect(result).toBe('not_found')
  })

  it('returns the last attempted result (error) when the round-robin ends without success', async () => {
    const first = mockStrategy('first', true, 'not_found')
    const second = mockStrategy('second', false, 'error')
    const service = makeDarwinService({ darwinStrategies: [first, second] })

    const result = await service.focus(makeTarget({ tty: '/dev/ttys003' }))

    expect(result).toBe('error')
  })

  it('rounds an unexpected strategy exception to error and keeps trying subsequent strategies', async () => {
    const calls: string[] = []
    const throwing = mockStrategy('throwing', true, new Error('osascript exploded'), calls)
    const fallback = mockStrategy('fallback', false, 'ok', calls)
    const service = makeDarwinService({ darwinStrategies: [throwing, fallback] })

    const result = await service.focus(makeTarget({ tty: '/dev/ttys003' }))

    expect(result).toBe('ok')
    expect(calls).toEqual(['throwing', 'fallback'])
  })

  it('rounds an unexpected tmux switchClient exception to error', async () => {
    const tmux = mockTmuxStrategy(new Error('tmux binary missing'))
    const darwinStrategy = mockStrategy('a', true, 'ok')
    const service = makeDarwinService({ darwinStrategies: [darwinStrategy], tmuxStrategy: tmux })

    const result = await service.focus(makeTarget({ tmuxPane: '%3' }))

    expect(result).toBe('error')
    expect(darwinStrategy.focus).not.toHaveBeenCalled()
  })

  it('dispatches to the WSL strategy when not darwin and isWsl() is true', async () => {
    const wsl = mockWslStrategy('ok')
    const darwinStrategy = mockStrategy('a', true, 'ok')
    const service = new FocusService({
      darwinStrategies: [darwinStrategy],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      platform: 'linux',
      isWsl: () => true,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3' }))

    expect(result).toBe('ok')
    expect(wsl.focus).toHaveBeenCalledWith('/dev/pts/3')
    expect(darwinStrategy.focus).not.toHaveBeenCalled()
  })

  it('rounds an unexpected WSL strategy exception to error', async () => {
    const wsl = mockWslStrategy(new Error('powershell.exe missing'))
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      platform: 'linux',
      isWsl: () => true,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3' }))

    expect(result).toBe('error')
  })

  it('returns unsupported_platform when not darwin and not WSL', async () => {
    const wsl = mockWslStrategy('ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      platform: 'linux',
      isWsl: () => false,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3' }))

    expect(result).toBe('unsupported_platform')
    expect(wsl.focus).not.toHaveBeenCalled()
  })

  it('defaults platform to process.platform when the option is omitted', async () => {
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      const wsl = mockWslStrategy('ok')
      const darwinStrategy = mockStrategy('a', true, 'ok')
      const service = new FocusService({
        darwinStrategies: [darwinStrategy],
        tmuxStrategy: mockTmuxStrategy(new Error('unused')),
        wslStrategy: wsl,
        isWsl: () => true,
      })

      const result = await service.focus(makeTarget({ tty: '/dev/pts/3' }))

      expect(result).toBe('ok')
      expect(wsl.focus).toHaveBeenCalledWith('/dev/pts/3')
      expect(darwinStrategy.focus).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('defaults isWsl to defaultIsWsl when the option is omitted', async () => {
    const wsl = mockWslStrategy('ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      platform: 'linux',
      // isWsl 省略 → defaultIsWsl() が実環境を見る。テストマシンが WSL である可能性は無い前提。
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3' }))

    expect(result).toBe('unsupported_platform')
    expect(wsl.focus).not.toHaveBeenCalled()
  })
})

describe('FocusService.focus - WezTerm dispatch (release-28-wezterm-focus FR-04)', () => {
  it('tries weztermWslStrategy first on WSL2 when weztermPane is present, and skips the Windows Terminal fallback on success', async () => {
    const weztermWsl = mockStrategy('weztermWsl', false, 'ok')
    const wsl = mockWslStrategy('ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      weztermWslStrategy: weztermWsl,
      platform: 'linux',
      isWsl: () => true,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3', weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(weztermWsl.focus).toHaveBeenCalledWith(
      makeTarget({ tty: '/dev/pts/3', weztermPane: '3' })
    )
    expect(wsl.focus).not.toHaveBeenCalled()
  })

  it('falls back to the Windows Terminal wslStrategy when weztermWslStrategy fails on WSL2', async () => {
    const weztermWsl = mockStrategy('weztermWsl', false, 'not_found')
    const wsl = mockWslStrategy('ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      weztermWslStrategy: weztermWsl,
      platform: 'linux',
      isWsl: () => true,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3', weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(weztermWsl.focus).toHaveBeenCalledTimes(1)
    expect(wsl.focus).toHaveBeenCalledWith('/dev/pts/3')
  })

  it('goes straight to the wslStrategy fallback on WSL2 when weztermPane is absent, even with weztermWslStrategy configured', async () => {
    const weztermWsl = mockStrategy('weztermWsl', false, 'ok')
    const wsl = mockWslStrategy('ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      weztermWslStrategy: weztermWsl,
      platform: 'linux',
      isWsl: () => true,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3' }))

    expect(result).toBe('ok')
    expect(weztermWsl.focus).not.toHaveBeenCalled()
    expect(wsl.focus).toHaveBeenCalledWith('/dev/pts/3')
  })

  it('focuses via weztermStrategy on native Linux when weztermPane is present', async () => {
    const wezterm = mockStrategy('wezterm', false, 'ok')
    const wsl = mockWslStrategy('error')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      weztermStrategy: wezterm,
      platform: 'linux',
      isWsl: () => false,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3', weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(wezterm.focus).toHaveBeenCalledWith(makeTarget({ tty: '/dev/pts/3', weztermPane: '3' }))
    expect(wsl.focus).not.toHaveBeenCalled()
  })

  it('returns unsupported_platform on native Linux when weztermPane is absent, even with weztermStrategy configured', async () => {
    const wezterm = mockStrategy('wezterm', false, 'ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: mockWslStrategy('error'),
      weztermStrategy: wezterm,
      platform: 'linux',
      isWsl: () => false,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3' }))

    expect(result).toBe('unsupported_platform')
    expect(wezterm.focus).not.toHaveBeenCalled()
  })

  it('rounds an unexpected weztermStrategy exception to error on native Linux', async () => {
    const wezterm = mockStrategy('wezterm', false, new Error('wezterm cli exploded'))
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: mockWslStrategy('error'),
      weztermStrategy: wezterm,
      platform: 'linux',
      isWsl: () => false,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3', weztermPane: '3' }))

    expect(result).toBe('error')
  })

  it('prefers the WezTerm strategy on darwin when term_program hints WezTerm', async () => {
    const calls: string[] = []
    const terminalApp = mockStrategy('terminalApp', false, 'ok', calls)
    const wezterm = mockStrategy('wezterm', true, 'ok', calls)
    const service = makeDarwinService({ darwinStrategies: [terminalApp, wezterm] })

    const result = await service.focus(
      makeTarget({ tty: '/dev/ttys003', termProgram: 'WezTerm', weztermPane: '3' })
    )

    expect(result).toBe('ok')
    expect(calls).toEqual(['wezterm'])
    expect(terminalApp.focus).not.toHaveBeenCalled()
  })

  it('does not short-circuit to no_terminal when tty is null but weztermPane is present (review-changes fix)', async () => {
    const wezterm = mockStrategy('wezterm', false, 'ok')
    const service = makeDarwinService({ darwinStrategies: [wezterm] })

    const result = await service.focus(makeTarget({ tty: null, weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(wezterm.focus).toHaveBeenCalledWith(makeTarget({ tty: null, weztermPane: '3' }))
  })

  it('goes straight to the weztermStrategy on native Linux when tty is null but weztermPane is present', async () => {
    const wezterm = mockStrategy('wezterm', false, 'ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: mockWslStrategy('error'),
      weztermStrategy: wezterm,
      platform: 'linux',
      isWsl: () => false,
    })

    const result = await service.focus(makeTarget({ tty: null, weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(wezterm.focus).toHaveBeenCalledWith(makeTarget({ tty: null, weztermPane: '3' }))
  })

  it('nulls out weztermPane after a tmux switch so WezTerm pane-level focus is not attempted on the (possibly stale) pre-switch pane id (review-changes fix)', async () => {
    const tmux = mockTmuxStrategy({ result: 'ok', tty: '/dev/ttys777' })
    const calls: string[] = []
    const terminalApp = mockStrategy('terminalApp', false, 'ok', calls)
    const wezterm = mockStrategy('wezterm', false, 'ok', calls)
    const service = makeDarwinService({
      darwinStrategies: [terminalApp, wezterm],
      tmuxStrategy: tmux,
    })

    const result = await service.focus(
      makeTarget({ tmuxPane: '%3', tty: '/dev/ttys001-inner-pts', weztermPane: '5' })
    )

    expect(result).toBe('ok')
    // 配列先頭の terminalApp が呼ばれ、weztermPane は null に縮退した target を受け取る
    // （元の '5' のまま渡ると tmux 内側で捕捉した値を外側判定へ誤って使い回すことになる）。
    expect(calls).toEqual(['terminalApp'])
    expect(terminalApp.focus).toHaveBeenCalledWith(
      makeTarget({ tmuxPane: '%3', tty: '/dev/ttys777', weztermPane: null })
    )
    expect(wezterm.focus).not.toHaveBeenCalled()
  })

  it('falls back to the Windows Terminal wslStrategy on WSL2 when the real WeztermFocusStrategy execFile hangs past its timeout', async () => {
    // wezterm-strategy.ts の in-flight/timeout 対応（review-changes 修正）が focus-service の
    // 既存フォールバックと組み合わさって実際に機能することを確認する統合テスト。
    const timeoutError = Object.assign(new Error('command timed out'), {
      killed: true,
      signal: 'SIGTERM',
    })
    const execFile = vi.fn(async () => {
      throw timeoutError
    })
    const weztermWsl = new WeztermFocusStrategy('wezterm.exe', {
      execFile,
      verifyActivation: true,
    })
    const wsl = mockWslStrategy('ok')
    const service = new FocusService({
      darwinStrategies: [],
      tmuxStrategy: mockTmuxStrategy(new Error('unused')),
      wslStrategy: wsl,
      weztermWslStrategy: weztermWsl,
      platform: 'linux',
      isWsl: () => true,
    })

    const result = await service.focus(makeTarget({ tty: '/dev/pts/3', weztermPane: '3' }))

    expect(result).toBe('ok')
    expect(wsl.focus).toHaveBeenCalledWith('/dev/pts/3')
  })
})

describe('defaultIsWsl (FR-04d AC-6)', () => {
  it('returns true when WSL_DISTRO_NAME is set', () => {
    expect(defaultIsWsl({ env: { WSL_DISTRO_NAME: 'Ubuntu' } })).toBe(true)
  })

  it('returns true when /proc/version mentions microsoft', () => {
    expect(
      defaultIsWsl({
        env: {},
        readProcVersion: () => 'Linux version 5.15.0 (Microsoft@Microsoft.com)',
      })
    ).toBe(true)
  })

  it('returns false for a plain Linux /proc/version', () => {
    expect(
      defaultIsWsl({
        env: {},
        readProcVersion: () => 'Linux version 6.1.0-generic (buildd@lcy02-amd64)',
      })
    ).toBe(false)
  })

  it('returns false when /proc/version cannot be read (e.g. macOS)', () => {
    expect(
      defaultIsWsl({
        env: {},
        readProcVersion: () => {
          throw new Error('ENOENT')
        },
      })
    ).toBe(false)
  })
})
