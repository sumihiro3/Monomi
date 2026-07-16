/**
 * AppleScript 文字列リテラルへ安全に埋め込むためのエスケープ・組み立て純粋関数
 * （release-23 FR-04a。三段防御の第二段: focus-target 検証 → 本モジュールのエスケープ →
 * `osascript.ts` の execFile 非 shell 実行）。
 *
 * `terminal-app-strategy.ts`・`ghostty-strategy.ts`（FR-04b 以降）は、TTY や OSC タイトルタグ
 * など reporter 由来の値を AppleScript ソースへ埋め込む際に必ず本モジュール経由でエスケープする。
 * `sanitize-display-text.ts` と同じく副作用を持たない純粋関数として提供し、境界値を単体テストで
 * 直接検証できるようにする。
 */

const BACKSLASH_PATTERN = /\\/g
const DOUBLE_QUOTE_PATTERN = /"/g

/**
 * AppleScript の二重引用符文字列リテラルへ埋め込めるよう `\` と `"` をエスケープする。
 *
 * 順序が重要: 先に `\` を `\\` へエスケープしてから `"` を `\"` へエスケープする。
 * 逆順にすると、`"` のエスケープで生成した `\` がその後の `\` エスケープで再エスケープされ
 * 二重エスケープになってしまう。
 *
 * @param value 埋め込み対象の生文字列（reporter 由来。信頼しない）。
 * @returns エスケープ済み文字列（引用符自体は含まない。呼び出し側で `"`...`"` として囲む）。
 */
export function escapeAppleScriptString(value: string): string {
  return value.replace(BACKSLASH_PATTERN, '\\\\').replace(DOUBLE_QUOTE_PATTERN, '\\"')
}

/**
 * 生文字列を、エスケープ込みで AppleScript の二重引用符文字列リテラルへ変換する。
 *
 * strategy 実装がスクリプトテンプレートへ値を埋め込む際の唯一の経路として使う想定
 * （生の `"${value}"` テンプレートリテラル埋め込みを禁止し、必ずここを通す）。
 *
 * @param value 埋め込み対象の生文字列。
 * @returns `"..."` 形式の AppleScript 文字列リテラル（そのままスクリプトへ埋め込める）。
 */
export function quoteAppleScriptString(value: string): string {
  return `"${escapeAppleScriptString(value)}"`
}
