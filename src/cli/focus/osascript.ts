import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * `runOsascript` が外部プロセス起動に使う実行関数の最小 signature
 * （`hub-autostart.ts` の `SpawnFn` と同じ DI パターン。release-23 FR-04a）。
 *
 * 実 `node:child_process.execFile` を `util.promisify` でラップしたものが既定実装。
 * `execFile` はコマンドと引数を配列で渡す非 shell 実行のため、シェルメタ文字による注入を
 * 構造的に防げる（三段防御の第三段: focus-target 検証 → AppleScript エスケープ →
 * 本モジュールの execFile 非 shell 実行）。テストでは fork を伴わないモックに差し替える。
 */
export type ExecFileFn = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>

/** `node:child_process.execFile` の promisify 版（既定の {@link ExecFileFn} 実装）。 */
const defaultExecFile: ExecFileFn = promisify(nodeExecFile) as unknown as ExecFileFn

/** {@link runOsascript} の依存差し替え（テスト用）。 */
export interface RunOsascriptOptions {
  /** `execFile` 実装の差し替え。省略時は {@link defaultExecFile}。 */
  exec?: ExecFileFn
}

/**
 * `osascript -e <script>` を非 shell（`execFile`）で実行し、標準出力を返す。
 *
 * `script` はコマンドライン結合ではなく引数配列の 1 要素として渡すため、シェル解釈を経由しない
 * （script 自体の内容は呼び出し側が {@link ./applescript.js escapeAppleScriptString} 等で
 * エスケープ済みであることが前提）。非 0 終了（AppleScript 実行時エラー等）は
 * `execFile`/`promisify` の挙動どおり reject される。
 *
 * @param script 実行する AppleScript ソース全体（複数行可）。
 * @param options `exec` の差し替え（省略可、テスト用）。
 * @returns 標準出力（前後の空白を除去済み）。
 * @throws {Error} `osascript` が非 0 終了した場合（構文エラー・実行時エラーを含む）。
 */
export async function runOsascript(
  script: string,
  options: RunOsascriptOptions = {}
): Promise<string> {
  const exec = options.exec ?? defaultExecFile
  const { stdout } = await exec('osascript', ['-e', script])
  return stdout.trim()
}
