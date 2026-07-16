import { displayWidth, isFullWidthCodePoint, truncateToWidth } from './box-border.js'

/**
 * `instance.path`（{@link ../hub/dto.js#InstanceStatusRow.path}）をカード幅に収めるための
 * 中間省略ヘルパー（release-24 FR-04 / `docs/known-issues.md` U18）。
 *
 * カード表示は Ink の `wrap="truncate-end"`（末尾省略）が既定だが、path は末尾のリポジトリ名・
 * worktree 名が識別性を担うことが多く、末尾が消えると別 instance と見分けが付かなくなる
 * （例 `release-23`/`release-24` の worktree 違い）。`先頭…末尾` 形式で中間だけを省略し、
 * 全角文字混じりの path でも {@link displayWidth}（box-border.ts, East Asian Wide/Fullwidth を
 * 2桁扱い）で正しく幅計算する。`truncateToWidth`・`isFullWidthCodePoint` は box-border.ts の
 * 既存実装を export 化して再利用し（重複回避）、判定基準を単一化する。
 */

/** 省略記号（`…`）。Box Drawing 文字と同じ Ambiguous 区分のため表示幅は 1 桁。 */
const ELLIPSIS = '…'

/**
 * 中間省略が成立する（先頭・末尾に最低 1 桁ずつ残せる）ための最小 `maxWidth`。
 *
 * `ELLIPSIS`(1桁) + 先頭最低 1 桁 + 末尾最低 1 桁 = 3。これを下回ると意味のある中間省略が
 * できないため、{@link truncateMiddle} は末尾省略（`truncateToWidth`）へフォールバックする。
 */
const MIN_WIDTH_FOR_MIDDLE_TRUNCATION = 3

/**
 * 文字列の末尾から、表示幅が `maxWidth` を超えない範囲で最大長の部分文字列を取り出す
 * （{@link ../box-border.js#truncateToWidth} の末尾版）。
 *
 * `truncateToWidth` と対称に、全角文字が半端に収まらない場合はその文字を含めない
 * （表示幅が `maxWidth` を超えないことを優先し、結果的に 1 桁余ることを許容する）。
 *
 * @param str 対象文字列。
 * @param maxWidth 許容する最大表示桁数。
 * @returns 表示幅が `maxWidth` 以下に収まる末尾部分文字列。
 */
function tailByWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return ''
  }
  const chars = Array.from(str)
  let out = ''
  let width = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]
    const codePoint = ch.codePointAt(0)
    const w = codePoint !== undefined && isFullWidthCodePoint(codePoint) ? 2 : 1
    if (width + w > maxWidth) {
      break
    }
    out = ch + out
    width += w
  }
  return out
}

/**
 * `path` が `maxWidth`（表示桁数）を超える場合に、`先頭…末尾` 形式で中間を省略する（FR-04）。
 *
 * 識別性を担う末尾（リポジトリ名・worktree 名等）を優先配分する: 省略記号を除いた残り幅
 * （`contentWidth`）を奇数個に分けるとき、余り 1 桁は末尾側に回す（`tailWidth = ceil(contentWidth/2)`）。
 * 全角文字が半端に収まらない境界では表示幅が `maxWidth` を超えないことを優先し（`box-border.ts` と
 * 同じ流儀）、結果的に 1 桁未満の余りが出ることを許容する。
 *
 * `maxWidth` が極端に小さく（{@link MIN_WIDTH_FOR_MIDDLE_TRUNCATION} 未満）先頭・末尾へ最低 1 桁ずつ
 * 配分できない場合は、中間省略を諦めて {@link ../box-border.js#truncateToWidth} 相当の末尾省略
 * （先頭を残して末尾を切り捨てる）へフォールバックする。
 *
 * @param path 表示したい path（サニタイズ後を想定。本関数自体はサニタイズしない）。
 * @param maxWidth 許容する最大表示桁数。
 * @returns 表示桁数が `maxWidth` 以下に収まる文字列。
 */
export function truncateMiddle(path: string, maxWidth: number): string {
  if (displayWidth(path) <= maxWidth) {
    return path
  }
  if (maxWidth < MIN_WIDTH_FOR_MIDDLE_TRUNCATION) {
    return truncateToWidth(path, maxWidth)
  }

  const contentWidth = maxWidth - displayWidth(ELLIPSIS)
  const tailWidth = Math.ceil(contentWidth / 2)
  const headWidth = contentWidth - tailWidth

  const head = truncateToWidth(path, headWidth)
  const tail = tailByWidth(path, tailWidth)
  return `${head}${ELLIPSIS}${tail}`
}

/**
 * `/Users/<name>/...`（macOS）または `/home/<name>/...`（Linux/WSL2）形式の絶対パスを
 * `~/...` に置換する（FR-04 AC-5）。
 *
 * `<name>` はスラッシュを含まない 1 セグメントとして扱う（`/Users/alice/proj` → `~/proj`、
 * `/home/alice/proj` → `~/proj`、ホーム直下そのもの `/Users/alice` → `~`）。`path` が
 * `/Users/<name>` または `/home/<name>` で始まらない場合はそのまま返す。
 * {@link truncateMiddle} の省略前に適用する想定（末尾のリポジトリ名を極力中間省略の対象から
 * 遠ざけ、識別性を確保するため）。
 *
 * @param path 対象 path（サニタイズ後を想定）。
 * @returns ホームディレクトリ部分を `~` に置換した文字列。
 */
export function collapseHomeDir(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}
