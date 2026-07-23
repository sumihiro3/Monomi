import { escapeAppleScriptString } from './applescript.js'
import { type RunOsascriptOptions, runOsascript } from './osascript.js'
import type { FocusResult, FocusTarget, Strategy } from './types.js'

/**
 * macOS Terminal.app が設定する `$TERM_PROGRAM` の値。
 *
 * darwin での strategy 総当たり順を決める hint 判定に使う（`types.ts` の {@link Strategy}
 * `matchesHint`、FR-04 AC-6）。tmux 内では `TERM_PROGRAM` が `tmux` になり一致しないため、その
 * 場合は hint なしの総当たりへ自然にフォールバックする（`focus-service.ts` 側の設計）。
 */
export const TERMINAL_APP_TERM_PROGRAM = 'Apple_Terminal'

/** System Events から見た Terminal.app のプロセス名（`exists process "Terminal"` に使う）。 */
const TERMINAL_APP_PROCESS_NAME = 'Terminal'

/**
 * Terminal.app の windows/tabs を走査し `tty of aTab` が `tty` と一致するタブを選択・
 * ウィンドウを前面化する AppleScript ソースを組み立てる（FR-04 AC-3、FR-06a）。
 *
 * `tty` は呼び出し側（`focus-service.ts`）に渡ってくる時点で `focus-target.ts#toFocusTarget`
 * による厳格検証済みの値だが、本関数自身も {@link escapeAppleScriptString} を必ず経由してから
 * スクリプトへ埋め込む（三段防御の第二段。呼び出し順序に依存せず本関数単体でも安全な作り）。
 *
 * `tell application "Terminal"` へ入る前に、`ghostty-strategy.ts` の
 * {@link import('./ghostty-strategy.js').buildGhosttyFocusScript} と同型の System Events ガードで
 * Terminal.app が既に起動しているかを確認する。`tell application "Terminal"` は対象アプリが未起動
 * だと Apple Events 経由で自動起動させてしまう（B12）ため、未起動なら Terminal 側の処理へ進まず
 * `"false"` を返して strategy 側では `not_found` に丸める。
 *
 * 一致するタブが見つかれば所属ウィンドウを `frontmost` にし、タブを `selected` にした上で
 * アプリ自体を `activate` して stdout へ `"true"` を返す。見つからなければ `"false"` を返す
 * （呼び出し側はこの文字列で成否判定する。AC-3: 「osascript stdout の true で成功判定」）。
 *
 * 純粋関数として公開し、生成される AppleScript の形（エスケープ・構造）を execFile を経由せず
 * 直接テストできるようにする。
 *
 * @param tty 検証済み TTY（例 `/dev/ttys003`）。
 * @returns 実行可能な AppleScript ソース全体。
 */
export function buildTerminalAppFocusScript(tty: string): string {
  const escapedTty = escapeAppleScriptString(tty)
  const escapedProcess = escapeAppleScriptString(TERMINAL_APP_PROCESS_NAME)
  return [
    'tell application "System Events"',
    `  if not (exists process "${escapedProcess}") then return "false"`,
    'end tell',
    'tell application "Terminal"',
    '  set foundTab to missing value',
    '  set foundWindow to missing value',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    `      if tty of t is "${escapedTty}" then`,
    '        set foundTab to t',
    '        set foundWindow to w',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '    if foundTab is not missing value then exit repeat',
    '  end repeat',
    '  if foundTab is not missing value then',
    '    set frontmost of foundWindow to true',
    '    set selected of foundTab to true',
    '    activate',
    '    return "true"',
    '  else',
    '    return "false"',
    '  end if',
    'end tell',
  ].join('\n')
}

/** {@link TerminalAppStrategy} の依存差し替え（テスト用）。 */
export interface TerminalAppStrategyOptions {
  /** `osascript` 実行の差し替え。省略時は実 `execFile` ベースの既定実装（`osascript.ts`）。 */
  exec?: RunOsascriptOptions['exec']
}

/**
 * Terminal.app 向けフォーカス strategy（release-23-terminal-focus FR-04b、`types.ts` の
 * {@link Strategy} 実装、AC-3）。
 *
 * `tty of aTab` の一致でタブを選び、ウィンドウ前面化 + タブ選択 + `activate` する。子プロセス
 * 起動は `osascript.ts` の {@link runOsascript}（`execFile` 非 shell）を経由し、文字列埋め込みは
 * `applescript.ts` の {@link escapeAppleScriptString} を必ず経由する（三段防御のうち第二・第三段。
 * 第一段の値検証は `focus-target.ts` が担う）。
 */
export class TerminalAppStrategy implements Strategy {
  private readonly exec: RunOsascriptOptions['exec']

  /** @param options `exec` の差し替え（{@link TerminalAppStrategyOptions}、省略可）。 */
  constructor(options: TerminalAppStrategyOptions = {}) {
    this.exec = options.exec
  }

  /**
   * darwin での strategy 並べ替えヒント（AC-6）: `term_program` が Terminal.app のものと一致するか。
   *
   * @param target 検証済みフォーカス対象。
   * @returns 一致すれば true。
   */
  matchesHint(target: FocusTarget): boolean {
    return target.termProgram === TERMINAL_APP_TERM_PROGRAM
  }

  /**
   * `target.tty` の一致するタブへフォーカスする（AC-3、release-28-wezterm-focus FR-04-pre で
   * 引数を `tty` 単独から `target: FocusTarget` へ移行）。
   *
   * `target.tty` が `null`（reporter が TTY を解決できなかった場合。WSL2 等で `weztermPane` のみ
   * 有効なケースを含む、release-28-wezterm-focus 所見対応）なら `execFile` を呼ばず `not_found` を
   * 返す。以前は「呼び出し側が非 null を保証する」前提で無条件に `as string` キャストしていたが、
   * `focus-service.ts` 側が tty 単独では総当たりを止めないよう変更されたため、本 strategy 自身が
   * 前提を検証する（ARCHITECTURE.md §14.3: フィールドごとに独立して機能可否を判定する規約）。
   *
   * @param target 検証済みフォーカス対象（`tty` を使う）。
   * @returns `tty` が `null` なら `not_found`。それ以外は `osascript` の stdout が `"true"` なら
   *   `ok`、`"false"`（対象タブなし、または {@link buildTerminalAppFocusScript} の System Events
   *   ガードにより Terminal.app が未起動と判定された場合。FR-06a）なら `not_found`。`osascript`
   *   実行自体が失敗（権限不足等）した場合は `error` に丸める（`focus-service.ts` 側でも strategy
   *   例外は `error` へ丸めるが、ここでも自己完結して `FocusResult` を返せるようにしておく）。
   */
  async focus(target: FocusTarget): Promise<FocusResult> {
    if (target.tty === null) {
      return 'not_found'
    }
    const script = buildTerminalAppFocusScript(target.tty)
    let stdout: string
    try {
      stdout = await runOsascript(script, { exec: this.exec })
    } catch {
      return 'error'
    }
    return stdout === 'true' ? 'ok' : 'not_found'
  }
}
