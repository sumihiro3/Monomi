#!/usr/bin/env node
/**
 * `monomi` bin の軽量エントリ（release-17-npm-distribution FR-03）。
 *
 * `package.json` の `bin.monomi` はビルド後の `dist/bin.js` を指す。本体（`./cli.js`）は
 * `hub/serve.js` → `db/database.js` 経由で `node:sqlite` を静的 import するため、
 * `engines.node` の下限を満たさない Node で実行すると `node:sqlite` 由来の不可解な
 * スタックトレースで落ちる。ここで Node バージョンを検査し、下限を満たさない場合は
 * 必要バージョン・現在バージョンを明示したメッセージで exit code 1 終了させ、
 * 満たす場合のみ本体を dynamic import して実行する。
 *
 * 最重要の制約: このファイルは対象より古い Node（検査で拒否したい側）でも構文エラーに
 * ならないこと。SyntaxError を投げてしまうと親切なメッセージの代わりに素の
 * `SyntaxError` スタックトレースが出て、この FR の目的そのものが破綻する。
 * - `import` attributes（`with { type: 'json' }`）は使わない → `package.json` は
 *   `fs.readFileSync(new URL(...)) + JSON.parse` で読む（`version.ts` は検査通過後にしか
 *   評価されない別モジュールなので対象外・変更不要）
 * - トップレベル `await` は使わない → 本体処理は async 関数に包んで `.catch()` する
 * - `i18n`（`t()`）には依存しない → config/locale 読み込み前でも安全な固定の日英併記文言
 */
import { readFileSync } from 'node:fs'
import { isNodeVersionSupported } from './node-version-check.js'

/**
 * `node:sqlite` の `ExperimentalWarning` のみを対象にした警告フィルタ。
 *
 * `hub/serve.js` 等が静的 import する `node:sqlite` は `--version`/`--help` を含む全コマンドで
 * `ExperimentalWarning` を stderr に出す。利用者にとって意味のない既知の警告のためこれだけを
 * 抑制する。
 *
 * Node は起動時に自前の既定 `warning` リスナー（stderr への整形出力・`--trace-warnings` 対応）を
 * 既に登録しているため、単に `process.on('warning', ...)` を追加するだけでは既定リスナーも
 * 並行して発火し、抑制したい警告がそのまま出力されてしまう。既定リスナーを取得したうえで
 * 一旦すべて外し、`node:sqlite` の `ExperimentalWarning` だけを弾いて他はすべて既定リスナーへ
 * 委譲する薄いラッパーに差し替える（警告全般を握りつぶさない）。
 */
function suppressSqliteExperimentalWarning(): void {
  const defaultListeners = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
      return
    }
    for (const listener of defaultListeners) {
      listener(warning)
    }
  })
}

/** `package.json` から `engines.node` の下限指定（`>=X.Y.Z` 形式）を読む。 */
function readRequiredNodeRange(): string {
  const packageJsonUrl = new URL('../package.json', import.meta.url)
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8'))
  const range = packageJson?.engines?.node
  if (typeof range !== 'string') {
    throw new Error(
      'package.json is missing "engines.node" / package.json に engines.node がありません'
    )
  }
  return range
}

/**
 * Node バージョン不足時に表示する固定文言（日英併記、i18n 非依存 / AC-2）。
 *
 * @param requiredRange `package.json` の `engines.node`（例: `">=22.5.0"`）。
 * @param currentVersion `process.versions.node`。
 */
function formatUnsupportedNodeMessage(requiredRange: string, currentVersion: string): string {
  return (
    `monomi requires Node.js ${requiredRange} (current: v${currentVersion}). ` +
    'Please upgrade Node.js and try again.\n' +
    `monomi の実行には Node.js ${requiredRange} が必要です（現在のバージョン: v${currentVersion}）。` +
    'Node.js をアップグレードしてから再実行してください。'
  )
}

async function main(): Promise<void> {
  suppressSqliteExperimentalWarning()

  const requiredRange = readRequiredNodeRange()
  const currentVersion = process.versions.node

  if (!isNodeVersionSupported(currentVersion, requiredRange)) {
    console.error(formatUnsupportedNodeMessage(requiredRange, currentVersion))
    process.exitCode = 1
    return
  }

  const { run } = await import('./cli.js')
  const code = await run(process.argv.slice(2))
  process.exitCode = code
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
