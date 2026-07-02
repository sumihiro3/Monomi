import type { Project, ProjectKey } from '../../domain/entities.js'
import { inferProjectKeyKind } from '../../domain/project-key.js'
import { epochMsNow, toEpochMs } from '../../domain/time.js'
import type { Database } from '../database.js'
import { newId } from '../id.js'

/** `projects` テーブルの生行。`project_key` は正規化済み value のみで kind 列は無い。 */
interface ProjectRow {
  id: string
  project_key: string
  display_name: string | null
  created_at: number
}

/** DB 行を {@link Project} へ写す。kind は value 接頭辞から復元する（§0.1）。 */
function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    projectKey: { value: row.project_key, kind: inferProjectKeyKind(row.project_key) },
    displayName: row.display_name,
    createdAt: toEpochMs(row.created_at),
  }
}

/**
 * `projects` テーブルのアクセサ（§7.3）。
 *
 * `project_key` の UNIQUE 制約が、同一リポジトリの SSH/HTTPS 表記ゆれを 1 行へ収束させる
 * 構造的保証になる（正規化自体は hub 側の {@link ../../domain/project-key-normalizer.js} が担う）。
 */
export class ProjectRepository {
  constructor(private readonly db: Database) {}

  /**
   * `project_key` で既存 project を探し、無ければ作成する（§8.1 初出自動登録の冪等性）。
   *
   * `ON CONFLICT(project_key) DO NOTHING` により、同一キーの並行 insert でも行は 1 つに
   * 保たれる。採番した id は衝突時に捨てられ、返るのは常に既存行になる。
   *
   * @param key 正規化済みの {@link ProjectKey}。
   * @returns 既存または新規作成された {@link Project}。
   */
  findOrCreateByKey(key: ProjectKey): Project {
    this.db
      .prepare(
        `INSERT INTO projects (id, project_key, display_name, created_at)
         VALUES (?, ?, NULL, ?)
         ON CONFLICT(project_key) DO NOTHING`
      )
      .run(newId('proj'), key.value, epochMsNow())
    return this.findByKey(key.value)!
  }

  /**
   * id で project を取得する。
   *
   * @param id project の主キー。
   * @returns 見つかれば {@link Project}、無ければ null。
   */
  findById(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      ProjectRow | undefined
    return row ? toProject(row) : null
  }

  /**
   * 正規化済み `project_key`（value）で project を取得する。
   *
   * @param key 正規化済み value 文字列。
   * @returns 見つかれば {@link Project}、無ければ null。
   */
  findByKey(key: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_key = ?').get(key) as
      ProjectRow | undefined
    return row ? toProject(row) : null
  }
}
