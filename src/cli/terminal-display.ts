/**
 * `term_program`/`wsl_distro` の wire 値をターミナルアプリの表示名へ写す純粋関数群（release-24 FR-01、U16）。
 *
 * `terminal-title.ts`/`status-display.ts` と同じく React 非依存の純粋関数として提供し、
 * `detail-view.tsx`（FR-02）・`instance-card.tsx`（FR-03）の両方から呼ばれる表示ロジックを
 * ここに一本化する。
 */

/**
 * 既知の `term_program` wire 値 → 表示名。`session.term_program`（`db/ddl.ts` の `term_program`
 * カラム、`hub/dto.ts` の `terminal.term_program`）にレポーターが書き込む生値に対応する
 * （tmux 内では `TERM_PROGRAM=tmux` になる、`ghostty-strategy.ts`/`terminal-app-strategy.ts` の
 * ヒント判定と同じ値を参照）。
 */
const TERM_PROGRAM_LABELS: Record<string, string> = {
  Apple_Terminal: 'Terminal.app',
  ghostty: 'Ghostty',
  'iTerm.app': 'iTerm2',
  vscode: 'VS Code',
  tmux: 'tmux',
}

/**
 * ターミナルアプリの表示名を導出する（release-24 FR-01、U16）。
 *
 * `termProgram` が既知の wire 値なら対応する表示名（例: `ghostty` → `Ghostty`）を返す。
 * 未知の `termProgram` はマッピングを持たないため、入力値をそのまま返す（`statusLabel` の
 * 未知値フォールバックと同じ方針）。`termProgram` が `null`/空文字列で `wslDistro` が非 `null`/
 * 非空文字列なら WSL ディストリ名（例: `Ubuntu`）を代わりに返す。両方 `null`/空文字列なら
 * `null`（表示側は `-` 等へフォールバックする）。空文字列は reporter 側で `$TERM_PROGRAM` 等が
 * 未設定の場合に渡り得るため、`null` と同様に「情報なし」として扱う（ARCHITECTURE.md §14.3）。
 *
 * 戻り値・入力値ともにレポーター由来の自由記述文字列を含み得るため、本関数自体は除染しない
 * （CWE-150）。呼び出し側（`detail-view.tsx`/`instance-card.tsx`）が `sanitizeDisplayText`/
 * `sanitizeNullableDisplayText`（`sanitize-display-text.ts`）で描画直前に除染する契約とする。
 *
 * @param termProgram `session.term_program`（wire 値、未知値・null を許容）。
 * @param wslDistro `session.wsl_distro`（wire 値、null を許容）。
 * @returns ターミナルアプリの表示名。導出できなければ `null`。
 */
export function terminalDisplayName(
  termProgram: string | null,
  wslDistro: string | null
): string | null {
  if (termProgram != null && termProgram !== '') {
    return TERM_PROGRAM_LABELS[termProgram] ?? termProgram
  }
  return wslDistro != null && wslDistro !== '' ? wslDistro : null
}
