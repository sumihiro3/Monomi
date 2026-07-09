import type { MonomiLocale } from '../config/config.js'

/**
 * `LANG` の値から言語部分を抽出するための区切り文字（`_` = 地域、`.` = エンコーディング）。
 *
 * 例: `ja_JP.UTF-8` → `_` の手前 `ja` を取り出す。
 */
const LANG_DELIMITER_RE = /[_.]/

/**
 * OS ロケール環境変数 `LANG` から Monomi がサポートするロケール（`ja`/`en`）を判定する
 * （release-19 FR-02）。
 *
 * `LANGUAGE`/`LC_ALL`/`LC_MESSAGES` は参照しない（スコープ外。将来検討課題）。
 * `resolvePaths(home?)`（`paths.ts`）と同じ「引数省略時に `process.env` を読む」既定引数
 * パターンを踏襲し、テストから任意の環境を注入できるようにする。
 *
 * @param env 参照する環境変数集合（省略時は `process.env`）。
 * @returns `LANG` の言語部分が `ja`/`en` ならその値、それ以外・未設定・空文字は `undefined`。
 */
export function detectLocaleFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MonomiLocale | undefined {
  const lang = env.LANG
  if (!lang) {
    return undefined
  }
  const language = lang.split(LANG_DELIMITER_RE)[0].toLowerCase()
  if (language === 'ja' || language === 'en') {
    return language
  }
  return undefined
}
