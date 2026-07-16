import { describe, expect, it } from 'vitest'
import { escapeAppleScriptString, quoteAppleScriptString } from './applescript.js'

describe('escapeAppleScriptString', () => {
  it('通常のテキストは変更しない', () => {
    expect(escapeAppleScriptString('/dev/ttys003')).toBe('/dev/ttys003')
  })

  it('二重引用符をエスケープする', () => {
    expect(escapeAppleScriptString('say "hi"')).toBe('say \\"hi\\"')
  })

  it('バックスラッシュをエスケープする', () => {
    expect(escapeAppleScriptString('C:\\path\\to\\thing')).toBe('C:\\\\path\\\\to\\\\thing')
  })

  it('バックスラッシュを先にエスケープしてから引用符をエスケープする（二重エスケープ防止）', () => {
    // 素朴に \" -> \\" だけ置換した後に \ -> \\ を適用すると \\" になり壊れる。
    // 正しい順序（\ を先に処理）なら \" は \\\" になる。
    expect(escapeAppleScriptString('\\"')).toBe('\\\\\\"')
  })

  it('AppleScript の文字列終端を破る注入文字列を無害化する', () => {
    const malicious = '" & (do shell script "rm -rf ~") & "'
    const escaped = escapeAppleScriptString(malicious)
    // すべての生の " の直前に \ が挿入され、文字列リテラルを閉じて外へ抜け出せなくなる。
    expect(escaped).toBe('\\" & (do shell script \\"rm -rf ~\\") & \\"')
  })

  it('空文字列はそのまま空文字列', () => {
    expect(escapeAppleScriptString('')).toBe('')
  })
})

describe('quoteAppleScriptString', () => {
  it('エスケープ済みの値を二重引用符で囲む', () => {
    expect(quoteAppleScriptString('/dev/ttys003')).toBe('"/dev/ttys003"')
  })

  it('埋め込み対象に引用符が含まれても閉じ引用符を壊さない', () => {
    const quoted = quoteAppleScriptString('a"b')
    expect(quoted).toBe('"a\\"b"')
    // 先頭・末尾のみが非エスケープの引用符であること（内部の " はすべて \" 化されている）。
    expect(quoted.startsWith('"')).toBe(true)
    expect(quoted.endsWith('"')).toBe(true)
  })
})
