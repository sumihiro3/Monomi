import type { DisplayStatus } from '../domain/enums.js'
import type { DurationMs } from '../domain/time.js'

/**
 * ロールアップ・表示で比較しうる状態。{@link DisplayStatus}（§5.2 の表示 5 状態）に
 * 加えて `CLOSED` を含む。`CLOSED` は §5.1 で非表示扱いだが、ロールアップの際に
 * 「closed セッションが active を覆い隠さない」（§0.5）ことを保証するため、最下位
 * 優先度を持つ状態として比較対象に含める必要がある。`DISPLAY_STATUSES` 列挙自体には
 * `CLOSED` を足さない（enums.test.ts の不変条件を壊さない）。
 */
export type RepresentedStatus = DisplayStatus | 'CLOSED'

/**
 * 表示ステータスの優先順位を数値化した唯一のテーブル（§5.2 / §0.5）。
 *
 * §5.2 の並び「放置 > 権限待ち > PR待ち > 次の指示待ち > 稼働中」を数値の大小で表す。
 * `CLOSED` は表示対象外のため全表示状態より低い 0 に置き、rollup で active を
 * 覆い隠さないようにする。この定数はプロジェクト内でここ一箇所にのみ存在させ、
 * CLI 側（`ClientRollup`）は hub が返す数値を `max()` するだけにする（二重管理の排除）。
 */
export const STATUS_PRIORITY: Record<RepresentedStatus, number> = {
  CLOSED: 0,
  ACTIVE: 1,
  NEXT_WAIT: 2,
  PR_WAIT: 3,
  APPROVAL_WAIT: 4,
  STALE: 5,
}

/**
 * 表示ステータスの優先順位を数値化・比較する値オブジェクト（§5.2 / §5.3）。
 *
 * 優先順位の意味を知る唯一の場所。`StatusDeriver` が `StatusResult.priority` を
 * 埋めるのにも、`InstanceStatusRollup` が代表 session を選ぶのにも用いる。
 */
export class StatusPriority {
  /**
   * 表示ステータスの数値優先度を返す（大きいほど注意を要する）。
   *
   * @param display 表示ステータス（`CLOSED` を含む）。
   * @returns {@link STATUS_PRIORITY} に基づく数値。
   */
  priorityOf(display: RepresentedStatus): number {
    return STATUS_PRIORITY[display]
  }

  /**
   * 2 つの結果のうち優先度の高い方を返す（§5.3 ロールアップの比較単位）。
   *
   * 優先度が等しい場合は「より長く経過している方」（`elapsedMs` が大きい方）を採る。
   * これは同一状態が複数 session で並んだとき、最も待たされている session を代表に
   * 選ぶための決定的なタイブレークで、完全同値なら第 1 引数 `a` を返す。
   *
   * @param a 比較対象。
   * @param b 比較対象。
   * @returns 優先度（同値なら経過時間）の高い方。
   */
  higherOf<T extends { priority: number; elapsedMs: DurationMs }>(a: T, b: T): T {
    if (b.priority > a.priority) return b
    if (a.priority > b.priority) return a
    return b.elapsedMs > a.elapsedMs ? b : a
  }
}
