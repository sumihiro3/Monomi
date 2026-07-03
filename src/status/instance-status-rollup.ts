import type { EpochMs } from '../domain/time.js'
import { StatusPriority } from './status-priority.js'
import type { StatusResult } from './status-result.js'

/**
 * release-8 FR-02: 孤立 session 除外ロジック（release-7 STALE_SESSION_THRESHOLD_MS）を削除。
 * 最も新しい `lastEventAt` を無条件に代表とする recency 優先化を採用（AC-1・AC-2）。
 * これにより session 再開時の「新しい session が古い状態に覆い隠される」バグ（B8）を解決する
 * （具体例: 15分以内に再開し新 session_id が払い出されても、古い session が 15分閾値内なら
 * 古い状態が優先されていた）。
 *
 * ライブネス検知（PID 監視・`session_lost`）が未実装（§6）なため、最新イベント時刻（`lastEventAt`）
 * による「鮮度優先」判定へ全面移行する。完全同一 `lastEventAt` の場合のみ {@link StatusPriority}
 * でタイブレークする（AC-2）が、ms 精度のため実運用ではほぼ発生しない。
 */

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
 * **release-8 FR-02 recency 優先化**：`CLOSED` 以外（live）の session の中で、最も新しい
 * `lastEventAt` を持つ session を無条件に代表とする（AC-1）。複数の live session が同一
 * `lastEventAt` を持つ場合のみ {@link StatusPriority} でタイブレーク（AC-2）。これにより session
 * 再開時に古い session の状態に覆い隠される B8 バグを解決する。
 *
 * **§0.5「closed が active を覆い隠さない」不変条件は recency 優先化後も維持する**：`CLOSED` は、
 * 他に live な（非 closed の）session が instance 内に 1 つでもあれば、`lastEventAt` がどれだけ
 * 新しくても候補から除外され代表になれない。recency 優先化は「live な session 同士」の比較にのみ
 * 適用する。instance 内の全 session が `CLOSED` の場合のみ closed 自身が候補となり代表になる
 * （instance 全体が終了しているケースで、FR-01 の既定非表示化と組み合わさる想定）。project レベル
 * のロールアップは CLI 側の `ClientRollup` が担うため、ここは instance レベルに限定する。
 */
export class InstanceStatusRollup {
  private readonly priority = new StatusPriority()

  /**
   * session ごとの結果から instance の代表ステータスを選ぶ。
   *
   * `CLOSED` は他に live な session が 1 つでもあれば候補から除外する（§0.5 維持）。残った候補
   * （全件 closed なら closed 自身）の中で最も新しい `lastEventAt` を無条件に代表とし（AC-1）、
   * 複数 session の `lastEventAt` が完全同一のときのみ priority でタイブレーク（AC-2）。
   *
   * @param entries 同一 instance 配下の各 session の {@link RollupEntry}（1 件以上）。
   * @returns 代表となる {@link StatusResult}。
   * @throws {Error} 空配列の場合（session を持たない instance の rollup は呼び出し規約違反）。
   */
  rollup(entries: RollupEntry[]): StatusResult {
    if (entries.length === 0) {
      throw new Error('InstanceStatusRollup.rollup: cannot roll up an empty session status list')
    }

    // §0.5: live な (非 closed) session が 1 つでもあれば、closed は候補から除外する。
    const live = entries.filter((entry) => entry.status.display !== 'CLOSED')
    const candidates = live.length > 0 ? live : entries

    // AC-1: 候補の中で最も新しい lastEventAt を持つ entry を探す。
    const freshest = maxLastEventAt(candidates)

    // AC-2: 複数が同じ lastEventAt を持つ場合、priority でタイブレーク。
    const tied = candidates.filter((entry) => entry.lastEventAt === freshest)
    return tied
      .map((entry) => entry.status)
      .reduce((representative, current) => this.priority.higherOf(representative, current))
  }
}
