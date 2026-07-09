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
 *
 * release-19 FR-01: 上記の recency 優先化がもたらした副作用（既知課題 B9）に対処する孤立
 * （zombie）live session 除外ロジックを追加。異常終了（クラッシュ等）で `CLOSED` イベントを
 * 送れなかった live session は、指標上ずっと `lastEventAt` が更新されないまま残り続け、放置閾値
 * を超えると `STALE`（放置）表示に昇格する。そこへ同一 instance 内の別 session が正常に
 * `SessionEnd` を送って `CLOSED` になった直後、この孤立 `STALE` session が recency 優先化の
 * せいで（実際には新しい activity が無いのに）代表の座を奪い、ダッシュボード上「正常終了した
 * はずの instance が放置表示のまま」に見えるバグを引き起こす。ライブネス検知の本実装（heartbeat・
 * `session_lost`）が未着手（§6）なため、「同一 instance に `CLOSED` が存在するなら、それより
 * 古い `STALE` な live session は孤立とみなして候補から除外する」という表示上の対症療法
 * （heuristic）で対応する。真に `ACTIVE`（非 `STALE`）な live session は、`CLOSED` がどれだけ
 * 新しくても除外しない（B8 の recency 優先化を壊さないため）。
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
 *
 * **release-19 FR-01 孤立（zombie）live session 除外**：instance 内に `CLOSED` session が
 * 1 件以上存在する場合に限り（`CLOSED` が皆無なら適用範囲外。AC-6）、live session のうち
 * 「`STALE`（放置）表示に昇格しており、かつ `lastEventAt` が最新 `CLOSED` の `lastEventAt` より
 * 古い」ものを孤立とみなして候補から除外する。真に `ACTIVE` な（`STALE` に昇格していない）
 * live session は除外対象にならない（AC-4・B8 不変条件維持）。除外の結果 live 候補が 0 件に
 * なった場合は最新 `CLOSED` session を代表として返す（AC-2）。
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
    const closed = entries.filter((entry) => entry.status.display === 'CLOSED')
    const live = entries.filter((entry) => entry.status.display !== 'CLOSED')

    const candidates = this.selectCandidates(live, closed, entries)

    // AC-1: 候補の中で最も新しい lastEventAt を持つ entry を探す。
    const freshest = maxLastEventAt(candidates)

    // AC-2: 複数が同じ lastEventAt を持つ場合、priority でタイブレーク。
    const tied = candidates.filter((entry) => entry.lastEventAt === freshest)
    return tied
      .map((entry) => entry.status)
      .reduce((representative, current) => this.priority.higherOf(representative, current))
  }

  /**
   * §0.5 の closed 除外と release-19 FR-01 の孤立 live session 除外を適用し、
   * recency 比較（`rollup` 本体）に渡す候補集合を決める。
   *
   * - live が 0 件（全件 `CLOSED`）: `closed` は候補から除外できないため `entries` 全体を返す。
   * - `closed` が 0 件（`CLOSED` が皆無）: FR-01 の適用範囲外（AC-6）。従来どおり `live` のみ。
   * - どちらも 1 件以上ある場合: 最新 `CLOSED` の `lastEventAt` より古い `STALE` な live entry を
   *   孤立とみなして除外する（AC-1・AC-4）。除外後に live が 0 件になれば `closed`（＝最新
   *   `CLOSED` が recency 比較の結果として選ばれる）にフォールバックする（AC-2）。
   *
   * @param live `CLOSED` 以外（live）の entries。
   * @param closed `CLOSED` の entries。
   * @param entries 呼び出し元が受け取った全 entries（live が空のときのフォールバック用）。
   * @returns 後続の recency 比較に渡す候補集合。
   */
  private selectCandidates(
    live: RollupEntry[],
    closed: RollupEntry[],
    entries: RollupEntry[]
  ): RollupEntry[] {
    if (live.length === 0) {
      return entries
    }
    if (closed.length === 0) {
      return live
    }

    const latestClosedLastEventAt = maxLastEventAt(closed)
    const nonOrphanedLive = live.filter(
      (entry) => !(entry.status.isStale && entry.lastEventAt < latestClosedLastEventAt)
    )
    return nonOrphanedLive.length > 0 ? nonOrphanedLive : closed
  }
}
