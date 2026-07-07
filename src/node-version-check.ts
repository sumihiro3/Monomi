/**
 * Node.js バージョン検査の純粋関数（release-17-npm-distribution FR-03）。
 *
 * `src/bin.ts`（起動時検査の軽量エントリ）から使われる。`bin.ts` は対象より古い Node でも
 * `SyntaxError` にならないことが最重要のため、このモジュール自体も保守的な構文
 * （分割代入・アロー関数・正規表現程度に留め、`import` attributes・トップレベル `await`・
 * 最近追加された組み込み API は使わない）で書く。
 *
 * 比較ロジックを `src/bin.ts` から切り出しているのは、`bin.ts` は `process.exit` 相当の
 * 副作用・`console.error` 出力を持ち unit test しづらいため、比較そのものを副作用ゼロの
 * pure function として独立させて境界値（下限未満・境界値・下限以上）を直接検証できるようにするため
 * （AC-1）。
 */

/** メジャー・マイナー・パッチの3要素バージョン。 */
export type VersionTriple = readonly [number, number, number]

/**
 * `X.Y.Z` 形式（先頭に付く `v` や、末尾のプレリリース/ビルドメタデータは無視）の文字列から
 * メジャー・マイナー・パッチを取り出す。
 *
 * @param version 例: `process.versions.node`（`"22.5.0"`）や `"v20.10.1"`。
 * @returns 解析できた `[major, minor, patch]`。解析できない場合は `null`。
 */
export function parseVersionTriple(version: string): VersionTriple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * `package.json` の `engines.node` に書く `>=X.Y.Z` 形式の下限指定から、下限バージョンを取り出す。
 *
 * `>=` 以外の演算子（`^`・`~`・範囲指定等）は本プロジェクトでは使わない前提のため対象外とし、
 * 解析できない場合は `null` を返す（呼び出し側で「検査そのものを実行できない」扱いにする）。
 *
 * @param range `package.json` の `engines.node` の値（例: `">=22.5.0"`）。
 * @returns 解析できた下限の `[major, minor, patch]`。解析できない場合は `null`。
 */
export function parseMinimumNodeRange(range: string): VersionTriple | null {
  const trimmed = range.trim()
  if (!trimmed.startsWith('>=')) {
    return null
  }
  return parseVersionTriple(trimmed.slice(2))
}

/**
 * 2つの `VersionTriple` をメジャー→マイナー→パッチの順で比較する。
 *
 * @returns `a` が `b` より大きければ正の数、小さければ負の数、等しければ 0。
 */
export function compareVersionTriples(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] - b[i]
    }
  }
  return 0
}

/**
 * 現在の Node バージョンが `engines.node` の下限（`>=X.Y.Z`）を満たすかを判定する（AC-1）。
 *
 * 下限（`minimumRange`）・現在値（`currentVersion`）のいずれかが解析できない場合は、
 * 検査そのものを無効化せず安全側（`false` = 未対応扱い）に倒す。
 *
 * @param currentVersion `process.versions.node` 相当の文字列。
 * @param minimumRange `package.json` の `engines.node`（`>=X.Y.Z` 形式）。
 * @returns 下限を満たしていれば `true`。
 */
export function isNodeVersionSupported(currentVersion: string, minimumRange: string): boolean {
  const current = parseVersionTriple(currentVersion)
  const minimum = parseMinimumNodeRange(minimumRange)
  if (!current || !minimum) {
    return false
  }
  return compareVersionTriples(current, minimum) >= 0
}
