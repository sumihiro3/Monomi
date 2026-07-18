import { describe, expect, it } from 'vitest'
import { isLinkableGithubUrl, toOsc8Hyperlink } from './osc8-hyperlink.js'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('isLinkableGithubUrl（release-27 FR-05b AC-2）', () => {
  it('https://github.com/ で始まる URL は true', () => {
    expect(isLinkableGithubUrl('https://github.com/owner/repo/pull/123')).toBe(true)
  })

  it('http://github.com/ （非TLS）は false', () => {
    expect(isLinkableGithubUrl('http://github.com/owner/repo/pull/123')).toBe(false)
  })

  it('github.com 以外のホストは false', () => {
    expect(isLinkableGithubUrl('https://example.com/owner/repo/pull/123')).toBe(false)
  })

  it('javascript: 等の不正スキームは false', () => {
    expect(isLinkableGithubUrl('javascript:alert(1)')).toBe(false)
  })

  it('null は false', () => {
    expect(isLinkableGithubUrl(null)).toBe(false)
  })

  // review-changes 修正: 接頭辞一致のみだと `https://github.com/x\x07\x1b]...` のような値が
  // 素通りし、BEL が OSC 8 シーケンスを途中終端させて後続を端末エスケープとして注入できてしまう。
  it('BEL を含む URL は false（OSC 8 シーケンスの途中終端注入対策）', () => {
    expect(
      isLinkableGithubUrl(`https://github.com/owner/repo/pull/1${BEL}${ESC}]0;evil${BEL}`)
    ).toBe(false)
  })

  it('ESC を含む URL は false（任意端末エスケープ注入対策）', () => {
    expect(isLinkableGithubUrl(`https://github.com/owner/repo/pull/1${ESC}[2J`)).toBe(false)
  })

  it('改行を含む URL は false', () => {
    expect(isLinkableGithubUrl('https://github.com/owner/repo/pull/1\nrm -rf /')).toBe(false)
  })

  it('資格情報（userinfo）付き URL は false', () => {
    expect(isLinkableGithubUrl('https://evil@github.com/owner/repo/pull/1')).toBe(false)
  })

  it('pull request 形式でないパスは false', () => {
    expect(isLinkableGithubUrl('https://github.com/owner/repo')).toBe(false)
    expect(isLinkableGithubUrl('https://github.com/owner/repo/issues/1')).toBe(false)
  })

  it('PR 番号が 0 や負数・非数値のパスは false', () => {
    expect(isLinkableGithubUrl('https://github.com/owner/repo/pull/0')).toBe(false)
    expect(isLinkableGithubUrl('https://github.com/owner/repo/pull/abc')).toBe(false)
  })
})

describe('toOsc8Hyperlink（release-27 FR-05b AC-2）', () => {
  it('https://github.com/ 始まりの URL は正しい OSC 8 エスケープシーケンスを生成する', () => {
    const result = toOsc8Hyperlink('#123', 'https://github.com/owner/repo/pull/123')
    expect(result).toBe(
      `${ESC}]8;;https://github.com/owner/repo/pull/123${BEL}#123${ESC}]8;;${BEL}`
    )
  })

  it('https://github.com/ で始まらない URL では OSC 8 を生成せずプレーンテキストを返す（AC-2）', () => {
    const result = toOsc8Hyperlink('#123', 'https://evil.example.com/pull/123')
    expect(result).toBe('#123')
  })

  it('url が null のときはプレーンテキストを返す', () => {
    const result = toOsc8Hyperlink('#123', null)
    expect(result).toBe('#123')
  })

  it('生成されたシーケンスに ESC・BEL が含まれること（対応端末での可視文字保持、AC-3）', () => {
    const result = toOsc8Hyperlink('#7', 'https://github.com/owner/repo/pull/7')
    expect(result).toContain('#7')
    expect(result.startsWith(`${ESC}]8;;`)).toBe(true)
    expect(result.endsWith(`${ESC}]8;;${BEL}`)).toBe(true)
  })
})
