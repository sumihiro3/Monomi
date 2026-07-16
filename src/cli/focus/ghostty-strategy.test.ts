import { describe, expect, it, vi } from 'vitest'
import {
  buildGhosttyFocusScript,
  buildGhosttyTag,
  buildOscTitleSequence,
  GHOSTTY_TERM_PROGRAM,
  GhosttyStrategy,
  type GhosttyStrategyOptions,
} from './ghostty-strategy.js'
import type { ExecFileFn } from './osascript.js'
import type { FocusTarget } from './types.js'

/** テスト用に {@link FocusTarget} を組み立てる(未指定フィールドは既定で null)。 */
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
 * 呼び出し順に指定した stdout（または `Error` なら reject）を返すモック `ExecFileFn` を作る。
 * 呼び出し回数が `outcomes` を超えたら例外を投げる（想定外の追加呼び出しを検出するため）。
 */
function mockExec(
  outcomes: Array<string | Error>
): ExecFileFn & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const queue = [...outcomes]
  const fn = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args })
    const outcome = queue.shift()
    if (outcome === undefined) {
      throw new Error('mockExec: 想定より多く呼び出された')
    }
    if (outcome instanceof Error) {
      throw outcome
    }
    return { stdout: outcome, stderr: '' }
  })
  return Object.assign(fn, { calls }) as unknown as ExecFileFn & {
    calls: Array<{ command: string; args: string[] }>
  }
}

/** `writeTtyTitle` 呼び出しを記録するモックを作る（`shouldThrow` で指定回目の呼び出しを失敗させる）。 */
function mockWriteTtyTitle(
  shouldThrow: (callIndex: number) => boolean = () => false
): GhosttyStrategyOptions['writeTtyTitle'] & {
  calls: Array<{ ttyPath: string; oscSequence: string }>
} {
  const calls: Array<{ ttyPath: string; oscSequence: string }> = []
  const fn = vi.fn((ttyPath: string, oscSequence: string) => {
    const index = calls.length
    calls.push({ ttyPath, oscSequence })
    if (shouldThrow(index)) {
      throw new Error(`write failed at call ${index}`)
    }
  })
  return Object.assign(fn, { calls }) as unknown as GhosttyStrategyOptions['writeTtyTitle'] & {
    calls: Array<{ ttyPath: string; oscSequence: string }>
  }
}

describe('buildGhosttyTag（release-23-terminal-focus FR-04b AC-4）', () => {
  it('tty の basename に monomi: を前置する', () => {
    expect(buildGhosttyTag('/dev/ttys003')).toBe('monomi:ttys003')
  })

  it('ネストしたパスでも末尾セグメントのみを使う', () => {
    expect(buildGhosttyTag('/dev/pts/12')).toBe('monomi:12')
  })
})

describe('buildOscTitleSequence', () => {
  it('ESC ]0; <title> BEL の形式で組み立てる', () => {
    const sequence = buildOscTitleSequence('monomi:ttys003')
    expect(sequence).toBe(`${String.fromCharCode(27)}]0;monomi:ttys003${String.fromCharCode(7)}`)
  })

  it('空文字列を渡すとタイトルをクリアするシーケンスになる', () => {
    const sequence = buildOscTitleSequence('')
    expect(sequence).toBe(`${String.fromCharCode(27)}]0;${String.fromCharCode(7)}`)
  })
})

describe('buildGhosttyFocusScript（AC-4）', () => {
  it('タグ名で Window メニュー項目を検索し、2 回クリックしてから AXRaise を試みる', () => {
    const script = buildGhosttyFocusScript('monomi:ttys003')
    expect(script).toContain('tell application "System Events"')
    expect(script).toContain('tell process "Ghostty"')
    expect(script).toContain('menu item "monomi:ttys003" of menu "Window" of menu bar 1')
    expect(script.match(/click targetItem/g)).toHaveLength(2)
    expect(script).toContain('perform action "AXRaise"')
    expect(script).toContain('return "true"')
    expect(script).toContain('return "false"')
  })

  it('タグに引用符・バックスラッシュが含まれてもエスケープされ文字列リテラルを抜け出せない', () => {
    const malicious = '" & (do shell script "rm -rf ~") & "'
    const script = buildGhosttyFocusScript(malicious)
    expect(script).not.toContain(`"${malicious}"`)
    expect(script).toContain('\\" & (do shell script \\"rm -rf ~\\") & \\"')
  })
})

describe('GhosttyStrategy.matchesHint（AC-6）', () => {
  const strategy = new GhosttyStrategy()

  it('term_program が ghostty のとき true', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: GHOSTTY_TERM_PROGRAM }))).toBe(true)
  })

  it('term_program が Apple_Terminal のとき false', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: 'Apple_Terminal' }))).toBe(false)
  })

  it('term_program が null のとき false', () => {
    expect(strategy.matchesHint(makeTarget({ termProgram: null }))).toBe(false)
  })
})

describe('GhosttyStrategy.focus（AC-4）', () => {
  it('1 回目で成功したらリトライせず ok を返す', async () => {
    const exec = mockExec(['true'])
    const writeTtyTitle = mockWriteTtyTitle()
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle })

    const result = await strategy.focus('/dev/ttys003')

    expect(result).toBe('ok')
    expect(exec.calls).toHaveLength(1)
    // タグ書き込み(1回) + finally でのタグ消去(1回) = 2回。
    expect(writeTtyTitle.calls).toHaveLength(2)
    expect(writeTtyTitle.calls[0]).toEqual({
      ttyPath: '/dev/ttys003',
      oscSequence: buildOscTitleSequence('monomi:ttys003'),
    })
  })

  it('osascript には "osascript" "-e" <script> の形で execFile（非 shell）発行する', async () => {
    const exec = mockExec(['true'])
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle: mockWriteTtyTitle() })

    await strategy.focus('/dev/ttys003')

    expect(exec.calls[0]?.command).toBe('osascript')
    expect(exec.calls[0]?.args[0]).toBe('-e')
    expect(exec.calls[0]?.args[1]).toBe(buildGhosttyFocusScript('monomi:ttys003'))
  })

  it('成否によらず finally でタグを消去する（空タイトルを書き込む）', async () => {
    const exec = mockExec(['true'])
    const writeTtyTitle = mockWriteTtyTitle()
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle })

    await strategy.focus('/dev/ttys003')

    const lastCall = writeTtyTitle.calls.at(-1)
    expect(lastCall).toEqual({ ttyPath: '/dev/ttys003', oscSequence: buildOscTitleSequence('') })
  })

  it('1 回目が not_found（メニュー項目未検出）なら 1 回だけリトライし、2 回目の結果を返す', async () => {
    const exec = mockExec(['false', 'true'])
    const writeTtyTitle = mockWriteTtyTitle()
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle })

    const result = await strategy.focus('/dev/ttys003')

    expect(result).toBe('ok')
    expect(exec.calls).toHaveLength(2)
    // タグ書き込み(1回目) + タグ書き込み(2回目のリトライ) + finally でのタグ消去 = 3回。
    expect(writeTtyTitle.calls).toHaveLength(3)
  })

  it('2 回とも not_found なら 3 回目は試さず not_found を返す', async () => {
    const exec = mockExec(['false', 'false'])
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle: mockWriteTtyTitle() })

    const result = await strategy.focus('/dev/ttys003')

    expect(result).toBe('not_found')
    expect(exec.calls).toHaveLength(2)
  })

  it('osascript 実行自体が例外を投げても error を返し、finally でタグを消去する', async () => {
    const exec = mockExec([new Error('System Events not authorized'), new Error('still no')])
    const writeTtyTitle = mockWriteTtyTitle()
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle })

    const result = await strategy.focus('/dev/ttys003')

    expect(result).toBe('error')
    expect(exec.calls).toHaveLength(2)
    expect(writeTtyTitle.calls.at(-1)).toEqual({
      ttyPath: '/dev/ttys003',
      oscSequence: buildOscTitleSequence(''),
    })
  })

  it('タグ書き込み自体が失敗したら osascript を呼ばず error を返し、リトライする', async () => {
    const exec = mockExec([])
    // 1回目・2回目(リトライ)のタグ書き込みは失敗させ、3回目(finallyのクリア)は成功させる。
    const writeTtyTitle = mockWriteTtyTitle((index) => index < 2)
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle })

    const result = await strategy.focus('/dev/ttys003')

    expect(result).toBe('error')
    expect(exec.calls).toHaveLength(0)
    expect(writeTtyTitle.calls).toHaveLength(3)
  })

  it('finally でのタグ消去自体が失敗しても focus() は例外を投げない（結果を優先する）', async () => {
    const exec = mockExec(['true'])
    // 1回目で ok になりリトライは発生しないため、2回目 = finally のクリア呼び出しだけ失敗させる。
    const writeTtyTitle = mockWriteTtyTitle((index) => index === 1)
    const strategy = new GhosttyStrategy({ exec, writeTtyTitle })

    await expect(strategy.focus('/dev/ttys003')).resolves.toBe('ok')
  })
})
