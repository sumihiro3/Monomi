import fs from 'node:fs'
import path from 'node:path'
import { escapeAppleScriptString, quoteAppleScriptString } from './applescript.js'
import { type RunOsascriptOptions, runOsascript } from './osascript.js'
import type { FocusResult, FocusTarget, Strategy } from './types.js'

/**
 * Ghostty が設定する `$TERM_PROGRAM` の値。
 *
 * darwin での strategy 総当たり順を決める hint 判定に使う（`types.ts` の {@link Strategy}
 * `matchesHint`、FR-04 AC-6）。tmux 内では `TERM_PROGRAM` が `tmux` になり一致しないため、その
 * 場合は hint なしの総当たりへ自然にフォールバックする（`focus-service.ts` 側の設計）。
 */
export const GHOSTTY_TERM_PROGRAM = 'ghostty'

/** System Events から見た Ghostty プロセス名（`tell process "Ghostty"` に使う）。 */
const GHOSTTY_PROCESS_NAME = 'Ghostty'

/** Ghostty の Window メニュー内でタブ/ウィンドウを一意に見分けるためのタグ接頭辞。 */
const TAG_PREFIX = 'monomi:'

/** OSC シーケンスの開始（ESC、コード 27）。`terminal-title.ts` と同じ組み立て方（生の制御文字を
 * ソースへ直接埋め込むと編集時に事故りやすいため `String.fromCharCode` を使う）。 */
const OSC_ESC = String.fromCharCode(27)

/** OSC シーケンスの終端（BEL、コード 7）。 */
const OSC_BEL = String.fromCharCode(7)

/**
 * TTY へ書き込む OSC タイトルタグ（`monomi:<tty basename>`、例 `monomi:ttys003`）を組み立てる
 * （FR-04 AC-4）。
 *
 * `tty` は呼び出し側で検証済みの値だが、`path.basename` はどのような文字列を渡されても例外を
 * 投げずに末尾セグメントを返すため、ここでの追加検証は不要（タグは表示・検索用途のみで
 * シェル/AppleScript への直接埋め込みは {@link buildGhosttyFocusScript} 側でエスケープする）。
 *
 * @param tty 検証済み TTY（例 `/dev/ttys003`）。
 * @returns タグ文字列（例 `monomi:ttys003`）。
 */
export function buildGhosttyTag(tty: string): string {
  return `${TAG_PREFIX}${path.basename(tty)}`
}

/**
 * OSC 0（アイコン名＋ウィンドウタイトル設定）のエスケープシーケンスを組み立てる。
 *
 * `title` に空文字列を渡すとタイトルをクリアする（タグ消去、AC-4 の finally 用）。
 *
 * @param title 設定したいタイトル本文。
 * @returns TTY へそのまま書き込める生バイト列（制御文字含む）。
 */
export function buildOscTitleSequence(title: string): string {
  return `${OSC_ESC}]0;${title}${OSC_BEL}`
}

/**
 * System Events で Ghostty の Window メニューを `tag` 名で検索してクリック（2 回）し、
 * 見つかった場合はさらに `AXRaise` を試みる AppleScript ソースを組み立てる（FR-04 AC-4）。
 *
 * 2 回クリックするのは、Ghostty/System Events の組み合わせで 1 回のクリックだけではタブ選択のみに
 * 留まりウィンドウ自体が前面化しないことがある実践的な回避策（`AXRaise` も併用して確実性を上げる）。
 * `AXRaise` 自体の失敗（対象ウィンドウが見つからない等）はメニュー項目のクリックが既に成功して
 * いれば致命的ではないため `try`...`end try` で握りつぶす。
 *
 * `tag` は必ず {@link escapeAppleScriptString}/{@link quoteAppleScriptString} 経由でのみ埋め込む
 * （三段防御の第二段。第一段の値検証は呼び出し元が渡す `tty` を経由した `focus-target.ts`、
 * 第三段は `osascript.ts` の execFile 非 shell 実行）。
 *
 * @param tag {@link buildGhosttyTag} が組み立てたタグ文字列。
 * @returns 実行可能な AppleScript ソース全体。メニュー項目が見つかり操作できれば stdout へ
 *   `"true"`、見つからなければ `"false"` を返す。
 */
export function buildGhosttyFocusScript(tag: string): string {
  const escapedProcess = escapeAppleScriptString(GHOSTTY_PROCESS_NAME)
  const quotedTag = quoteAppleScriptString(tag)
  return [
    'tell application "System Events"',
    `  if not (exists process "${escapedProcess}") then return "false"`,
    `  tell process "${escapedProcess}"`,
    `    if not (exists menu item ${quotedTag} of menu "Window" of menu bar 1) then return "false"`,
    `    set targetItem to menu item ${quotedTag} of menu "Window" of menu bar 1`,
    '    click targetItem',
    '    click targetItem',
    '    try',
    `      perform action "AXRaise" of (first window whose name contains ${quotedTag})`,
    '    end try',
    '  end tell',
    '  return "true"',
    'end tell',
  ].join('\n')
}

/**
 * System Events で Ghostty プロセスが起動しているかどうかだけを確認する AppleScript ソースを
 * 組み立てる（FR-06、B12: Terminal.app 誤起動防止と同種のガードを Ghostty 側にも適用）。
 *
 * {@link buildGhosttyFocusScript} にも同じ `exists process` チェックが含まれるが、そちらは
 * Window メニュー検索と一体化しており、TTY へタグを書き込む副作用（{@link GhosttyStrategy}
 * の `writeTtyTitle`）より前に軽量な事前確認だけを行いたい用途には使えない。そのため独立した
 * 関数として切り出す。
 *
 * @returns 実行可能な AppleScript ソース全体。Ghostty プロセスが存在すれば stdout へ `"true"`、
 *   存在しなければ `"false"` を返す。
 */
export function buildGhosttyProcessExistsScript(): string {
  const escapedProcess = escapeAppleScriptString(GHOSTTY_PROCESS_NAME)
  return [
    'tell application "System Events"',
    `  if not (exists process "${escapedProcess}") then return "false"`,
    '  return "true"',
    'end tell',
  ].join('\n')
}

/** {@link GhosttyStrategy} の依存差し替え（テスト用）。 */
export interface GhosttyStrategyOptions {
  /** `osascript` 実行の差し替え。省略時は実 `execFile` ベースの既定実装（`osascript.ts`）。 */
  exec?: RunOsascriptOptions['exec']
  /**
   * TTY デバイスファイルへの OSC タイトル書き込みの差し替え。省略時は実 `fs.appendFileSync`
   * （`memory-watchdog.ts` の `appendFile` 注入と同じパターン）。テストでは実デバイスファイルへ
   * 書き込まないモックに差し替える。
   */
  writeTtyTitle?: (ttyPath: string, oscSequence: string) => void
}

/**
 * {@link GhosttyStrategy.attemptOnce} と `focus()` 間で共有する試行状態。
 *
 * `wroteTag` は、いずれかの試行で TTY へのタグ書き込み（`writeTtyTitle`）に実際に成功したかを
 * 表す。プロセス未起動などでタグを一度も書き込んでいない場合、`focus()` の `finally` はタグ消去
 * （空タイトルの書き込み）自体を省略する（FR-06、B12: 存在しないアプリの tty へ無駄な書き込み
 * ・例外を起こさないため）。
 */
interface AttemptState {
  /** いずれかの試行でタグ書き込みに成功していれば true。 */
  wroteTag: boolean
}

/**
 * Ghostty 向けフォーカス strategy（release-23-terminal-focus FR-04b、`types.ts` の
 * {@link Strategy} 実装、AC-4。FR-06/B12 でプロセス存在確認ガードを追加）。
 *
 * Ghostty は AppleScript から直接 tty を問い合わせられないため、TTY デバイスファイルへ
 * OSC タイトルタグを一時書き込みし、System Events でそのタグ名を Window メニューから検索して
 * クリックする間接的な手順を取る。ただし書き込みは副作用のため、まず Ghostty プロセスが実際に
 * 起動しているかを {@link buildGhosttyProcessExistsScript} で確認し、起動していなければ
 * `writeTtyTitle` を一切呼ばずに `not_found` を返す（プロセス存在確認 → TTY タグ書き込み →
 * メニュー検索の順）。存在する場合の書き込み→メニュー操作の一連の手順が失敗した場合は 1 回だけ
 * リトライし、タグを書き込んだ試行が 1 回でもあれば `finally` で必ずタグを消去する
 * （book-keeping の取りこぼしでウィンドウタイトルにタグが残り続けることを防ぐ）。
 */
export class GhosttyStrategy implements Strategy {
  private readonly exec: RunOsascriptOptions['exec']
  private readonly writeTtyTitle: (ttyPath: string, oscSequence: string) => void

  /** @param options `exec`/`writeTtyTitle` の差し替え（{@link GhosttyStrategyOptions}、省略可）。 */
  constructor(options: GhosttyStrategyOptions = {}) {
    this.exec = options.exec
    this.writeTtyTitle =
      options.writeTtyTitle ?? ((ttyPath, oscSequence) => fs.appendFileSync(ttyPath, oscSequence))
  }

  /**
   * darwin での strategy 並べ替えヒント（AC-6）: `term_program` が Ghostty のものと一致するか。
   *
   * @param target 検証済みフォーカス対象。
   * @returns 一致すれば true。
   */
  matchesHint(target: FocusTarget): boolean {
    return target.termProgram === GHOSTTY_TERM_PROGRAM
  }

  /**
   * `tty` が指すウィンドウ/タブへフォーカスする（AC-4、FR-06/B12）。
   *
   * 1 回目が `ok` にならなければプロセス存在確認からやり直して 1 回だけリトライする。タグを
   * 書き込んだ試行が 1 回でもあれば、試行回数・成否にかかわらず最後に必ずタグを消去する
   * （アクセシビリティ権限が無い等でメニュー検索自体が例外を投げても、タグ消去は独立して試みる）。
   * 逆に、Ghostty プロセスが一度も見つからずタグを書き込んでいなければ、タグ消去も省略する
   * （存在しない tty への無駄な書き込みを避ける）。
   *
   * @param tty 検証済み TTY。
   * @returns フォーカス結果（`ok` / `not_found` / `error`。`ghostty-strategy` は
   *   `tmux_detached`/`unsupported_platform` を返すことはない）。
   */
  async focus(tty: string): Promise<FocusResult> {
    const tag = buildGhosttyTag(tty)
    const attemptState: AttemptState = { wroteTag: false }
    try {
      const first = await this.attemptOnce(tty, tag, attemptState)
      if (first === 'ok') {
        return first
      }
      return await this.attemptOnce(tty, tag, attemptState)
    } finally {
      if (attemptState.wroteTag) {
        this.clearTag(tty)
      }
    }
  }

  /**
   * プロセス存在確認 → TTY タグ書き込み → System Events でのメニュー検索・クリック の順に
   * 1 回分実行する（FR-06、B12）。
   *
   * Ghostty プロセスが起動していなければ `writeTtyTitle` を一切呼ばずに `not_found` を返す。
   *
   * @param state 呼び出し元（{@link focus}）と共有する試行状態。タグ書き込みに成功したときのみ
   *   `wroteTag` を `true` にする。
   */
  private async attemptOnce(tty: string, tag: string, state: AttemptState): Promise<FocusResult> {
    let exists: boolean
    try {
      exists = await this.existsGhosttyProcess()
    } catch {
      return 'error'
    }
    if (!exists) {
      return 'not_found'
    }

    try {
      this.writeTtyTitle(tty, buildOscTitleSequence(tag))
      state.wroteTag = true
    } catch {
      return 'error'
    }

    const script = buildGhosttyFocusScript(tag)
    let stdout: string
    try {
      stdout = await runOsascript(script, { exec: this.exec })
    } catch {
      return 'error'
    }
    return stdout === 'true' ? 'ok' : 'not_found'
  }

  /**
   * Ghostty プロセスが起動しているかどうかを確認する（FR-06、B12: TTY 書き込み前のガード）。
   *
   * @returns プロセスが存在すれば true。
   * @throws `osascript` 実行自体が失敗した場合（呼び出し元 {@link attemptOnce} で `error` に
   *   丸める）。
   */
  private async existsGhosttyProcess(): Promise<boolean> {
    const stdout = await runOsascript(buildGhosttyProcessExistsScript(), { exec: this.exec })
    return stdout === 'true'
  }

  /**
   * タグを消去する（空タイトルを書き込む）。失敗は無視する — タグ消去自体は表示上の後始末に
   * すぎず、`focus()` の戻り値（利用者への成否通知）に影響させるべきではないため。
   */
  private clearTag(tty: string): void {
    try {
      this.writeTtyTitle(tty, buildOscTitleSequence(''))
    } catch {
      // 消去失敗はタイトルタグが一時的に残るだけで実害が薄い（次回フォーカス実行時にも
      // 同じタグで上書きされる）ため、意図的に握りつぶす。
    }
  }
}
