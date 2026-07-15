import { execFile as nodeExecFile } from 'node:child_process'
import type { FocusResult, WslStrategy } from './types.js'

/**
 * WSL2 上でのフォーカス実行に使う `execFile` の最小 signature（release-23-terminal-focus FR-04c）。
 *
 * `hub-autostart.ts` の `SpawnFn` 注入パターンを踏襲する。実行はすべて `execFile`（非 shell）で
 * 行う。テストでは実 `powershell.exe` を起動しないモックに差し替える。
 */
export type ExecFileFn = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>

/**
 * `node:child_process.execFile` を Promise 化した既定実装。
 *
 * `util.promisify` ではなく明示的な `Promise` ラップにしているのは、`execFile` のコールバック
 * オーバーロード解決に依存せず戻り値の型（`{ stdout: string; stderr: string }`）を固定するため。
 */
function defaultExecFile(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** WSL interop 経由で呼び出す Windows 側の PowerShell 実体。 */
const POWERSHELL_COMMAND = 'powershell.exe'

/**
 * Windows Terminal（`WindowsTerminal.exe`）のメインウィンドウを前面化する PowerShell スクリプト。
 *
 * 対象プロセスが見つからなければ `NOT_FOUND` を、成功したら `OK` を stdout へ出力する
 * （終了コードではなく stdout の内容で成否を判定できるようにするため）。動的な値をスクリプト内へ
 * 埋め込まない（reporter/hub 由来の値は一切使わない）ため、文字列インジェクションの経路は無い。
 */
const FOREGROUND_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$p = Get-Process -Name "WindowsTerminal" | Select-Object -First 1',
  'if ($null -eq $p) { Write-Output "NOT_FOUND"; exit 0 }',
  '$sig = \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\'',
  'Add-Type -Name Win32Foreground -Namespace MonomiFocus -MemberDefinition $sig',
  '[MonomiFocus.Win32Foreground]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
  'Write-Output "OK"',
].join('; ')

/** {@link WslFocusStrategy} の依存差し替え（テスト用）。 */
export interface WslFocusStrategyOptions {
  /** `execFile` の差し替え。省略時は実 `powershell.exe` を起動する既定実装。 */
  execFile?: ExecFileFn
}

/**
 * WSL2 上で Windows Terminal のウィンドウを前面化する strategy（release-23-terminal-focus
 * FR-04c、`types.ts` の {@link WslStrategy} 実装、AC-7）。
 *
 * タブ単位の特定はスコープ外（best-effort）。WSL からは interop 経由で `powershell.exe`
 * （Windows 側の実体）を直接起動できるため、`execFile`（非 shell）で呼び出し、Win32 API
 * `SetForegroundWindow` でメインウィンドウを前面化する。
 */
export class WslFocusStrategy implements WslStrategy {
  private readonly execFile: ExecFileFn

  /** @param options `execFile` の差し替え（{@link WslFocusStrategyOptions}、省略可）。 */
  constructor(options: WslFocusStrategyOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile
  }

  /**
   * `powershell.exe` 経由で Windows Terminal を前面化する（AC-7、best-effort）。
   *
   * タブ単位のフォーカスはスコープ外のため、`tty` は使わない（{@link WslStrategy.focus} の
   * signature に合わせて受け取るのみ）。stdout に `NOT_FOUND` が含まれれば `not_found`、
   * `OK` が含まれれば `ok`、それ以外（予期しない出力）や `execFile` 失敗は `error` を返す。
   *
   * @param _tty 参考情報として渡される TTY。best-effort のため未使用。
   * @returns フォーカス結果。
   */
  async focus(_tty: string | null): Promise<FocusResult> {
    let stdout: string
    try {
      const executed = await this.execFile(POWERSHELL_COMMAND, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        FOREGROUND_SCRIPT,
      ])
      stdout = executed.stdout
    } catch {
      return 'error'
    }

    const trimmed = stdout.trim()
    if (trimmed.includes('NOT_FOUND')) {
      return 'not_found'
    }
    if (trimmed.includes('OK')) {
      return 'ok'
    }
    return 'error'
  }
}
