import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `tsc` はテストファイル（`*.test.ts`）も含めて `src/**` 全体を型チェックするため、
 * ビルド後の `dist/` には `*.test.js` / `*.test.d.ts` / `*.test.js.map` が混入する。
 *
 * FR-01（npm パッケージング）の受け入れ基準は npm pack にテストファイルを含めないことなので、
 * `tsc` の型チェック対象は変えず（テストの型エラーを CI で検出し続けるため）、
 * ビルドの後処理として dist から `*.test.*` のみを削除する。
 */

const DIST_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')

/** dist 配下の `*.test.*` ファイルパスを再帰的に列挙する。 */
function collectTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const results = []
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(entryPath))
    } else if (/\.test\.(js|d\.ts|js\.map)$/.test(entry.name)) {
      results.push(entryPath)
    }
  }
  return results
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`dist ディレクトリが見つかりません: ${DIST_DIR}`)
    process.exit(1)
  }

  const testFiles = collectTestFiles(DIST_DIR)
  for (const filePath of testFiles) {
    fs.rmSync(filePath)
  }

  console.log(`dist からテストファイルを ${testFiles.length} 件削除しました。`)
}

main()
