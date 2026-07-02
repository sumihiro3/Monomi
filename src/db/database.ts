import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import { DDL } from './ddl.js'

/**
 * `node:sqlite` は experimental のため `module.builtinModules` に `node:` 付きの名前でしか
 * 載っておらず、Vite/vite-node（vitest）の builtin 判定が prefix を剥がした `sqlite` を
 * 解決できずバンドルを試みて失敗する。静的 import を避け `createRequire` で実行時に読み込む
 * ことでバンドラの静的解決を回避する（型は `import type` 側で得る）。
 */
const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite')

/**
 * Monomi が使う SQLite ハンドル型。実装は Node 組込み `node:sqlite` の
 * {@link DatabaseSync}（同期 API）。Repository / UseCase 層はこの別名を通して受け取り、
 * `node:sqlite` への直接依存を各所へ散らさない。
 */
export type Database = DatabaseSync

/**
 * `Database.prepare()` が返す prepared statement の型。
 *
 * Repository 層はコンストラクタでこの型のフィールドをキャッシュし、呼び出しごとの
 * `prepare()`（パース＋プランニングのコスト）をホットパスから排除する（FR-08 AC-2）。
 */
export type PreparedStatement = ReturnType<Database['prepare']>

/**
 * SQLite データベースを開き、電源断耐性の PRAGMA を設定し、§7.3 DDL を冪等適用する。
 *
 * - `journal_mode=WAL` + `synchronous=NORMAL`（§0.5 / FR-03 AC-6: 電源断耐性）。
 * - `foreign_keys=ON`（§7.3 の REFERENCES を実効化しデータモデル不変条件を守る）。
 * - DDL は `CREATE TABLE IF NOT EXISTS` なので、既存 DB に対して再実行しても安全。
 *
 * WAL は永続ファイルでのみ有効になる。`:memory:` DB では `journal_mode` は `memory`
 * のままになるため、WAL の検証は一時ファイルを用いた統合テストで行う。
 *
 * @param location DB ファイルの絶対パス、または `:memory:`。
 * @returns PRAGMA 設定と DDL 適用を終えた {@link Database}。
 */
export function openDatabase(location: string): Database {
  const db = new DatabaseSyncCtor(location)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(DDL)
  return db
}
