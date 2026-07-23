import { execFile as nodeExecFile } from 'node:child_process'
import { escapeAppleScriptString } from './applescript.js'
import { type RunOsascriptOptions, runOsascript } from './osascript.js'
import type { FocusResult, FocusTarget, Strategy } from './types.js'

/**
 * WezTerm 公式 CLI 実行に使う `execFile` の最小 signature（release-28-wezterm-focus FR-03b）。
 *
 * `wsl-strategy.ts` の `ExecFileFn` と同じ形（`hub-autostart.ts` の `SpawnFn` 注入パターンを踏襲）。
 * `options.timeout` は review-changes 修正（下記 {@link WEZTERM_EXEC_TIMEOUT_MS}）で追加した任意
 * 引数で、`github-pr-poller.ts` の `ExecFileFn` が `options.signal` を持つのと同じ「テストから
 * 呼び出しパラメータを検証できるようにする」動機で公開している。
 */
export type ExecFileFn = (
  command: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>

/**
 * WezTerm CLI 呼び出し 1 回あたりの既定タイムアウト（review-changes 修正: `execFile` に timeout が
 * 無く、`wezterm`/`wezterm.exe` がハング（WSL interop 劣化時等）すると `focus()` の Promise が
 * 永久に解決せず、`f` キー連打のたびに子プロセスが蓄積し続けていた medium severity 所見への対応）。
 * `github-pr-poller.ts` の `GH_EXEC_TIMEOUT_MS`（15秒、GitHub API 往復を含む）と異なり、こちらは
 * ローカル/WSL interop 経由の CLI 呼び出しでネットワーク往復を伴わないため短めの 5 秒にする。
 */
const WEZTERM_EXEC_TIMEOUT_MS = 5_000

/**
 * `node:child_process.execFile` を Promise 化した既定実装。
 *
 * `wsl-strategy.ts` の `defaultExecFile` と同じ理由（`execFile` のコールバックオーバーロード解決に
 * 依存せず戻り値の型を固定するため）で `util.promisify` ではなく明示的な `Promise` ラップにする。
 * `options.timeout` を `node:child_process` の `timeout`（既定 {@link WEZTERM_EXEC_TIMEOUT_MS}）へ
 * そのまま渡す。Node はこの値を超えて子プロセスが生存していると `killSignal`（既定 `SIGTERM`）で
 * 自動的に kill したうえで callback を `error` 付きで呼ぶため、呼び出し側で個別に kill 処理を
 * 実装する必要はない。
 */
function defaultExecFile(
  command: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      command,
      args,
      { encoding: 'utf8', timeout: options?.timeout ?? WEZTERM_EXEC_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

/** WezTerm が設定する `$TERM_PROGRAM` の値（darwin での strategy 順序ヒント、FR-03b）。 */
export const WEZTERM_TERM_PROGRAM = 'WezTerm'

/** {@link WeztermFocusStrategy} の依存差し替え（テスト用）。 */
export interface WeztermFocusStrategyOptions {
  /** `execFile` の差し替え。省略時は実 `command` を起動する既定実装。 */
  execFile?: ExecFileFn
  /**
   * `activate-pane` が exit 0 で終わった後、`<command> cli list --format json` で対象 pane id が
   * 実在するかを追加確認するかどうか（既定 `false`）。
   *
   * review-changes 修正: WSL interop 経由の `wezterm.exe cli` 呼び出しは、upstream の議論
   * （wezterm/wezterm discussions #6964）で類似操作がサイレント失敗する報告があり、exit 0 が実際の
   * pane 前面化を保証しない（`docs/releases/release-28-wezterm-focus/requirements.md` 未解決事項）。
   * `true` のとき、`activate-pane` 成功後に一覧を取得し対象 pane id が見つからなければ `ok` を返さず
   * `error` に丸める（`FocusService.focusWsl` の既存 Windows Terminal フォールバックへ進めるため）。
   * 一覧取得自体が失敗・不正な形式だった場合も「検証できない」とみなし同様に `error` を返す
   * （検証手段が信頼できないときは exit 0 を無条件の最終成功にしない設計）。
   *
   * この検証は「前面化が実際に効いたか」までは確認できず、対象 pane がまだ mux 上に存在するかの
   * 確認に留まる（upstream 挙動の完全な確証は実機検証でのみ得られる、requirements.md 未解決事項）。
   * darwin/ネイティブ Linux は直接実行でこの種のサイレント失敗の懸念が無いため既定 `false` のまま
   * にし、`cli.ts` の WSL 用インスタンス（`command: 'wezterm.exe'`）でのみ `true` を渡す。
   */
  verifyActivation?: boolean
  /**
   * `activate-pane`（と有効な場合は {@link verifyActivation}）成功後に OS レベルでウィンドウを
   * 前面化する追加ステップ（release-28-wezterm-focus 実機検証で判明した所見への対応）。
   *
   * `wezterm cli activate-pane` は mux サーバー内部の「アクティブなペイン」状態を変えるだけで、
   * OS のウィンドウマネージャへ前面化を要求しない（`wezterm cli --help` にも `activate-window`
   * 相当のサブコマンドは存在しない）。そのため exit 0 で解決しても、他アプリが前面にある間は
   * WezTerm ウィンドウ自体は前に出てこない（macOS 実機で確認済み。`osascript -e 'tell application
   * "WezTerm" to activate'` を別途実行することで解決することも確認済み）。
   *
   * プラットフォームごとに前面化手段が異なる（macOS: AppleScript の `activate`、Windows:
   * `SetForegroundWindow`）ため、`command` と同様に呼び出し側（`cli.ts`）が platform 別の実装を
   * 注入する。未指定（ネイティブ Linux 想定。X11/Wayland のウィンドウ操作 API へ依存しない設計を
   * 維持するため専用の前面化手段を持たない）ならペイン切替のみで完了とする（best-effort）。
   *
   * 例外を投げた場合、`focus()` は `activate-pane` 自体が成功していても `ok` を返さず `error` に
   * 丸める（前面化が確認できない終了を無条件の成功にしない設計。{@link verifyActivation} と同じ方針）。
   */
  raiseWindow?: () => Promise<void>
}

/** {@link WeztermFocusStrategy.verifyPaneExists} が期待する `cli list --format json` の1要素分。 */
interface WeztermPaneListEntry {
  pane_id?: unknown
}

/**
 * `error` が「コマンドが見つからない」（`ENOENT`、PATH 上に `wezterm`/`wezterm.exe` が無い）ことを
 * 表すかを判定する。`execFile` が spawn 失敗時に reject する値は `NodeJS.ErrnoException` だが、
 * ここでは型に依存せず `code` プロパティの値だけを見る（テストのプレーンな `Error` にも対応するため）。
 *
 * @param error `execFile` が reject した値。
 * @returns `error.code === 'ENOENT'` なら true。
 */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * WezTerm 公式 CLI（`wezterm cli activate-pane`）でペイン単位フォーカスを行う strategy
 * （release-28-wezterm-focus FR-03b、`types.ts` の {@link Strategy} 実装）。
 *
 * `command` はコンストラクタ引数で受け取る（単一文字列、または候補を先頭から順に試す配列）。
 * 呼び出し側（`focus-service.ts`、FR-04）が darwin/ネイティブ Linux では `'wezterm'`（またはこれと
 * 既知のインストール先パスの配列）、WSL2 interop 経由では `'wezterm.exe'` を注入することで、
 * 同一の strategy 実装を各環境で使い回せるようにする。
 *
 * `target.weztermPane` は `focus-target.ts` の `sanitizeWeztermPane`（`/^\d+$/`）で既に検証済みだが、
 * ここでも `execFile`（非 shell）に pane id を引数配列の要素として渡すことで二段目の防御とする
 * （shell を経由しないため、たとえ検証をすり抜けた値が来てもシェルメタ文字が展開されることはない）。
 */
export class WeztermFocusStrategy implements Strategy {
  private readonly commands: readonly string[]
  private readonly execFile: ExecFileFn
  private readonly verifyActivation: boolean
  private readonly raiseWindow: (() => Promise<void>) | undefined
  /**
   * 実行中の `focus()` 呼び出し（review-changes 修正: in-flight ガード）。`null` でなければ
   * 前回呼び出しが未完了であることを表し、新規の `execFile` は起動せずこの Promise を共有する。
   * `wezterm`/`wezterm.exe` がハングした場合に `f` キー連打で子プロセスが際限なく蓄積するのを防ぐ。
   */
  private inFlight: Promise<FocusResult> | null = null

  /**
   * @param command 実行する `wezterm` バイナリ名/パス（例 `'wezterm'` / `'wezterm.exe'`）。配列を
   *   渡すと候補を先頭から順に試す（実機検証で判明した所見への対応: WezTerm.org 配布の macOS
   *   アプリを Homebrew 経由でなく直接インストールした場合、`wezterm` バイナリが PATH に追加され
   *   ない構成が一般的なため、`cli.ts` の darwin 用インスタンスは `['wezterm', '/Applications/
   *   WezTerm.app/Contents/MacOS/wezterm']` のように bare コマンドと既知のインストール先パスの
   *   両方を渡す）。ENOENT（バイナリ不在）のときのみ次候補へ進み、それ以外の失敗は即座に確定する。
   * @param options `execFile` の差し替え・{@link WeztermFocusStrategyOptions.verifyActivation}
   *   の指定（{@link WeztermFocusStrategyOptions}、省略可）。
   */
  constructor(command: string | readonly string[], options: WeztermFocusStrategyOptions = {}) {
    this.commands = typeof command === 'string' ? [command] : command
    this.execFile = options.execFile ?? defaultExecFile
    this.verifyActivation = options.verifyActivation ?? false
    this.raiseWindow = options.raiseWindow
  }

  /**
   * darwin での strategy 並べ替えヒント: `term_program` が WezTerm のものと一致するか。
   *
   * @param target 検証済みフォーカス対象。
   * @returns 一致すれば true。
   */
  matchesHint(target: FocusTarget): boolean {
    return target.termProgram === WEZTERM_TERM_PROGRAM
  }

  /**
   * `target.weztermPane` が指すペインを前面化する。
   *
   * pane id が無ければ（`null`）`execFile` を呼ばずに `not_found` を返す。ある場合は
   * `<command> cli activate-pane --pane-id <weztermPane>` を pane id を引数配列の要素として渡して
   * 実行する（shell を経由しないため文字列インジェクションの経路が無い）。前回呼び出しが未完了
   * （{@link inFlight}）なら新規に `execFile` を起動せず、その結果を共有する（review-changes 修正:
   * in-flight ガード）。
   *
   * @param target 検証済みフォーカス対象（`weztermPane` を使う）。
   * @returns 例外なく終了（exit 0）し、{@link verifyActivation} が無効/検証成功、かつ
   *   {@link raiseWindow}（指定されていれば）も成功したら `ok`。`error.code === 'ENOENT'`
   *   （PATH 上に `command` が見つからない）なら `not_found`。それ以外の例外（タイムアウト含む、
   *   {@link WEZTERM_EXEC_TIMEOUT_MS}）や `verifyActivation`／`raiseWindow` の失敗は `error` に丸める。
   */
  async focus(target: FocusTarget): Promise<FocusResult> {
    if (target.weztermPane === null) {
      return 'not_found'
    }
    if (this.inFlight !== null) {
      return this.inFlight
    }

    const paneId = target.weztermPane
    const run = this.runFocus(paneId).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /**
   * {@link focus} の実処理（in-flight ガードで包む対象、review-changes 修正）。
   *
   * {@link commands} を先頭から順に試す（実機検証で判明した所見への対応）。ENOENT（バイナリ不在）
   * のときのみ次候補へ進み、それ以外の失敗（pane 未検出・タイムアウト等）は即座に `error` として
   * 確定する（誤って別候補へフォールバックし二重実行しないため）。全候補が ENOENT なら `not_found`。
   * 成功した候補は {@link verifyPaneExists} にもそのまま渡し、既に PATH 解決済みのコマンドで
   * 一貫させる（`cli list` を候補探索からやり直さない）。
   */
  private async runFocus(paneId: string): Promise<FocusResult> {
    let resolvedCommand: string | undefined
    for (const [index, command] of this.commands.entries()) {
      try {
        await this.execFile(command, ['cli', 'activate-pane', '--pane-id', paneId], {
          timeout: WEZTERM_EXEC_TIMEOUT_MS,
        })
        resolvedCommand = command
        break
      } catch (error) {
        if (!isEnoent(error)) {
          return 'error'
        }
        if (index === this.commands.length - 1) {
          return 'not_found'
        }
      }
    }
    if (resolvedCommand === undefined) {
      return 'not_found'
    }

    if (this.verifyActivation) {
      const verifyResult = await this.verifyPaneExists(resolvedCommand, paneId)
      if (verifyResult !== 'ok') {
        return verifyResult
      }
    }

    if (this.raiseWindow !== undefined) {
      try {
        await this.raiseWindow()
      } catch {
        return 'error'
      }
    }

    return 'ok'
  }

  /**
   * `<command> cli list --format json` を実行し、`paneId` が結果に実在するかを確認する
   * （{@link WeztermFocusStrategyOptions.verifyActivation}、review-changes 修正）。
   *
   * 一覧取得自体の失敗・JSON 解析失敗・対象 pane 不在のいずれも「検証できない/失敗」とみなし
   * `error` を返す（検証手段が信頼できない場合に exit 0 を無条件の最終成功にしない設計）。
   *
   * @param command 直前の `activate-pane` が成功した（PATH 解決済みの）コマンド。候補探索は
   *   やり直さず、この値をそのまま使う。
   * @param paneId 直前に `activate-pane` を実行した pane id。
   * @returns 一覧中に `pane_id === paneId`（文字列比較）の要素が見つかれば `ok`、それ以外は `error`。
   */
  private async verifyPaneExists(command: string, paneId: string): Promise<FocusResult> {
    try {
      const { stdout } = await this.execFile(command, ['cli', 'list', '--format', 'json'], {
        timeout: WEZTERM_EXEC_TIMEOUT_MS,
      })
      const panes: unknown = JSON.parse(stdout)
      if (!Array.isArray(panes)) {
        return 'error'
      }
      const found = (panes as WeztermPaneListEntry[]).some(
        (pane) => pane !== null && typeof pane === 'object' && String(pane.pane_id) === paneId
      )
      return found ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  }
}

/** System Events から見た WezTerm のプロセス名（`exists process "WezTerm"` に使う）。 */
const WEZTERM_PROCESS_NAME = 'WezTerm'

/**
 * macOS で WezTerm アプリケーションを前面化する AppleScript を組み立てる（{@link raiseWeztermWindowDarwin}）。
 *
 * `terminal-app-strategy.ts` の `buildTerminalAppFocusScript` と同じ System Events ガード
 * （`tell application "WezTerm" to activate` は対象アプリが未起動だと Apple Events 経由で自動起動
 * させてしまうため、`exists process "WezTerm"` で先に確認する。B12 と同種の防御）を踏む。
 * 純粋関数として公開し、`osascript` を経由せず AppleScript の形を直接テストできるようにする。
 *
 * @returns 実行可能な AppleScript ソース全体。
 */
export function buildWeztermRaiseScript(): string {
  const escapedProcess = escapeAppleScriptString(WEZTERM_PROCESS_NAME)
  return [
    'tell application "System Events"',
    `  if not (exists process "${escapedProcess}") then return "false"`,
    'end tell',
    'tell application "WezTerm"',
    '  activate',
    'end tell',
    'return "true"',
  ].join('\n')
}

/**
 * macOS 向け {@link WeztermFocusStrategyOptions.raiseWindow} 既定実装（release-28-wezterm-focus
 * 実機検証で判明した所見への対応）。
 *
 * `wezterm cli activate-pane` は mux 内部のペイン選択を変えるのみで OS レベルのウィンドウ前面化を
 * 行わないため、`osascript`（`osascript.ts` の {@link runOsascript}、`execFile` 非 shell 実行）で
 * WezTerm アプリケーション自体を `activate` する。System Events ガードにより WezTerm が（`activate-pane`
 * 成功後にもかかわらず）見つからない場合は例外を投げ、呼び出し元の `focus()` は `error` に丸める。
 *
 * @param options `osascript` 実行の差し替え（{@link RunOsascriptOptions}、省略可、テスト用）。
 * @throws {Error} System Events から WezTerm プロセスが見つからない場合、または `osascript` 実行
 *   自体が失敗した場合（後者は素通しで reject される）。
 */
export async function raiseWeztermWindowDarwin(options: RunOsascriptOptions = {}): Promise<void> {
  const stdout = await runOsascript(buildWeztermRaiseScript(), options)
  if (stdout !== 'true') {
    throw new Error('WezTerm process not found via System Events (darwin raise)')
  }
}

/** Windows 側 `Get-Process` から見た WezTerm GUI プロセス名（`.exe` 拡張子は含まない）。 */
const WEZTERM_GUI_PROCESS_NAME = 'wezterm-gui'

/**
 * 指定プロセス名のメインウィンドウを `SetForegroundWindow` で前面化する PowerShell スクリプトを
 * 組み立てる（`wsl-strategy.ts` の `FOREGROUND_SCRIPT`〈`WindowsTerminal` 固定〉と同型。対象プロセス
 * が見つからなければ `NOT_FOUND`、成功したら `OK` を stdout へ出力する）。
 *
 * `processName` は呼び出し元がハードコードされた定数のみを渡す想定（reporter/hub 由来の値を
 * 埋め込むことはない）ため、`escapeAppleScriptString` 相当のエスケープは不要。
 *
 * @param processName `Get-Process -Name` に渡すプロセス名。
 * @returns 実行可能な PowerShell スクリプト全体（`;` 区切りの単一行）。
 */
function buildWindowsForegroundScript(processName: string): string {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$p = Get-Process -Name "${processName}" | Select-Object -First 1`,
    'if ($null -eq $p) { Write-Output "NOT_FOUND"; exit 0 }',
    '$sig = \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\'',
    'Add-Type -Name Win32Foreground -Namespace MonomiFocus -MemberDefinition $sig',
    '[MonomiFocus.Win32Foreground]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
    'Write-Output "OK"',
  ].join('; ')
}

/**
 * WSL2 interop 経由で Windows 側の `wezterm-gui.exe` ウィンドウを前面化する
 * {@link WeztermFocusStrategyOptions.raiseWindow} 実装（release-28-wezterm-focus 実機検証で判明した
 * 所見への対応。macOS の {@link raiseWeztermWindowDarwin} と同じ動機だが、Windows には AppleScript
 * が無いため `wsl-strategy.ts` の `SetForegroundWindow` 方式を `wezterm-gui` プロセス向けに転用する）。
 *
 * **未検証**: 実 Windows/WSL2 環境での動作確認は本リリースの手動検証（requirements.md FR-05 AC-5）で
 * 行う。`wezterm.exe cli activate-pane` 自体が WSL interop 経由でサイレント失敗し得る（upstream
 * wezterm/wezterm discussions #6964）のと同様、この前面化ステップも実機でのみ確証が得られる。
 *
 * @param execFile `execFile` の差し替え（省略時は {@link WeztermFocusStrategy} と同じ既定実装）。
 * @throws {Error} `wezterm-gui` プロセスが見つからない場合、または `powershell.exe` 実行自体が
 *   失敗した場合（後者は素通しで reject される）。
 */
export async function raiseWeztermWindowWsl(execFile: ExecFileFn = defaultExecFile): Promise<void> {
  const { stdout } = await execFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    buildWindowsForegroundScript(WEZTERM_GUI_PROCESS_NAME),
  ])
  if (!stdout.includes('OK')) {
    throw new Error('wezterm-gui process not found for foreground (WSL raise)')
  }
}
