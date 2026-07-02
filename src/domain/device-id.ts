/**
 * hostname から安定した device_id を導出する純粋関数（§9）。
 *
 * hub の bootstrap（`monomi hub` 起動時の自動生成）と child のペアリング
 * （`monomi pair` 時の自動申告）で同一の規則を使うため、DB 依存を持たない domain 層に置く。
 */

/** device_id の自動生成に失敗（hostname が使える文字を含まない等）したときのフォールバック。 */
export const FALLBACK_DEVICE_ID = 'monomi-hub'

/**
 * hostname からダッシュ区切りの device_id を導出する。
 *
 * 先頭の DNS ラベル（最初の `.` まで）を小文字化し、英数字以外を `-` に畳んで両端の `-` を
 * 除去する。結果が空になる場合は {@link FALLBACK_DEVICE_ID} を使う。
 *
 * @param hostname `os.hostname()` 相当の文字列。
 * @returns 安全な device_id 文字列。
 */
export function deriveDeviceId(hostname: string): string {
  const firstLabel = hostname.split('.')[0] ?? ''
  const slug = firstLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : FALLBACK_DEVICE_ID
}
