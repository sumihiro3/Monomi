/**
 * OSC 8 ハイパーリンクエスケープシーケンスの生成モジュール（release-27 FR-05b）。
 *
 * `detail-view.tsx` で PR 番号をクリッカブルにするために使う。`terminal-title.ts`・
 * `ghostty-strategy.ts` と同じ組み立て方（生の制御文字をソースへ直接埋め込むと編集時に事故りやすい
 * ため `String.fromCharCode` で名前付き定数として組み立てる）を踏襲する。
 *
 * PR URL は hub 側（`gh` CLI の応答）由来の値であり、想定外のホスト・形式が紛れ込む余地がある
 * ため、`https://github.com/owner/repo/pull/<number>` 形式であることを検証してからのみ OSC 8
 * シーケンスへ埋め込む（AC-2）。検証を通らない場合はエスケープを生成せず、表示テキストのみの
 * プレーンテキストへフォールバックする。
 *
 * 単なる接頭辞一致（`startsWith('https://github.com/')`）だけでは不十分（review-changes 修正:
 * medium severity 所見）。`https://github.com/x\x07\x1b]...` のような値も接頭辞は一致するが、
 * BEL（0x07）が OSC 8 シーケンスを途中終端させ、後続をターミナルエスケープとして注入できてしまう
 * ため、`URL` でパースしたうえでホスト・スキーム・資格情報・制御文字・パス形式を検証する。
 */

/** OSC シーケンスの開始（ESC、コード 27）。 */
const ESC = String.fromCharCode(27)

/** OSC シーケンスの終端（BEL、コード 7）。 */
const BEL = String.fromCharCode(7)

/** GitHub PR URL のパス形式（`/owner/repo/pull/<正の整数>`）。 */
const GITHUB_PR_PATH_RE = /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/

/**
 * ASCII 制御文字（C0: 0x00-0x1F、DEL: 0x7F）を含むかどうか。
 *
 * OSC 8 シーケンスは BEL（0x07）または ESC（0x1B）で終端されるため、埋め込む URL 自体に
 * これらが含まれると意図しない位置でシーケンスが終端し、後続をエスケープとして注入できてしまう。
 * `URL` は多くの制御文字を percent-encode せず、または解析後の文字列にのみ反映するため、
 * 埋め込みに使う生の入力文字列そのものを検査する必要がある。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的そのもの
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

/**
 * `url` が OSC 8 ハイパーリンクへ埋め込んで安全な形式かを判定する純粋関数
 * （`sanitize-display-text.ts` と同様、単体テストしやすい独立関数として切り出す）。
 *
 * `https://github.com/` の接頭辞一致だけでなく、`URL` でパースしたうえで
 * スキーム（`https:`）・ホスト（`github.com` 完全一致）・資格情報なし・
 * `/owner/repo/pull/<number>` 形式のパスであることを検証し、さらに元の文字列全体に
 * ASCII 制御文字が含まれないことを確認する。
 *
 * @param url 検証対象の URL（`gh` CLI 応答由来、`null` もあり得る）。
 * @returns 上記すべてを満たせば true。
 */
export function isLinkableGithubUrl(url: string | null): url is string {
  if (typeof url !== 'string' || CONTROL_CHAR_RE.test(url)) {
    return false
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    return false
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false
  }
  return GITHUB_PR_PATH_RE.test(parsed.pathname)
}

/**
 * PR 番号等の `text` を OSC 8 ハイパーリンクでラップする（対応端末でクリック可能にする）。
 *
 * `url` が {@link isLinkableGithubUrl} を通らない場合は、エスケープシーケンスを一切生成せず
 * `text` をそのまま返す（プレーンテキストフォールバック、AC-2・AC-3）。
 *
 * @param text リンクとして表示する本文（例 `#123`）。
 * @param url リンク先 URL（`null` 可）。
 * @returns 対応端末でクリック可能な OSC 8 シーケンス、または（フォールバック時）`text` そのまま。
 */
export function toOsc8Hyperlink(text: string, url: string | null): string {
  if (!isLinkableGithubUrl(url)) {
    return text
  }
  return `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`
}
