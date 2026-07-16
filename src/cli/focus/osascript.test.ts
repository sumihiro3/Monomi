import { describe, expect, it, vi } from 'vitest'
import { type ExecFileFn, runOsascript } from './osascript.js'

/** 型付き execFile モックを作る(実プロセスを起動せず結果を差し替える)。 */
function mockExecFile(
  impl: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
): ExecFileFn {
  return vi.fn(impl) as unknown as ExecFileFn
}

describe('runOsascript', () => {
  it('osascript を -e <script> の非 shell execFile で呼び出す', async () => {
    const exec = mockExecFile(async () => ({ stdout: 'true\n', stderr: '' }))

    const result = await runOsascript('tell application "Terminal" to activate', { exec })

    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('osascript', [
      '-e',
      'tell application "Terminal" to activate',
    ])
    expect(result).toBe('true')
  })

  it('標準出力の前後の空白を除去して返す', async () => {
    const exec = mockExecFile(async () => ({ stdout: '  hello world  \n', stderr: '' }))

    const result = await runOsascript('return "hello world"', { exec })

    expect(result).toBe('hello world')
  })

  it('exec が reject したらそのまま伝播する(非 0 終了 = AppleScript 実行時エラー)', async () => {
    const exec = mockExecFile(async () => {
      throw new Error('osascript: syntax error')
    })

    await expect(runOsascript('this is not valid AppleScript', { exec })).rejects.toThrow(
      'osascript: syntax error'
    )
  })

  it('script は 1 つの引数としてそのまま渡す(シェル結合しない)', async () => {
    const exec = mockExecFile(async () => ({ stdout: '', stderr: '' }))
    const scriptWithMetaChars = 'do shell script "echo $(whoami); rm -rf /"'

    await runOsascript(scriptWithMetaChars, { exec })

    expect(exec).toHaveBeenCalledWith('osascript', ['-e', scriptWithMetaChars])
  })
})
