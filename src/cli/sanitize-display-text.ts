/**
 * レポーター由来の自由記述文字列を端末描画前にサニタイズする純粋関数
 * （review-changes 修正: CWE-150 制御文字/ANSIエスケープ注入）。
 *
 * `tool_summary`・`tool_name`・`event_subtype`・`path`・`branch`・`session_id` 等は hub の
 * ingestion（`src/hub/dto.ts` の `rawEventPayloadSchema`）で `z.string()` の型検証のみを受け、
 * 内容のサニタイズは行われない。これらはレポート元マシンの利用者が（意図せず、または悪意を
 * 持って）制御しうる自由記述（ファイルパス・git branch名・コマンド先頭の切り詰め等）であり、
 * ここに ESC/CSI/OSC 等の ANSI エスケープシーケンスや C0/C1 制御文字が含まれると、Ink はそれを
 * 除去せず端末へそのまま書き出す。結果、ダッシュボードを開いた運用者の端末で画面消去・カーソル
 * 移動・ウィンドウタイトル書き換え等が実行され得る。
 *
 * 外部依存（strip-ansi 等）を追加せず、正規表現で ANSI エスケープシーケンス全般と
 * 改行・タブ以外の制御文字を除去する。`box-border.ts`・`event-scroll.ts` と同じく
 * React に依存しない純粋関数として提供し、単体テストで境界値を直接検証できる。
 */

/**
 * ANSI エスケープシーケンス（CSI・OSC・DCS/SOS/PM/APC・その他の2バイトFe系）にマッチする。
 *
 * OSC/DCS 系は BEL（コード 7）または ST（ESC \）で終端されるものを対象にする。
 * コードポイントは `\\uXXXX` 形式の文字列でのみ組み立て、生の制御文字はソースへ埋め込まない。
 */
const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    '\\u001b\\[[0-?]*[ -/]*[@-~]', // CSI（画面消去・カーソル移動・SGR色等）
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', // OSC（ウィンドウタイトル書換・クリップボード操作等）
    '\\u001b[PX^_][^\\u001b]*\\u001b\\\\', // DCS/SOS/PM/APC
    '\\u001b[@-Z\\\\-_]', // その他の2バイトエスケープ（Fe set）
  ].join('|'),
  'g'
)

/**
 * 改行(LF)・タブ以外の C0 制御文字（ESC含む）と C1 制御文字。
 *
 * 本モジュールの目的そのものが制御文字の除去であるため、意図的に制御文字を含む文字クラスを使う。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の除去が本モジュールの目的そのもの
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * 端末描画前に ANSI エスケープシーケンスと制御文字を除去する。
 *
 * 改行・タブはそのまま通す（複数行での見た目や既存のフィールド整形を壊さないため）。
 *
 * @param value レポーター由来の自由記述文字列。
 * @returns サニタイズ済み文字列。
 */
export function sanitizeDisplayText(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '').replace(CONTROL_CHAR_PATTERN, '')
}

/**
 * `null` 許容版（`path`・`branch`・`tool_name` 等 null になり得るフィールド用）。
 *
 * @param value レポーター由来の自由記述文字列。`null` ならそのまま返す。
 * @returns サニタイズ済み文字列、または `null`。
 */
export function sanitizeNullableDisplayText(value: string | null): string | null {
  return value === null ? null : sanitizeDisplayText(value)
}
