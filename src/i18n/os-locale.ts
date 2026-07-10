import { execFileSync } from 'node:child_process'
import type { MonomiLocale } from '../config/config.js'

/**
 * ロケール文字列から言語部分を抽出するための区切り文字（`_` = 地域、`.` = エンコーディング、`@` = 修飾子）。
 *
 * 例: `ja_JP.UTF-8` → `_` の手前 `ja` を取り出す。`ja@calendar=japanese` → `@` の手前 `ja` を取り出す。
 * `LANG`（POSIX 形式）・`AppleLocale`（`ja_JP` 形式）のいずれの抽出にも共用する。
 */
const LANG_DELIMITER_RE = /[_.@]/

/**
 * ロケール文字列（`LANG` の値・`AppleLocale` の値のいずれも想定）の言語部分を、
 * Monomi がサポートするロケール（`ja`/`en`）へ判定する共通ヘルパー。
 *
 * @param raw ロケール文字列（例: `ja_JP.UTF-8`、`ja_JP`）。
 * @returns 言語部分が `ja`/`en` ならその値、それ以外は `undefined`。
 */
function languageSubtagOf(raw: string): MonomiLocale | undefined {
  const language = raw.split(LANG_DELIMITER_RE)[0].toLowerCase()
  return language === 'ja' || language === 'en' ? language : undefined
}

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
  return lang ? languageSubtagOf(lang) : undefined
}

/**
 * `defaults read -g AppleLocale` で macOS のシステム言語設定（Language & Region）を読む。
 *
 * macOS では `LANG` がシステム言語設定と連動する保証がない（ターミナルアプリの設定や
 * シェルプロファイルに依存し、システム言語が日本語でも `LANG` が `en_US.UTF-8` のまま
 * 古くなっているケースが実機で確認されている）。`AppleLocale` は macOS が実際に UI 言語
 * として使う値のため、こちらを権威とする。
 *
 * `defaults` コマンド不在・キー未設定・非 macOS 環境などで失敗した場合は `undefined` を返す
 * （呼び出し側で `LANG` へのフォールバックに委ねる）。
 *
 * @returns `AppleLocale` の生の値（例: `ja_JP`）、取得できなければ `undefined`。
 */
function readAppleLocale(): string | undefined {
  try {
    const raw = execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return raw.length > 0 ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * macOS のシステム言語設定（`AppleLocale`）から Monomi がサポートするロケール（`ja`/`en`）を
 * 判定する（release-19 FR-02 修正: `LANG` のみでは macOS の実際のシステム言語設定を反映しない
 * ケースがあるため追加）。
 *
 * `platform !== 'darwin'` の場合は `readLocale` を呼ばず即座に `undefined` を返す（非 macOS
 * 環境・CI（ubuntu-latest）で `defaults` コマンド不在によるエラーを避けるため）。
 *
 * @param platform 判定対象の OS（省略時は `process.platform`）。
 * @param readLocale `AppleLocale` の生の値を読む関数（省略時は実際に `defaults` を呼ぶ実装。
 *   テストから任意の戻り値を注入できるようにするための差し替え口）。
 * @returns 言語部分が `ja`/`en` ならその値、非 macOS・未取得・非対応言語は `undefined`。
 */
export function detectMacOsLocale(
  platform: NodeJS.Platform = process.platform,
  readLocale: () => string | undefined = readAppleLocale
): MonomiLocale | undefined {
  if (platform !== 'darwin') {
    return undefined
  }
  const raw = readLocale()
  return raw ? languageSubtagOf(raw) : undefined
}

/**
 * OS 由来のロケール判定を束ねる（release-19 FR-02 修正）。macOS では `AppleLocale`（システムの
 * 実際の言語設定）を `LANG` より優先し、`AppleLocale` で判定できない場合のみ `LANG` へフォール
 * バックする。非 macOS（Linux/WSL2）では `LANG` のみを見る（`resolveLocale` からはこの関数の
 * 戻り値を「OS 判定」として渡す。config.yml の明示設定はこれより常に優先される）。
 *
 * @param env `LANG` を読む環境変数集合（省略時は `process.env`）。
 * @param platform 判定対象の OS（省略時は `process.platform`）。
 * @param readLocale `AppleLocale` の生の値を読む関数（省略時は実際に `defaults` を呼ぶ実装）。
 * @returns 判定できたロケール（`ja`/`en`）、できなければ `undefined`。
 */
export function detectOsLocale(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readLocale: () => string | undefined = readAppleLocale
): MonomiLocale | undefined {
  return detectMacOsLocale(platform, readLocale) ?? detectLocaleFromEnv(env)
}
