import { type EpochMs, toDurationMs } from '../domain/time.js'
import { StatusPriority } from './status-priority.js'
import type { StatusResult } from './status-result.js'

/**
 * session の直近イベントが、同一 instance 内で最も新しい session よりこれ以上古ければ
 * 「孤立 session（stale）」として rollup の代表選定から除外する（release-7 FR-01）。B7:
 * 孤立 session が `next_wait` 等の高優先度を保持したまま、実際に稼働中の別 session を
 * 覆い隠す不具合の対症療法。
 *
 * ライブネス検知（PID 監視・`session_lost`）が未実装（§6）なため、「instance 内で最も新しい
 * イベントからの経過時間」を生存判定の代理指標として使う簡易ヒューリスティック。基準を
 * hub の絶対時刻（`now`）ではなく instance 内の最新イベント時刻からの相対距離にするのは、
 * 長時間のツール実行中で該当 instance 全体に新規イベントが無い場合でも、稼働中 session
 * 自身が誤って stale 扱いされないため（release-7 要件定義「スコープの確定」）。閾値は
 * `EscalationThresholds` のような config 上書きの対象にはしない（release-7 ではスコープ外。
 * `instance-status-service.ts` の `RECENT_EVENTS_LIMIT` 等と同様、呼び出し元に露出しない
 * module 定数として持つ）。
 */
const STALE_SESSION_THRESHOLD_MS = toDurationMs(15 * 60_000)

/**
 * rollup 対象の 1 session 分の入力（class-diagram §5.5 / release-7 FR-01）。
 *
 * `StatusResult` 自体には liveness を持ち込まず（値オブジェクトの純度維持）、
 * 「代表選定に使う直近イベント時刻」は rollup 呼び出し側からこの形で渡す。
 */
export interface RollupEntry {
  /** 該当 session の導出済みステータス。 */
  status: StatusResult
  /** 該当 session の直近イベントの hub 受信時刻（received_at 基準、§0.5）。 */
  lastEventAt: EpochMs
}

/**
 * entries の中で最も新しい `lastEventAt` を返す（`entries` は 1 件以上を呼び出し規約とする）。
 */
function maxLastEventAt(entries: RollupEntry[]): EpochMs {
  return entries.reduce(
    (max, entry) => (entry.lastEventAt > max ? entry.lastEventAt : max),
    entries[0].lastEventAt
  )
}

/**
 * 1 instance 配下の複数 session から代表ステータスを選ぶドメインサービス（§5.3 / §0.5）。
 *
 * 比較は {@link StatusPriority} に委譲し、最も優先度の高い（同値なら最も長く経過している）
 * session を代表にする。`CLOSED` は最下位優先度なので、稼働中など表示対象の session が
 * 1 つでもあれば closed に覆い隠されない（§0.5 のバグ禁止条件）。project レベルの
 * ロールアップは CLI 側の `ClientRollup` が担うため、ここは instance レベルに限定する。
 *
 * release-7 FR-01: 代表選定の前に、instance 内で最も新しい `lastEventAt`（{@link maxLastEventAt}）
 * から {@link STALE_SESSION_THRESHOLD_MS} 以上離れた session（孤立 session）を候補から除外する。
 * 基準が instance 内の最新イベントである以上、その最新イベント自身を持つ session は必ず
 * 候補に残る（距離 0）ため、「候補が 1 件も残らない」ケースは構造的に発生しない——
 * session が 1 件のみのとき、また instance 内の全 session が互いに閾値内に収まっているときは、
 * 除外ロジックの影響を受けない。
 */
export class InstanceStatusRollup {
  private readonly priority = new StatusPriority()

  /**
   * session ごとの結果から instance の代表ステータスを選ぶ。
   *
   * @param entries 同一 instance 配下の各 session の {@link RollupEntry}（1 件以上）。
   * @returns 代表となる {@link StatusResult}。
   * @throws {Error} 空配列の場合（session を持たない instance の rollup は呼び出し規約違反）。
   */
  rollup(entries: RollupEntry[]): StatusResult {
    if (entries.length === 0) {
      throw new Error('InstanceStatusRollup.rollup: cannot roll up an empty session status list')
    }
    const freshest = maxLastEventAt(entries)
    const candidates = entries.filter(
      (entry) => freshest - entry.lastEventAt < STALE_SESSION_THRESHOLD_MS
    )
    return candidates
      .map((entry) => entry.status)
      .reduce((representative, current) => this.priority.higherOf(representative, current))
  }
}
