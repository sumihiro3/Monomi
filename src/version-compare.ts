/**
 * 自版（`MONOMI_VERSION`）と他方のバージョン文字列を比較するユーティリティ
 * （release-25-auto-update 版比較基盤）。
 *
 * FR-02（hub 自動再起動）・FR-03（reporter 版マーカー照合）・FR-04（child のリモート hub 版ずれ可視化）が
 * 共通で使う版比較の単一ソース。比較そのものは `src/node-version-check.ts` の
 * `parseVersionTriple`/`compareVersionTriples`（major.minor.patch の数値比較、外部依存なし）を再利用し、
 * その上に「自版との4値比較」を薄くラップする。semver パッケージを追加しないのは
 * `docs/releases/release-25-auto-update/requirements.md` の未解決事項の決定どおり
 * （プレリリースタグは配布運用上使わない前提）。
 *
 * 「パース不能 = 版不明 = 旧版」というポリシーはこのモジュール1箇所に集約する。呼び出し側は
 * `'unknown'` を `'older'` と同じ更新経路（自動更新・上書き対象）に載せること。
 */

import { compareVersionTriples, parseVersionTriple } from './node-version-check.js'
import { MONOMI_VERSION } from './version.js'

/**
 * 自版に対する他方バージョンの相対関係。
 *
 * - `'older'`: 他方が自版より古い
 * - `'same'`: 他方が自版と同一
 * - `'newer'`: 他方が自版より新しい
 * - `'unknown'`: 他方が undefined・空文字列・パース不能（呼び出し側は `'older'` と同一に扱う）
 */
export type VersionComparison = 'older' | 'same' | 'newer' | 'unknown'

/**
 * 他方のバージョン文字列を自版（既定は `MONOMI_VERSION`）と比較する。
 *
 * 版不明（`other` が undefined・空文字列・パース不能）の場合は `'unknown'` を返す。
 * これは呼び出し側が「版不明 = 旧版」として `'older'` と同じ更新経路に載せるための設計であり
 * （hub がバージョンヘッダを公開しない旧ビルド・reporter に版マーカーが無い旧配置は、
 * 定義上すべて本リリース以前のビルドのため）、本関数自体は `'unknown'` と `'older'` を
 * 区別したまま返す（経路の合流判断は呼び出し側の責務）。
 *
 * `self` がパース不能な場合も同様に `'unknown'` を返す（既定値の `MONOMI_VERSION` は
 * `package.json` 由来の正しい semver なので通常到達しないが、テストでの上書き時の防御）。
 *
 * @param other 比較対象のバージョン文字列（例: hub のレスポンスヘッダ値、reporter のマーカー値）。
 * @param self 自版のバージョン文字列。既定は `MONOMI_VERSION`。テストで上書き可能。
 * @returns `other` の `self` に対する相対関係。
 */
export function compareVersion(
  other: string | undefined,
  self: string = MONOMI_VERSION
): VersionComparison {
  if (!other) {
    return 'unknown'
  }
  const otherTriple = parseVersionTriple(other)
  if (!otherTriple) {
    return 'unknown'
  }
  const selfTriple = parseVersionTriple(self)
  if (!selfTriple) {
    return 'unknown'
  }
  const diff = compareVersionTriples(otherTriple, selfTriple)
  if (diff < 0) {
    return 'older'
  }
  if (diff > 0) {
    return 'newer'
  }
  return 'same'
}
