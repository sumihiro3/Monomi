import type { PrStatus } from '../../domain/entities.js'
import { toEpochMs } from '../../domain/time.js'
import type { Database, PreparedStatement } from '../database.js'

/**
 * 追記/更新する PR 状態。`id` は AUTOINCREMENT で DB が採番するため入力から除く。
 */
export type NewPrStatus = Omit<PrStatus, 'id'>

/** `pr_status` テーブルの生行。 */
interface PrStatusRow {
  id: number
  project_id: string
  branch: string
  pr_number: number | null
  state: string
  url: string | null
  checked_at: number
}

/** DB 行を {@link PrStatus} へ写す。 */
function toPrStatus(row: PrStatusRow): PrStatus {
  return {
    id: row.id,
    projectId: row.project_id,
    branch: row.branch,
    prNumber: row.pr_number,
    state: row.state,
    url: row.url,
    checkedAt: toEpochMs(row.checked_at),
  }
}

/**
 * `pr_status` テーブルのアクセサ（§7.3）。
 *
 * release-1 は GitHub poller 未実装（§0.4 v1延期）のためテーブルは作成されるが行は増えない。
 * 将来 poller を足したときに使えるよう `(project_id, branch)` UNIQUE の upsert を用意しておく。
 */
export class PrStatusRepository {
  /** {@link findByProjectBranch} 用の SELECT（FR-08 AC-2: 呼び出しごとの prepare() を避ける）。 */
  private readonly findByProjectBranchStmt: PreparedStatement
  /** {@link upsert} 用の INSERT。 */
  private readonly upsertStmt: PreparedStatement

  constructor(db: Database) {
    this.findByProjectBranchStmt = db.prepare(
      'SELECT * FROM pr_status WHERE project_id = ? AND branch = ?'
    )
    this.upsertStmt = db.prepare(
      `INSERT INTO pr_status (project_id, branch, pr_number, state, url, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, branch) DO UPDATE SET
         pr_number = excluded.pr_number,
         state = excluded.state,
         url = excluded.url,
         checked_at = excluded.checked_at`
    )
  }

  /**
   * (project_id, branch) で PR 状態を取得する。
   *
   * @param projectId project の id。
   * @param branch ブランチ名。
   * @returns 見つかれば {@link PrStatus}、無ければ null。
   */
  findByProjectBranch(projectId: string, branch: string): PrStatus | null {
    const row = this.findByProjectBranchStmt.get(projectId, branch) as PrStatusRow | undefined
    return row ? toPrStatus(row) : null
  }

  /**
   * (project_id, branch) をキーに PR 状態を冪等に upsert する。
   *
   * @param status `id` を除く PR 状態。
   * @returns 永続化後の {@link PrStatus}。
   */
  upsert(status: NewPrStatus): PrStatus {
    this.upsertStmt.run(
      status.projectId,
      status.branch,
      status.prNumber,
      status.state,
      status.url,
      status.checkedAt
    )
    return this.findByProjectBranch(status.projectId, status.branch)!
  }
}
