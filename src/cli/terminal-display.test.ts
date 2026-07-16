import { describe, expect, it } from 'vitest'
import { terminalDisplayName } from './terminal-display.js'

describe('terminalDisplayName（release-24 FR-01、U16）', () => {
  it('Apple_Terminal は Terminal.app と表示する', () => {
    expect(terminalDisplayName('Apple_Terminal', null)).toBe('Terminal.app')
  })

  it('ghostty は Ghostty と表示する', () => {
    expect(terminalDisplayName('ghostty', null)).toBe('Ghostty')
  })

  it('iTerm.app は iTerm2 と表示する', () => {
    expect(terminalDisplayName('iTerm.app', null)).toBe('iTerm2')
  })

  it('vscode は VS Code と表示する', () => {
    expect(terminalDisplayName('vscode', null)).toBe('VS Code')
  })

  it('tmux は tmux のまま表示する', () => {
    expect(terminalDisplayName('tmux', null)).toBe('tmux')
  })

  it('未知の termProgram は入力値のまま返す', () => {
    expect(terminalDisplayName('WezTerm', null)).toBe('WezTerm')
  })

  it('termProgram が null かつ wslDistro が非 null なら wslDistro を返す', () => {
    expect(terminalDisplayName(null, 'Ubuntu')).toBe('Ubuntu')
  })

  it('termProgram・wslDistro が両方 null なら null を返す', () => {
    expect(terminalDisplayName(null, null)).toBeNull()
  })

  it('termProgram が非 null なら wslDistro は無視する（termProgram を優先）', () => {
    expect(terminalDisplayName('ghostty', 'Ubuntu')).toBe('Ghostty')
  })

  it('termProgram が空文字列かつ wslDistro が非 null なら wslDistro を返す（AC-4）', () => {
    expect(terminalDisplayName('', 'Ubuntu')).toBe('Ubuntu')
  })

  it('termProgram・wslDistro が両方空文字列なら null を返す（AC-5）', () => {
    expect(terminalDisplayName('', '')).toBeNull()
  })

  it('termProgram が null かつ wslDistro が空文字列なら null を返す（AC-5）', () => {
    expect(terminalDisplayName(null, '')).toBeNull()
  })

  it('termProgram が空文字列かつ wslDistro が null なら null を返す（AC-5）', () => {
    expect(terminalDisplayName('', null)).toBeNull()
  })
})
