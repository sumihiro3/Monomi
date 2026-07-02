import type { Event } from '../domain/entities.js'
import type { RawState } from '../domain/enums.js'
import type { EpochMs } from '../domain/time.js'
import { compareByReceivedThenId, rawStateOf } from './raw-state-resolver.js'

/**
 * 現在状態と、その状態へ遷移した時刻の組（クラス図 §2）。
 *
 * `transitionedAt` は「現 raw_state 連続区間の最初のイベントの received_at」（§0.5）。
 * 経過時間はここを起点に計算する。
 */
export interface StateTransition {
  rawState: RawState
  transitionedAt: EpochMs
}

/**
 * {@link StateTransition} を生成する唯一のファクトリ。値オブジェクトとして凍結して返す。
 *
 * @param rawState 現在の raw_state。
 * @param transitionedAt 現 raw_state 連続区間の開始時刻（received_at）。
 * @returns 凍結済みの {@link StateTransition}。
 */
export function createStateTransition(
  rawState: RawState,
  transitionedAt: EpochMs
): StateTransition {
  return Object.freeze({ rawState, transitionedAt })
}

/**
 * 現 raw_state の連続区間の開始時刻を特定するドメインサービス（§0.5）。
 *
 * 放置の時計は「同じ raw_state が続く区間の最初のイベント時刻」を起点にする。
 * `idle_prompt` が複数回発火しても（＝同じ `NEXT_WAIT` が連続しても）起点はリセット
 * されず、最初の 1 発目の received_at が遷移時刻になる。別の raw_state（例: 途中の
 * `PostToolUse` による `ACTIVE`）が挟まった場合はそこで区間が切れ、その後の新しい
 * 区間の先頭が起点になる。この「リセットしない／本当の状態変化でのみリセットする」
 * という §0.5 の要件をこのクラスに閉じ込める。
 */
export class StateTransitionFinder {
  /**
   * 現 raw_state 連続区間の開始時刻を求める。
   *
   * @param events 対象 session の全イベント（順不同で可）。
   * @param currentState 現在の raw_state（`RawStateResolver.resolve` の結果）。
   * @returns 遷移時刻を含む {@link StateTransition}。
   * @throws {Error} 状態を持つイベントが無い、または `currentState` が最新イベントの
   *   状態と一致しない（呼び出し規約違反）場合。
   */
  find(events: Event[], currentState: RawState): StateTransition {
    const relevant = events.filter((e) => rawStateOf(e) !== null).sort(compareByReceivedThenId)
    if (relevant.length === 0) {
      throw new Error('StateTransitionFinder.find: no state-bearing events to locate a transition')
    }

    const last = relevant[relevant.length - 1]
    if (rawStateOf(last) !== currentState) {
      throw new Error(
        `StateTransitionFinder.find: currentState "${currentState}" does not match the latest event state "${rawStateOf(last)}"`
      )
    }

    // 末尾から同じ raw_state が続く限り遡り、区間の先頭の received_at を起点にする。
    let transitionedAt = last.receivedAt
    for (let i = relevant.length - 2; i >= 0; i--) {
      if (rawStateOf(relevant[i]) !== currentState) break
      transitionedAt = relevant[i].receivedAt
    }

    return createStateTransition(currentState, transitionedAt)
  }
}
