import { describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_TITLE, setTerminalTitle } from './terminal-title.js'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/** `setTerminalTitle` の書き込み先を差し替えるテスト用スタブ。 */
function fakeStdout(): { write: (data: string) => void; written: string[] } {
  const written: string[] = []
  return {
    write: (data: string) => {
      written.push(data)
    },
    written,
  }
}

describe('DEFAULT_TERMINAL_TITLE（release-6 FR-09 AC-2・AC-4）', () => {
  it('既定値は Monomi', () => {
    expect(DEFAULT_TERMINAL_TITLE).toBe('Monomi')
  })
})

describe('setTerminalTitle（release-6 FR-09）', () => {
  it('AC-1: ESC ]0; タイトル BEL の OSC 0 シーケンスを書き込む', () => {
    const stdout = fakeStdout()
    setTerminalTitle(stdout as unknown as NodeJS.WritableStream, 'ProjectLens @ Mac mini')
    expect(stdout.written).toEqual([`${ESC}]0;ProjectLens @ Mac mini${BEL}`])
  })

  it('サニタイズ: ANSI エスケープ・制御文字（CWE-150 相当の注入経路）を除去する', () => {
    const stdout = fakeStdout()
    setTerminalTitle(
      stdout as unknown as NodeJS.WritableStream,
      `evil${ESC}[2Jtitle${ESC}]0;PWNED${BEL}`
    )
    // sanitizeDisplayText が CSI・入れ子の OSC を除去するため、内容はプレーンテキストのみ残る。
    expect(stdout.written[0]).toBe(`${ESC}]0;eviltitle${BEL}`)
  })

  it('改行・タブは半角スペースに潰す（タイトルは 1 行の前提）', () => {
    const stdout = fakeStdout()
    setTerminalTitle(stdout as unknown as NodeJS.WritableStream, 'line1\nline2\ttab')
    expect(stdout.written).toEqual([`${ESC}]0;line1 line2 tab${BEL}`])
  })

  it('日本語・絵文字を含むタイトルはそのまま通す', () => {
    const stdout = fakeStdout()
    setTerminalTitle(stdout as unknown as NodeJS.WritableStream, '権限待ち 🎉 ProjectLens')
    expect(stdout.written).toEqual([`${ESC}]0;権限待ち 🎉 ProjectLens${BEL}`])
  })

  it('AC-5: 非TTY相当（isTTY を問わない書き込み専用オブジェクト）でも同じ経路で害なく書き込める', () => {
    const stdout = fakeStdout()
    expect(() =>
      setTerminalTitle(stdout as unknown as NodeJS.WritableStream, DEFAULT_TERMINAL_TITLE)
    ).not.toThrow()
    expect(stdout.written).toEqual([`${ESC}]0;Monomi${BEL}`])
  })
})
