import type { InstanceStatusRow } from '../hub/dto.js'

/**
 * project 単位に畳み込んだ 1 行（§5.3 の project ロールアップ、CLI 側の関心事）。
 */
export interface ProjectRow {
  /** project の id。 */
  projectId: string
  /** 表示名（配下 instance のいずれかから採る。同一 project なら同じ値）。 */
  projectName: string
  /** 配下 instance の `status.priority` の最大値（§0.5: hub の数値を `max()` するだけ）。 */
  priority: number
  /** 最大優先度を与えた instance の表示状態（描画用。優先順位の意味は解釈しない）。 */
  topDisplay: string
  /** 配下 instance 数。 */
  instanceCount: number
}

/**
 * hub が返す instance 行を project 単位へ畳み込むユーティリティ（class-diagram §4 / §5.3）。
 *
 * §0.5 に従い、代表優先度は hub が各 instance に付けた `status.priority`（数値）を
 * `max()` するだけで求める。優先順位の**意味**（どの状態が上か）は一切解釈せず、
 * 定数を CLI 側に二重に持たない。並び替えや意味付けは行わない（§10.3 の sort は release-1 対象外）。
 */
export class ClientRollup {
  /**
   * instance 行を project ごとにまとめ、代表優先度（`max`）付きの行を返す。
   *
   * 入力順を尊重し、各 project の初出順に結果を並べる（安定した表示のため）。
   *
   * @param instances hub から取得した instance 行。
   * @returns project ごとの {@link ProjectRow}。
   */
  rollupByProject(instances: InstanceStatusRow[]): ProjectRow[] {
    const byProject = new Map<string, ProjectRow>()
    for (const instance of instances) {
      const existing = byProject.get(instance.project.id)
      if (existing === undefined) {
        byProject.set(instance.project.id, {
          projectId: instance.project.id,
          projectName: instance.project.name,
          priority: instance.status.priority,
          topDisplay: instance.status.display,
          instanceCount: 1,
        })
        continue
      }
      existing.instanceCount += 1
      if (instance.status.priority > existing.priority) {
        existing.priority = instance.status.priority
        existing.topDisplay = instance.status.display
      }
    }
    return [...byProject.values()]
  }
}
