import { describe, expect, it } from 'vitest'
import { sanitizeDisplayText, sanitizeNullableDisplayText } from './sanitize-display-text.js'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('sanitizeDisplayText（review-changes 修正: CWE-150 制御文字/ANSIエスケープ注入）', () => {
  it('CSI（画面消去等）を除去する', () => {
    expect(sanitizeDisplayText(`hello${ESC}[2Jworld`)).toBe('helloworld')
  })

  it('SGR（色付け等のCSI）を除去する', () => {
    expect(sanitizeDisplayText(`${ESC}[31mred${ESC}[0m text`)).toBe('red text')
  })

  it('OSC（BEL終端、ウィンドウタイトル書換等）を除去する', () => {
    expect(sanitizeDisplayText(`hello${ESC}]0;PWNED${BEL}end`)).toBe('helloend')
  })

  it('OSC（ST=ESC\\終端）を除去する', () => {
    expect(sanitizeDisplayText(`hello${ESC}]0;title${ESC}\\end`)).toBe('helloend')
  })

  it('C0制御文字（NUL・SOH等）を除去する', () => {
    expect(sanitizeDisplayText('path/with\x00null\x01byte')).toBe('path/withnullbyte')
  })

  it('改行・タブは保持する', () => {
    expect(sanitizeDisplayText('line1\nline2\ttab')).toBe('line1\nline2\ttab')
  })

  it('通常のテキストは変更しない', () => {
    expect(sanitizeDisplayText('npm install --save-dev vitest')).toBe(
      'npm install --save-dev vitest'
    )
  })

  it('日本語・絵文字を含む通常テキストは変更しない', () => {
    expect(sanitizeDisplayText('権限待ち 🎉 ProjectLens')).toBe('権限待ち 🎉 ProjectLens')
  })
})

describe('sanitizeNullableDisplayText', () => {
  it('null はそのまま null を返す', () => {
    expect(sanitizeNullableDisplayText(null)).toBeNull()
  })

  it('文字列は sanitizeDisplayText と同じ結果を返す', () => {
    expect(sanitizeNullableDisplayText(`bad${ESC}[2Jbranch`)).toBe('badbranch')
  })
})
