import type { Instance } from '../../domain/entities.js'
import { epochMsNow, toEpochMs, type EpochMs } from '../../domain/time.js'
import type { Database, PreparedStatement } from '../database.js'
import { newId } from '../id.js'

/** `instances` テーブルの生行。 */
interface InstanceRow {
  id: string
  project_id: string
  device_id: string
  path: string
  branch: string | null
  created_at: number
  removed_at: number | null
}

/** DB 行を {@link Instance} へ写す。 */
function toInstance(row: InstanceRow): Instance {
  return {
    id: row.id,
    projectId: row.project_id,
    deviceId: row.device_id,
    path: row.path,
    branch: row.branch,
    createdAt: toEpochMs(row.created_at),
    removedAt: row.removed_at === null ? null : toEpochMs(row.removed_at),
  }
}

/**
 * `instances` テーブルのアクセサ（§7.1 / §7.3）。
 *
 * `UNIQUE(device_id, path)` により「同一デバイスの同一ディレクトリ = 1 instance」を保証する
 * （worktree の有無で特別扱いしない）。
 */
export class InstanceRepository {
  /** {@link upsert} 用の INSERT（FR-08 AC-2: 呼び出しごとの prepare() を避ける）。 */
  private readonly upsertStmt: PreparedStatement
  /** {@link findById} 用の SELECT。 */
  private readonly findByIdStmt: PreparedStatement
  /** {@link findByDeviceAndPath} 用の SELECT。 */
  private readonly findByDeviceAndPathStmt: PreparedStatement
  /** {@link listActive} 用の SELECT。 */
  private readonly listActiveStmt: PreparedStatement
  /** {@link markRemoved} 用の UPDATE。 */
  private readonly markRemovedStmt: PreparedStatement

  constructor(db: Database) {
    this.upsertStmt = db.prepare(
      `INSERT INTO instances (id, project_id, device_id, path, branch, created_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(device_id, path) DO UPDATE SET
         project_id = excluded.project_id,
         branch = excluded.branch,
         removed_at = NULL`
    )
    this.findByIdStmt = db.prepare('SELECT * FROM instances WHERE id = ?')
    this.findByDeviceAndPathStmt = db.prepare(
      'SELECT * FROM instances WHERE device_id = ? AND path = ?'
    )
    this.listActiveStmt = db.prepare(
      'SELECT * FROM instances WHERE removed_at IS NULL ORDER BY created_at ASC, id ASC'
    )
    this.markRemovedStmt = db.prepare('UPDATE instances SET removed_at = ? WHERE id = ?')
  }

  /**
   * (device_id, path) をキーに instance を冪等に upsert する。
   *
   * クラス図の `upsert(deviceId, path, branch)` に、テーブルが要求する `project_id`
   * （NOT NULL）を加えた形。既存 instance では `branch` / `project_id` を更新し、
   * `removed_at` を NULL に戻して再アクティブ化する（`created_at` は保存）。
   *
   * @param projectId 所属 project の id。
   * @param deviceId レポート送信元 device の id。
   * @param path git toplevel（非 git なら cwd）。
   * @param branch ブランチ名。非 git なら null。
   * @returns 永続化後の {@link Instance}。
   */
  upsert(projectId: string, deviceId: string, path: string, branch: string | null): Instance {
    this.upsertStmt.run(newId('inst'), projectId, deviceId, path, branch, epochMsNow())
    return this.findByDeviceAndPath(deviceId, path)!
  }

  /**
   * id で instance を取得する。
   *
   * @param id instance の主キー。
   * @returns 見つかれば {@link Instance}、無ければ null。
   */
  findById(id: string): Instance | null {
    const row = this.findByIdStmt.get(id) as InstanceRow | undefined
    return row ? toInstance(row) : null
  }

  /**
   * (device_id, path) で instance を取得する（UNIQUE キーによる同一化の確認に使う）。
   *
   * @param deviceId device の id。
   * @param path ディレクトリパス。
   * @returns 見つかれば {@link Instance}、無ければ null。
   */
  findByDeviceAndPath(deviceId: string, path: string): Instance | null {
    const row = this.findByDeviceAndPathStmt.get(deviceId, path) as InstanceRow | undefined
    return row ? toInstance(row) : null
  }

  /**
   * 未削除（`removed_at IS NULL`）の instance を `created_at` 昇順で列挙する。
   *
   * @returns アクティブな {@link Instance} の配列。
   */
  listActive(): Instance[] {
    const rows = this.listActiveStmt.all() as unknown as InstanceRow[]
    return rows.map(toInstance)
  }

  /**
   * instance を論理削除する（`removed_at` を埋める）。
   *
   * `WorktreeRemove` / クリーンアップジョブ用の更新経路（§7.3）。
   *
   * @param id instance の主キー。
   * @param at 削除時刻。省略時は現在時刻。
   */
  markRemoved(id: string, at: EpochMs = epochMsNow()): void {
    this.markRemovedStmt.run(at, id)
  }
}
