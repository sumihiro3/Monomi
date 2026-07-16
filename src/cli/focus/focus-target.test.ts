import { describe, expect, it } from 'vitest'
import type { TerminalDto } from '../../hub/dto.js'
import { toFocusTarget } from './focus-target.js'
import type { FocusTarget } from './types.js'

/** 全フィールドが妥当な wire terminal DTO のベース値。個々のテストで上書きする。 */
function validDto(overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    tty: '/dev/ttys003',
    term_program: 'Apple_Terminal',
    tmux_pane: null,
    tmux_socket: null,
    wsl_distro: null,
    wt_session: null,
    ...overrides,
  }
}

/** `toFocusTarget` の戻り値が非 null であることを前提にテスト内で扱うためのヘルパー。 */
function targetOf(dto: TerminalDto): FocusTarget {
  const target = toFocusTarget(dto)
  if (target === null) {
    throw new Error('expected toFocusTarget to return a non-null FocusTarget')
  }
  return target
}

describe('toFocusTarget（FR-04 AC-1）', () => {
  it('dto が null なら null を返す（旧 reporter・非 TTY 実行）', () => {
    expect(toFocusTarget(null)).toBeNull()
  })

  it('dto が undefined なら null を返す', () => {
    expect(toFocusTarget(undefined)).toBeNull()
  })

  it('全フィールド妥当な dto はそのまま camelCase へ写す', () => {
    const dto = validDto({ tmux_pane: '%3', tmux_socket: '/tmp/tmux-501/default' })
    expect(toFocusTarget(dto)).toEqual({
      tty: '/dev/ttys003',
      termProgram: 'Apple_Terminal',
      tmuxPane: '%3',
      tmuxSocket: '/tmp/tmux-501/default',
      wslDistro: null,
      wtSession: null,
    })
  })

  describe('tty 検証', () => {
    it('null はそのまま null', () => {
      expect(targetOf(validDto({ tty: null })).tty).toBeNull()
    })

    it('/dev/ 配下でない値は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tty: '/etc/passwd' })).tty).toBeNull()
    })

    it('".." を含む値は /dev/ 前置でも情報なしへ縮退する（パストラバーサル対策）', () => {
      expect(targetOf(validDto({ tty: '/dev/../etc/passwd' })).tty).toBeNull()
    })

    it('シェルメタ文字を含む値は情報なしへ縮退する（コマンド注入対策）', () => {
      expect(targetOf(validDto({ tty: '/dev/ttys003; rm -rf /' })).tty).toBeNull()
    })

    it('バッククォートを含む値は情報なしへ縮退する（コマンド置換注入対策）', () => {
      expect(targetOf(validDto({ tty: '/dev/`whoami`' })).tty).toBeNull()
    })

    it('引用符を含む値は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tty: '/dev/tty"osascript -e bad"' })).tty).toBeNull()
    })

    it('空白を含む値は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tty: '/dev/ttys 003' })).tty).toBeNull()
    })

    it('妥当な TTY はそのまま通す', () => {
      expect(targetOf(validDto({ tty: '/dev/ttys003' })).tty).toBe('/dev/ttys003')
    })

    it('妥当な TTY（pts、ドット・アンダースコア含む）もそのまま通す', () => {
      expect(targetOf(validDto({ tty: '/dev/pts/1_2.3' })).tty).toBe('/dev/pts/1_2.3')
    })
  })

  describe('tmux_pane 検証', () => {
    it('null はそのまま null', () => {
      expect(targetOf(validDto({ tmux_pane: null })).tmuxPane).toBeNull()
    })

    it('%数字 形式はそのまま通す', () => {
      expect(targetOf(validDto({ tmux_pane: '%12' })).tmuxPane).toBe('%12')
    })

    it('先頭 % が無い値は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tmux_pane: '12' })).tmuxPane).toBeNull()
    })

    it('数字以外を含む値（コマンド注入）は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tmux_pane: '%1; kill-server' })).tmuxPane).toBeNull()
    })

    it('空文字列は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tmux_pane: '' })).tmuxPane).toBeNull()
    })
  })

  describe('tmux_socket 検証', () => {
    it('null はそのまま null', () => {
      expect(targetOf(validDto({ tmux_socket: null })).tmuxSocket).toBeNull()
    })

    it('絶対パスはそのまま通す', () => {
      expect(targetOf(validDto({ tmux_socket: '/tmp/tmux-501/default' })).tmuxSocket).toBe(
        '/tmp/tmux-501/default'
      )
    })

    it('相対パスは情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tmux_socket: 'tmux-501/default' })).tmuxSocket).toBeNull()
    })

    it('二重引用符を含む値（コマンド注入）は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tmux_socket: '/tmp/"; rm -rf ~ #' })).tmuxSocket).toBeNull()
    })

    it('シングル引用符を含む値は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tmux_socket: "/tmp/'; touch pwned" })).tmuxSocket).toBeNull()
    })

    it('制御文字（改行）を含む値は情報なしへ縮退する', () => {
      expect(targetOf(validDto({ tmux_socket: '/tmp/foo\nbar' })).tmuxSocket).toBeNull()
    })

    it('制御文字（NUL）を含む値は情報なしへ縮退する', () => {
      expect(
        targetOf(validDto({ tmux_socket: `/tmp/foo${String.fromCharCode(0)}bar` })).tmuxSocket
      ).toBeNull()
    })
  })

  describe('ヒント項目（term_program/wsl_distro/wt_session）', () => {
    it('null はそのまま null で通す', () => {
      const target = targetOf(validDto({ term_program: null, wsl_distro: null, wt_session: null }))
      expect(target.termProgram).toBeNull()
      expect(target.wslDistro).toBeNull()
      expect(target.wtSession).toBeNull()
    })

    it('値があればそのまま通す（判定材料のみで注入対象にはならない）', () => {
      const target = targetOf(
        validDto({ term_program: 'ghostty', wsl_distro: 'Ubuntu', wt_session: 'abc-123' })
      )
      expect(target.termProgram).toBe('ghostty')
      expect(target.wslDistro).toBe('Ubuntu')
      expect(target.wtSession).toBe('abc-123')
    })
  })

  it('tty が不正でも他フィールドが妥当なら個別に活かせる（オブジェクト全体は拒否しない）', () => {
    const target = targetOf(
      validDto({ tty: '/etc/passwd', tmux_pane: '%3', tmux_socket: '/tmp/tmux-501/default' })
    )
    expect(target).toEqual({
      tty: null,
      termProgram: 'Apple_Terminal',
      tmuxPane: '%3',
      tmuxSocket: '/tmp/tmux-501/default',
      wslDistro: null,
      wtSession: null,
    })
  })
})
