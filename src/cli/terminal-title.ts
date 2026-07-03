import { sanitizeDisplayText } from './sanitize-display-text.js'

/**
 * ターミナルのタブ/ウィンドウタイトルの既定値（release-6 FR-09 AC-2・AC-4）。
 *
 * 一覧ビュー表示中・AppView マウント直後はこの値に設定する。
 */
export const DEFAULT_TERMINAL_TITLE = 'Monomi'

/**
 * OSC シーケンスの開始（ESC, コード 27）。生の制御文字をソースへ直接埋め込むと編集時に事故りやすい
 * ため、`sanitize-display-text.test.ts` と同じく `String.fromCharCode` で明示的に組み立てる。
 */
const ESC = String.fromCharCode(27)

/** OSC シーケンスの終端（BEL、コード 7）。ST（`ESC` + `\`）より対応端末が広い慣用形式。 */
const BEL = String.fromCharCode(7)

/**
 * OSC エスケープシーケンスでターミナルのタブ/ウィンドウタイトルを設定する（release-6 FR-09）。
 *
 * Ink の描画領域は通常のスクロールバック内にあり「常に画面上部に固定されるペイン」を
 * 持てないため、Ink の描画とは別経路（ターミナルのタブ/ウィンドウタイトル）でプロジェクト名を
 * 常時可視にする（AC-1）。OSC 0（アイコン名＋ウィンドウタイトルの両方を設定する制御シーケンス、
 * `ESC` + `]0;` + タイトル本文 + `BEL`）を書き込む。
 *
 * `title` はレポーター由来の自由記述（project 名・device 名）を含み得るため、描画前と同じ
 * `sanitize-display-text.ts` の {@link sanitizeDisplayText} で ANSI エスケープ・制御文字を除去する
 * （素通しすると OSC シーケンスの注入や端末の誤動作を招きうる、`detail-view.tsx` のイベント行と
 * 同じ脅威モデル）。タイトルは 1 行である前提のため、改行・タブは半角スペースに潰す
 * （`sanitizeDisplayText` は改行・タブをそのまま通すため、ここで追加対応する）。
 *
 * 本関数自体は非TTY環境（パイプ実行等）に書き込んでも安全（無視されるバイト列になるだけ）だが、
 * 呼び出し側（`app-view.tsx`）は `stdout.isTTY` のときのみ呼ぶ判断をしている（review-changes 修正:
 * 詳細は `app-view.tsx` の該当コメントを参照。非TTY時に Ink 自身が「非 interactive」として通常の
 * 再描画フレームと本 OSC 書き込みを無調整で同じストリームへ素通しするため、両者を区別できない
 * 下流の消費者からは直前の実フレームが上書きされたように見えてしまう）。
 *
 * @param stdout タイトルシーケンスの書き込み先（`useStdout().stdout` 相当の生の `WriteStream`。
 *   Ink の `useStdout()` が返す `write`（`<Static>` 相当の行追加 API）ではなく、生の stream へ
 *   直接書く。OSC は可視文字も改行も生成しないため、Ink の `log-update` による再描画（前回フレーム
 *   の行数分だけ消去して上書きする方式）の行数カウントを乱さない）。
 * @param title 設定したいタイトル本文（サニタイズ前）。
 */
export function setTerminalTitle(stdout: NodeJS.WritableStream, title: string): void {
  const safe = sanitizeDisplayText(title).replace(/[\n\t]/g, ' ')
  stdout.write(`${ESC}]0;${safe}${BEL}`)
}
