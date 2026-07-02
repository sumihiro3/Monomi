import { StatusPriority } from './status-priority.js'
import type { StatusResult } from './status-result.js'

/**
 * 1 instance 配下の複数 session から代表ステータスを選ぶドメインサービス（§5.3 / §0.5）。
 *
 * 比較は {@link StatusPriority} に委譲し、最も優先度の高い（同値なら最も長く経過している）
 * session を代表にする。`CLOSED` は最下位優先度なので、稼働中など表示対象の session が
 * 1 つでもあれば closed に覆い隠されない（§0.5 のバグ禁止条件）。project レベルの
 * ロールアップは CLI 側の `ClientRollup` が担うため、ここは instance レベルに限定する。
 */
export class InstanceStatusRollup {
  private readonly priority = new StatusPriority()

  /**
   * session ごとの結果から instance の代表ステータスを選ぶ。
   *
   * @param sessionStatuses 同一 instance 配下の各 session の {@link StatusResult}（1 件以上）。
   * @returns 代表となる {@link StatusResult}。
   * @throws {Error} 空配列の場合（session を持たない instance の rollup は呼び出し規約違反）。
   */
  rollup(sessionStatuses: StatusResult[]): StatusResult {
    if (sessionStatuses.length === 0) {
      throw new Error('InstanceStatusRollup.rollup: cannot roll up an empty session status list')
    }
    return sessionStatuses.reduce((representative, current) =>
      this.priority.higherOf(representative, current)
    )
  }
}
