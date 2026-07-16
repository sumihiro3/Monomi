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

/**
 * Terminal.app の windows/tabs を走査し `tty of aTab` が `tty` と一致するタブを選択・
 * ウィンドウを前面化する AppleScript ソースを組み立てる（FR-04 AC-3）。
 *
 * `tty` は呼び出し側（`focus-service.ts`）に渡ってくる時点で `focus-target.ts#toFocusTarget`
 * による厳格検証済みの値だが、本関数自身も {@link escapeAppleScriptString} を必ず経由してから
 * スクリプトへ埋め込む（三段防御の第二段。呼び出し順序に依存せず本関数単体でも安全な作り）。
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
  return [
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
   * `tty` の一致するタブへフォーカスする（AC-3）。
   *
   * @param tty 検証済み TTY。
   * @returns `osascript` の stdout が `"true"` なら `ok`、`"false"`（対象タブなし）なら
   *   `not_found`。`osascript` 実行自体が失敗（Terminal.app 未起動・権限不足等）した場合は `error`
   *   に丸める（`focus-service.ts` 側でも strategy 例外は `error` へ丸めるが、ここでも自己完結して
   *   `FocusResult` を返せるようにしておく）。
   */
  async focus(tty: string): Promise<FocusResult> {
    const script = buildTerminalAppFocusScript(tty)
    let stdout: string
    try {
      stdout = await runOsascript(script, { exec: this.exec })
    } catch {
      return 'error'
    }
    return stdout === 'true' ? 'ok' : 'not_found'
  }
}
