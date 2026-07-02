import type { Event } from '../domain/entities.js'
import { toDurationMs, type EpochMs } from '../domain/time.js'
import { EscalationPolicy, type EscalationThresholds } from './escalation.js'
import { collectStateBearingDescending, RawStateResolver } from './raw-state-resolver.js'
import { StateTransitionFinder } from './state-transition-finder.js'
import { createStatusResult, type StatusResult } from './status-result.js'

/**
 * status 導出の薄いオーケストレーター（クラス図 §2）。
 *
 * 判断ロジックは一切持たず、`RawStateResolver`（最新 raw_state）→
 * `StateTransitionFinder`（遷移時刻）→ `EscalationPolicy`（表示ステータス確定）を
 * 順に呼び、`StatusResult` に組み立てるだけ。すべての時刻計算は received_at 基準（§0.5）。
 */
export class StatusDeriver {
  private readonly resolver = new RawStateResolver()
  private readonly finder = new StateTransitionFinder()
  private readonly policy = new EscalationPolicy()

  /**
   * 1 session のイベント列から最終ステータスを導出する。
   *
   * @param events 対象 session の全イベント（順不同で可）。
   * @param now hub の現在時刻（received_at 基準の権威時刻。テスト用に注入可能）。
   * @param thresholds 放置昇格閾値。
   * @param hasPrWaiting この instance/branch に未レビューの PR があるか（release-1 は常に false）。
   * @returns 導出した {@link StatusResult}。
   */
  deriveForSession(
    events: Event[],
    now: EpochMs,
    thresholds: EscalationThresholds,
    hasPrWaiting: boolean
  ): StatusResult {
    // 状態を持つイベントだけを received_at 降順で 1 度だけ抽出し、resolver / finder で共有する
    // （FR-08 P1: 各サービスが個別に filter/sort していた同一配列の重複フルスキャンを集約）。
    const relevant = collectStateBearingDescending(events)

    // 状態を持つイベントが 1 つも無い縮退ケース（補助イベントのみ／空）は稼働中 0 経過扱い。
    if (relevant.length === 0) {
      return createStatusResult('ACTIVE', 'ACTIVE', toDurationMs(0), false)
    }

    const rawState = this.resolver.resolve(relevant)
    const transition = this.finder.find(relevant, rawState)
    const display = this.policy.classify(transition, now, thresholds, hasPrWaiting)
    const elapsedMs = toDurationMs(now - transition.transitionedAt)
    return createStatusResult(rawState, display, elapsedMs, display === 'STALE')
  }
}
