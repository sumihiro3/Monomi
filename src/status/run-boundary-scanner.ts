import type { Event } from '../domain/entities.js'
import type { RawState } from '../domain/enums.js'
import { rawStateOf } from './raw-state-resolver.js'

/**
 * 1 ページ分の走査結果。
 */
export interface RunBoundaryScanResult {
  /**
   * ページ内で `currentState` と異なる raw_state のイベントに当たり、現在の raw_state
   * 連続区間の境界（＝より古い区間との切れ目）を検出したか。
   */
  boundaryFound: boolean
  /**
   * 走査後に把握している raw_state。境界を検出した場合は境界直前（＝現区間）の状態の
   * ままで、境界を作ったイベント自身の状態へは更新しない。ページ内に状態を持つイベントが
   * 1 つも無ければ入力の `currentState` をそのまま返す。
   */
  state: RawState | null
}

/**
 * hub 権威時刻（received_at）降順の 1 ページ分のイベントを走査し、現在の raw_state
 * 連続区間の境界（＝異なる raw_state のイベント）を探すドメインサービス（§0.5 / §5.2）。
 *
 * `InstanceStatusService.loadEventsForCurrentRun`（hub レイヤー）はページを取得するたびに
 * この関数を呼び、`boundaryFound` が true になった時点でページングを打ち切る。1 イベントも
 * 状態を持たないページでは `currentState` を変えずに返し、呼び出し側は次のページを読み進める。
 * hub レイヤーは raw_state の写像規則（{@link rawStateOf}）を直接 import せず、この公開
 * ヘルパー越しにのみ状態境界の判定へアクセスする（layer 境界の維持）。
 *
 * @param page hub 権威時刻（received_at）降順の 1 ページ分のイベント
 *   （{@link EventRepository.recentPageForSession} の出力）。
 * @param currentState 直前までのページで把握している raw_state。まだ何も確定していなければ
 *   null。
 * @returns 境界を検出したか、および走査後に把握している raw_state。
 */
export function scanForRunBoundary(
  page: Event[],
  currentState: RawState | null
): RunBoundaryScanResult {
  let state = currentState
  for (const event of page) {
    const eventState = rawStateOf(event)
    if (eventState === null) continue
    if (state === null) {
      state = eventState
    } else if (eventState !== state) {
      return { boundaryFound: true, state }
    }
  }
  return { boundaryFound: false, state }
}
