/**
 * BOX の上辺／下辺罫線にタイトル・ラベルを埋め込む純粋関数（release-6 FR-06 / FR-07）。
 *
 * `card-grid.ts`（{@link ./card-grid.js}）・`event-scroll.ts`（{@link ./event-scroll.js}）と同じ思想で、
 * React に依存しない純粋関数として提供する。DetailView 側は Ink の `borderStyle="round"` から
 * 上辺（あるいは下辺）だけを `borderTop={false}` で切り離し、ここで生成した罫線文字列を
 * 差し替えるだけでよい。単体テストで境界値（全角混じり・幅ちょうど・はみ出し・非TTY）を直接検証できる。
 *
 * 最大の技術リスクは CJK 全角タイトル（`概要`=2文字だが表示4桁、`イベント履歴`=6文字→12桁）の
 * 表示幅計算で、これを誤ると角文字（╮/╯）が Ink 側辺 `│` とずれる。外部依存（string-width 等）を
 * 追加せず、{@link displayWidth} で East Asian Wide/Fullwidth を2桁として数えることでずれを防ぐ。
 */

/**
 * `columns` 未取得（非TTY 等）時の固定 BOX 幅（FR-06 のフォールバック）。
 *
 * `card-grid.ts` の 1 列フォールバック・`event-scroll.ts` の {@link ./event-scroll.js#FALLBACK_VISIBLE_ROWS}
 * と同じく、`ink-testing-library` の render-to-string など `stdout.columns` が取れない環境向けに、
 * ここで定めた固定幅を必ず返す。80 は一般的な端末既定幅に合わせた値。
 */
export const FALLBACK_BOX_WIDTH = 80

/**
 * 罫線として成立する最小 BOX 幅（左右の角 2 文字ぶん）。
 *
 * `columnsForWidth` が `Math.max(1, …)` で最低 1 列を保証するのと同じ思想で、
 * 極端に狭い幅でも角文字が欠けた壊れた罫線を返さないための下限。
 */
const MIN_BOX_WIDTH = 2

/**
 * タイトル／ラベル本文以外が消費する表示桁数の固定内訳。
 *
 * 上辺: `╭`(1) + `─`(1) + ` `(1) + 本文 + ` `(1) + `╮`(1) → 本文とフィル以外で 5 桁。
 * 下辺: `╰`(1) + フィル + ` `(1) + 本文 + ` `(1) + `─`(1) + `╯`(1) → 同じく 5 桁。
 * フィル（`─` の反復）は幅ちょうどに合わせる可変部分で、この 5 桁には含めない。
 */
const CHROME_WIDTH = 5

/**
 * 端末桁数と TTY 判定から、BOX の表示幅（桁数）を返す（FR-06）。
 *
 * `isTTY` が false、または `columns` が未取得（`undefined`）／0 の場合は
 * {@link FALLBACK_BOX_WIDTH} を返す（`columnsForWidth` / `visibleRowsForHeight` と同じ
 * フォールバック思想）。それ以外は `columns` をそのまま幅とする。
 * 極端に狭い幅への丸めは罫線生成側（{@link topBorderWithTitle} / {@link bottomBorderWithLabel}）が
 * {@link MIN_BOX_WIDTH} で担保するため、ここでは解決した幅をそのまま返す。
 *
 * @param columns 端末の桁数（`useStdout().stdout.columns` 相当）。未取得なら `undefined`。
 * @param isTTY 端末が TTY かどうか（`useStdout().stdout.isTTY` 相当）。
 * @returns BOX の表示幅（桁数）。
 */
export function resolveBoxWidth(columns: number | undefined, isTTY: boolean): number {
  if (!isTTY || !columns) {
    return FALLBACK_BOX_WIDTH
  }
  return columns
}

/**
 * 1 コードポイントが East Asian Wide/Fullwidth（表示 2 桁）かどうかを判定する。
 *
 * 判定表は Unicode East Asian Width の Wide(W)/Fullwidth(F) 区分（`is-fullwidth-code-point` 相当）に
 * 従う。CJK 統合漢字・かな・ハングル・全角記号・一部の絵文字ブロックなどが該当する。
 * Box Drawing（U+2500–U+257F, `╭─╮╰╯│` 等）は Ambiguous(A) 区分で表に含まれないため 1 桁扱いとなり、
 * 罫線自身の桁計算と整合する。
 *
 * @param codePoint `String.prototype.codePointAt` で得たコードポイント。
 * @returns 全角なら true。
 */
function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f || // Hangul Jamo
      codePoint === 0x2329 || // 〈 LEFT-POINTING ANGLE BRACKET
      codePoint === 0x232a || // 〉 RIGHT-POINTING ANGLE BRACKET
      (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK Radicals .. Kangxi（U+303F は除外）
      (codePoint >= 0x3041 && codePoint <= 0x33ff) || // かな・記号 .. CJK Compatibility
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Ideographs Extension A
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
      (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi Syllables / Radicals
      (codePoint >= 0xa960 && codePoint <= 0xa97f) || // Hangul Jamo Extended-A
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
      (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // Vertical Forms
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK Compatibility / Small Form Variants
      (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth Forms
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth signs
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // Misc Symbols and Pictographs / Emoticons
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) || // Supplemental Symbols and Pictographs
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)) // CJK Extension B 以降
  )
}

/**
 * 文字列の表示桁数を数える（East Asian Wide/Fullwidth を 2 桁、それ以外を 1 桁）。
 *
 * 外部依存（string-width 等）を追加せず、`for…of` でコードポイント単位に走査する
 * （サロゲートペアを正しく 1 コードポイントとして扱う）。`概要` は 4、`イベント履歴` は 12 を返す。
 * 結合文字・制御文字・ANSI エスケープの 0 幅化は行わない（本モジュールが対象とするタイトル／
 * ラベルは素のプレーンテキストのため。必要になったら別途拡張する）。
 *
 * @param str 表示桁数を数えたい文字列。
 * @returns 表示桁数（0 以上の整数）。
 */
export function displayWidth(str: string): number {
  let width = 0
  for (const ch of str) {
    const codePoint = ch.codePointAt(0)
    if (codePoint === undefined) {
      continue
    }
    width += isFullWidthCodePoint(codePoint) ? 2 : 1
  }
  return width
}

/**
 * 表示桁数が `maxWidth` を超えないよう、コードポイント境界で切り詰める。
 *
 * 全角文字が半端に収まらない場合はその文字を含めない（表示桁が `maxWidth` を超えないことを優先）。
 * その結果 1 桁余ることがあるが、余りは呼び出し側でフィル（`─`）に回るため罫線全体の桁は狂わない。
 *
 * @param str 切り詰め対象の文字列。
 * @param maxWidth 許容する最大表示桁数。
 * @returns 表示桁が `maxWidth` 以下に収まる先頭部分文字列。
 */
function truncateToWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return ''
  }
  let out = ''
  let width = 0
  for (const ch of str) {
    const codePoint = ch.codePointAt(0)
    const w = codePoint !== undefined && isFullWidthCodePoint(codePoint) ? 2 : 1
    if (width + w > maxWidth) {
      break
    }
    out += ch
    width += w
  }
  return out
}

/**
 * タイトルを左寄せで埋め込んだ上辺罫線を生成する（FR-06、丸角 `╭╮─`）。
 *
 * 形は `╭─ title ─…─╮`。返り値の表示桁数（{@link displayWidth}）は必ず `width` ちょうどになるため、
 * Ink の `borderStyle="round"` の左右 `│` と角 `╭╮` が桁ずれしない。`title` が長すぎて
 * フィルが負になる場合は表示桁で切り詰めてフィル 0 以上を保証する。切り詰め後に本文が 0 桁に
 * なる（幅が極端に狭い）場合はタイトル無しの丸角罫線 `╭──…──╮` にフォールバックする。
 *
 * @param width BOX の表示幅（{@link resolveBoxWidth} の戻り値）。{@link MIN_BOX_WIDTH} 未満は丸める。
 * @param title 上辺に埋め込むタイトル（例 `概要` / `イベント履歴`）。
 * @returns 表示桁数が `width` ちょうどの上辺罫線文字列。
 */
export function topBorderWithTitle(width: number, title: string): string {
  const w = Math.max(MIN_BOX_WIDTH, Math.floor(width))
  const maxTitleWidth = Math.max(0, w - CHROME_WIDTH)
  const rendered = truncateToWidth(title, maxTitleWidth)
  const titleWidth = displayWidth(rendered)
  if (titleWidth === 0) {
    return `╭${'─'.repeat(w - 2)}╮`
  }
  const fill = w - CHROME_WIDTH - titleWidth
  return `╭─ ${rendered} ${'─'.repeat(fill)}╮`
}

/**
 * ラベルを右寄せで埋め込んだ下辺罫線を生成する（FR-07、丸角 `╰╯─`）。
 *
 * 形は `╰─…─ label ─╯`（上辺タイトルと対になる右寄せ）。返り値の表示桁数は必ず `width`
 * ちょうどになる。`label` が長すぎる場合は表示桁で切り詰めてフィル 0 以上を保証し、切り詰め後に
 * 本文が 0 桁になる場合はラベル無しの丸角罫線 `╰──…──╯` にフォールバックする。
 *
 * @param width BOX の表示幅（{@link resolveBoxWidth} の戻り値）。{@link MIN_BOX_WIDTH} 未満は丸める。
 * @param label 下辺に埋め込むラベル（例 `1-10 of 34`）。
 * @returns 表示桁数が `width` ちょうどの下辺罫線文字列。
 */
export function bottomBorderWithLabel(width: number, label: string): string {
  const w = Math.max(MIN_BOX_WIDTH, Math.floor(width))
  const maxLabelWidth = Math.max(0, w - CHROME_WIDTH)
  const rendered = truncateToWidth(label, maxLabelWidth)
  const labelWidth = displayWidth(rendered)
  if (labelWidth === 0) {
    return `╰${'─'.repeat(w - 2)}╯`
  }
  const fill = w - CHROME_WIDTH - labelWidth
  return `╰${'─'.repeat(fill)} ${rendered} ─╯`
}
