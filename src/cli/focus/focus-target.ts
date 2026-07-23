/**
 * wire の {@link TerminalDto}（hub API `SessionDto.terminal`、release-23 FR-03）を厳格検証し、
 * フォーカス実行モジュール共通の {@link FocusTarget} へ写す（release-23 FR-04a）。
 *
 * reporter 由来の値は「認証済みだが信頼しない」（S9/S12 と同じ脅威モデル）。ここでの検証は
 * focus-target 検証 + AppleScript エスケープ（`applescript.ts`）+ `execFile` 非 shell 実行
 * （`osascript.ts`）から成る三段防御の第一段。
 */

import type { TerminalDto } from '../../hub/dto.js'
import type { FocusTarget } from './types.js'

export type { TerminalDto }

/**
 * 検証済み TTY のパターン（FR-04 AC-1）。
 *
 * /dev/ 配下、英数字・ドット・アンダースコア・スラッシュ・ハイフンのみ。シェルメタ文字・空白・
 * 引用符・制御文字をすべて拒否する。文字クラス自体は「..」を弾けない（ドット・スラッシュが
 * 許可文字のため）ので、パストラバーサルは {@link sanitizeTty} 側で別途チェックする。
 */
const TTY_PATTERN = /^\/dev\/[A-Za-z0-9._/-]+$/

/** 検証済み tmux pane 識別子のパターン（例 %3。FR-04 AC-1）。 */
const TMUX_PANE_PATTERN = /^%\d+$/

/** 検証済み WezTerm pane id のパターン（数字のみ。release-28 FR-03a）。 */
const WEZTERM_PANE_PATTERN = /^\d+$/

/**
 * 文字コード 0x20 未満（C0 制御文字）・0x7f（DEL）、または引用符（シングル/ダブル）を含むか判定する。
 *
 * 正規表現の Unicode エスケープ範囲指定ではなく文字コード比較で実装し、tmux_socket の
 * 拒否判定に使う（FR-04 AC-1）。
 *
 * @param value 判定対象の文字列。
 * @returns 禁止文字を含むなら true。
 */
function hasControlOrQuoteChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f || ch === '"' || ch === "'") {
      return true
    }
  }
  return false
}

/**
 * TTY 値を検証する。不合格は「情報なし」へ縮退させ null を返す（FR-04 AC-1）。
 *
 * @param value wire の tty（未捕捉なら null/undefined）。
 * @returns 検証済み TTY、または不合格/未捕捉時 null。
 */
function sanitizeTty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!TTY_PATTERN.test(value) || value.includes('..')) {
    return null
  }
  return value
}

/**
 * tmux pane 識別子を検証する。不合格は「情報なし」へ縮退させ null を返す（FR-04 AC-1）。
 *
 * @param value wire の tmux_pane（未捕捉なら null/undefined）。
 * @returns 検証済み識別子、または不合格/未捕捉時 null。
 */
function sanitizeTmuxPane(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return TMUX_PANE_PATTERN.test(value) ? value : null
}

/**
 * WezTerm pane id を検証する。不合格は「情報なし」へ縮退させ null を返す（release-28 FR-03a）。
 *
 * `wezterm cli activate-pane --pane-id` の引数は配列要素として渡す（`wezterm-strategy.ts`、
 * `execFile` 非 shell 実行）ため、ここでの数字正規表現検証は shell 注入対策としては必須ではないが、
 * tmux_pane と同様に「認証済みだが信頼しない」値の二段防御の第一段として課す。
 *
 * @param value wire の wezterm_pane（未捕捉なら null/undefined）。
 * @returns 検証済み pane id、または不合格/未捕捉時 null。
 */
function sanitizeWeztermPane(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return WEZTERM_PANE_PATTERN.test(value) ? value : null
}

/**
 * tmux socket パスを検証する: 絶対パスかつ制御文字・引用符を含まないこと（FR-04 AC-1）。
 * 不合格は「情報なし」へ縮退させ null を返す。
 *
 * @param value wire の tmux_socket（未捕捉なら null/undefined）。
 * @returns 検証済みパス、または不合格/未捕捉時 null。
 */
function sanitizeTmuxSocket(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (!value.startsWith('/') || hasControlOrQuoteChar(value)) {
    return null
  }
  return value
}

/**
 * strategy 選定のヒントに使うだけの値（term_program/wsl_distro/wt_session）を素通しする。
 *
 * これらはシェル/AppleScript へ埋め込まれず（dispatch の判定材料・表示用途のみ）、
 * tty/tmux_pane/tmux_socket のような注入対策の厳格検証は課さない。
 *
 * @param value wire の値（未捕捉なら null/undefined）。
 * @returns 値、または未捕捉時 null。
 */
function normalizeHint(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : value
}

/**
 * wire の {@link TerminalDto} を厳格検証し、{@link FocusTarget} へ写す（FR-04 AC-1）。
 *
 * reporter 由来の値は「認証済みだが信頼しない」（S9/S12 と同じ脅威モデル）。フィールドごとに
 * 独立して検証し、不合格のフィールドは「情報なし」（null）へ縮退させる（オブジェクト全体を
 * 拒否しない）。例えば tty が不正でも tmux_pane が有効なら tmux-strategy は機能しうるため。
 *
 * dto 自体が null/undefined（reporter がターミナル情報を一度も送っていない、または旧 reporter）
 * なら null を返す。
 *
 * @param dto hub API の SessionDto.terminal（wire、snake_case）。
 * @returns 検証済み {@link FocusTarget}。dto が無ければ null。
 */
export function toFocusTarget(dto: TerminalDto | null | undefined): FocusTarget | null {
  if (dto === null || dto === undefined) {
    return null
  }
  return {
    tty: sanitizeTty(dto.tty),
    termProgram: normalizeHint(dto.term_program),
    tmuxPane: sanitizeTmuxPane(dto.tmux_pane),
    tmuxSocket: sanitizeTmuxSocket(dto.tmux_socket),
    wslDistro: normalizeHint(dto.wsl_distro),
    wtSession: normalizeHint(dto.wt_session),
    weztermPane: sanitizeWeztermPane(dto.wezterm_pane),
  }
}
