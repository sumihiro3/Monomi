import type { LOCALES, MonomiLocale } from '../config/config.js'
import { EN, type TranslationKey } from './en.js'
import { JA } from './ja.js'

export type { TranslationKey } from './en.js'

/**
 * CLI 表示文言の唯一の解決入口（release-9-i18n FR-01）。
 *
 * `status-display.ts` が全コンポーネントから使われる純粋モジュール関数である既存規約に合わせ、
 * アクティブロケールは React context ではなく「起動時に一度だけ `setActiveLocale` する
 * モジュールレベル・シングルトン」で持つ（{@link setActiveLocale}/{@link getActiveLocale}）。
 *
 * @remarks 重要な落とし穴
 * `t()` を `USAGE`/`HELP_LINES` のようなモジュールスコープの const 初期化から呼んではいけない。
 * モジュールの const 初期化は import 時（= プロセス起動時の最初の import 解決）に 1 度だけ走るため、
 * その時点のアクティブロケール（常に既定の `en`。{@link setActiveLocale} は CLI 起動処理の中で
 * import 後に呼ばれる）で文言が凍結され、以後 `setActiveLocale('ja')` してももう反映されない。
 * `t()` の呼び出しは必ず関数内・描画時（コンポーネント本体、ハンドラ内など毎回評価される場所）に
 * 置くこと。
 */

/** ロケール別テーブル。`LOCALES`（config.ts が所有する対応ロケール集合）をキー型の基準にする。 */
const TABLES: Record<(typeof LOCALES)[number], Partial<Record<TranslationKey, string>>> = {
  en: EN,
  ja: JA,
}

/** アクティブロケール。既定 `en`。{@link setActiveLocale} 以外から書き換えない。 */
let active: MonomiLocale = 'en'

/**
 * アクティブロケールを設定する。CLI 起動時に一度だけ呼ぶ（§実装方針: モジュールレベル・
 * シングルトン。React context は使わない）。
 *
 * @param locale 以後 {@link t} が参照するロケール。
 */
export function setActiveLocale(locale: MonomiLocale): void {
  active = locale
}

/**
 * 現在のアクティブロケールを返す。主にテストや診断用。
 *
 * @returns {@link setActiveLocale} で設定された値（既定 `en`）。
 */
export function getActiveLocale(): MonomiLocale {
  return active
}

/**
 * `config.locale`（未設定なら `undefined`）から実際に使うロケールを解決する（FR-01 AC-2）。
 *
 * 既定解決をここに集約することで、config 側は「未設定時 `undefined` のまま通す」だけでよく
 * （`config.ts` 側のコメント参照）、"既定は en" という決定はこの 1 箇所にしか存在しない。
 *
 * @param locale `MonomiConfig.locale`。省略/`undefined` なら `en`。
 * @returns 解決済みロケール。
 */
export function resolveLocale(locale?: MonomiLocale): MonomiLocale {
  return locale ?? 'en'
}

/**
 * 指定テーブルから 1 キー分の文言を引く境界関数（FR-01 AC-5 のテストシーム）。
 *
 * テーブルにキーが無ければ（不完全な部分テーブル、または将来ロケール追加時の未翻訳キー）
 * `EN`（authoritative）の値へフォールバックする。
 *
 * @param table ロケール別テーブル（部分的でもよい）。
 * @param key 翻訳キー。
 * @returns テーブルの値、無ければ `EN[key]`。
 */
export function translate(
  table: Partial<Record<TranslationKey, string>>,
  key: TranslationKey
): string {
  return table[key] ?? EN[key]
}

/**
 * `{var}` プレースホルダーを置換する。
 *
 * @param template `t()` が解決したテンプレート文字列。
 * @param vars 置換値。省略時はテンプレートをそのまま返す。
 * @returns 置換後の文字列。`vars` に対応するキーが無いプレースホルダーはそのまま残す。
 */
function applyVars(template: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) {
    return template
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match
  )
}

/**
 * 翻訳キーを現在のアクティブロケールの文言へ解決する（release-9-i18n FR-01 の唯一の入口）。
 *
 * アクティブロケールのテーブルにキーが無ければ `en` へフォールバックする（AC-5）。
 * `{var}` プレースホルダーは `vars` の同名キーで置換する。
 *
 * @param key 翻訳キー（{@link TranslationKey}）。
 * @param vars `{var}` プレースホルダーの置換値（省略可）。
 * @returns 解決済みの表示文言。
 *
 * @remarks
 * モジュールスコープの const 初期化から呼ばない（このファイル冒頭の remarks 参照）。
 * 必ず関数内・描画時に評価すること。
 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = translate(TABLES[active], key)
  return applyVars(template, vars)
}
