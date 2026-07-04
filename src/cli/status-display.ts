import { type TranslationKey, t } from '../i18n/index.js'

/**
 * CLI 表示専用の状態語彙（ラベル・色・グリフ・フィルタキー対応・経過時間整形）。
 *
 * ここには status 導出ロジックを一切持たない（§0.5: 導出・優先順位は hub 側の責務）。
 * hub が返す wire の `display` 文字列（小文字 snake。例 `approval_wait`）を、
 * ターミナル表示用のラベル・色・グリフへ写すだけの presentation 語彙を集約する。
 * ラベルはアクティブロケールに応じて `t()`（`src/i18n/`）経由で解決する
 * （release-9-i18n FR-02 AC-2）。色・グリフはロケール非依存。
 */

/**
 * `1`–`6` キーで切り替えられる表示ステータス（§10.3 のうち release-1 対象。
 * `closed` もフィルタ対象に含め、キー`6`でトグル可能、§5.1）。
 */
export type StatusFilter = 'active' | 'approval_wait' | 'next_wait' | 'pr_wait' | 'stale' | 'closed'

/**
 * フィルタキー（`1`–`6`）に対応する {@link StatusFilter} の並び（§10.2 の表示順に一致）。
 * 添字 0 が `1` キー。ここが「キー番号 → 表示状態」の対応を持つ唯一の場所。
 */
export const FILTER_ORDER: readonly StatusFilter[] = [
  'active',
  'approval_wait',
  'next_wait',
  'pr_wait',
  'stale',
  'closed',
]

/**
 * 表示状態 → 翻訳キー（§10.2、release-9-i18n FR-02 AC-2）。`statusLabel` はこのマップに
 * 存在するキーでのみ `t()` を呼ぶ。未知の `display` はマップに存在しないため、`t()` を経由せず
 * `display` をそのまま返す分岐へ流れる（未知値フォールバックの回帰防止）。
 */
const STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  active: 'status.active',
  approval_wait: 'status.approvalWait',
  next_wait: 'status.nextWait',
  pr_wait: 'status.prWait',
  stale: 'status.stale',
  closed: 'status.closed',
}

/** 表示状態 → Ink の色名。未知値は既定色。 */
const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  approval_wait: 'yellow',
  next_wait: 'cyan',
  pr_wait: 'blue',
  stale: 'red',
  closed: 'gray',
}

/**
 * 表示状態のラベルを、アクティブロケールで解決して返す（release-9-i18n FR-02 AC-2）。
 *
 * @param display wire の表示状態（小文字 snake）。
 * @returns アクティブロケールのラベル（`t()` 経由）。未知値は入力をそのまま返す。
 */
export function statusLabel(display: string): string {
  const key = STATUS_LABEL_KEYS[display]
  return key ? t(key) : display
}

/**
 * 表示状態に対応する Ink の色名を返す。
 *
 * @param display wire の表示状態。
 * @returns Ink `color` プロパティに渡す色名。未知値は `white`。
 */
export function statusColor(display: string): string {
  return STATUS_COLORS[display] ?? 'white'
}

/**
 * 表示状態の先頭グリフを返す（§10.2: 稼働中は塗り、待機は白丸）。
 *
 * @param display wire の表示状態。
 * @returns 1 文字のグリフ。
 */
export function statusGlyph(display: string): string {
  if (display === 'active') return '●'
  if (display === 'closed') return '·'
  return '○'
}

/**
 * 押されたキー文字（`1`–`6`）を {@link StatusFilter} へ写す。
 *
 * @param input `useInput` が渡す入力文字。
 * @returns 対応する {@link StatusFilter}。範囲外・非数字なら null。
 */
export function filterForKey(input: string): StatusFilter | null {
  const index = Number(input) - 1
  if (!Number.isInteger(index) || index < 0 || index >= FILTER_ORDER.length) {
    return null
  }
  return FILTER_ORDER[index]
}

/**
 * 経過秒数を人間可読な短い相対表記へ整形する（§10.2 の AGE 列）。
 *
 * 60 秒未満は `s`、60 分未満は `m`、24 時間未満は `h`、それ以上は `d`。
 *
 * @param seconds 経過秒数（`status.elapsed_seconds`）。
 * @returns `2m` `3h` `1d` のような短い表記。
 */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
