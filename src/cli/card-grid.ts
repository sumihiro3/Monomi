/**
 * カード型 instance 一覧のグリッド列数判定（§10 / FR-02）。
 *
 * status 導出ロジックは持たない（§0.5）。ここは端末幅と TTY 判定から
 * 「1行あたり何枚のカードを並べるか」だけを計算する純粋関数を提供し、
 * `useStdout` を使うグリッド描画側（instance-table.tsx）から薄く呼べるようにする。
 * React に依存しないため単体テストで境界値を直接検証できる（投資調査の推奨）。
 */

/**
 * カード1枚の目標幅（列数換算、FR-02 未解決事項: 目安 30〜36 列）。
 *
 * 既存テーブルの列幅合計（PROJECT 22 + DEVICE 12 + BRANCH 26 + STATE 14 + AGE ~3 + 余白 ~1
 * ≈ 78）と同程度の情報量を1枚のカードに収める前提で、範囲の上限寄りに固定する。
 */
export const MIN_CARD_WIDTH = 36

/**
 * 端末幅と TTY 判定から、1行あたりのカード列数を返す（FR-02 AC-2/AC-4）。
 *
 * `isTTY` が false、または `width` が未取得（`undefined`）／0 の場合は、
 * 非TTY環境・テスト環境（`ink-testing-library` の `render-to-string` 等）向けの
 * フォールバックとして 1 列固定を返す（AC-4）。それ以外は
 * `Math.floor(width / MIN_CARD_WIDTH)` を列数とし、幅が極端に狭くても最低 1 列を保証する。
 *
 * @param width 端末の桁数（`useStdout().stdout.columns` 相当）。未取得なら `undefined`。
 * @param isTTY 端末が TTY かどうか（`useStdout().stdout.isTTY` 相当）。
 * @returns 1行あたりのカード列数（1 以上の整数）。
 */
export function columnsForWidth(width: number | undefined, isTTY: boolean): number {
  if (!isTTY || !width) {
    return 1
  }
  return Math.max(1, Math.floor(width / MIN_CARD_WIDTH))
}
