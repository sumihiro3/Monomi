import type { Event } from '../domain/entities.js'
import type { RawState } from '../domain/enums.js'
import type { EpochMs } from '../domain/time.js'
import { rawStateOf } from './raw-state-resolver.js'

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
 *
 * 呼び出し規約（FR-08 P1）: `find` は自前で filter/sort をせず、整列済みの
 * 「状態を持つイベントのみ・received_at 降順（新しい順）」配列を受け取る前提で単一パス
 * 消費する。この配列は {@link collectStateBearingDescending} が唯一の生成元で、
 * `RawStateResolver` と共有される（同一配列の重複フルスキャンを排除する）。
 */
export class StateTransitionFinder {
  /**
   * 現 raw_state 連続区間の開始時刻を求める。
   *
   * 呼び出し規約: `events` は {@link collectStateBearingDescending} が返す「状態を持つ
   * イベントのみ・received_at 降順（新しい順）」の配列であること。先頭が最新の状態イベント
   * なので、そこから前方（＝過去方向）へ、同一 raw_state が続く限り走査し、区間の先頭
   * （＝最古）の received_at を起点にする。以前は昇順に並べ替えて末尾から遡っていたが、
   * 降順入力を前提に先頭走査へ反転して再ソートを撤廃した。
   *
   * @param events 状態イベントのみ・received_at 降順の配列（順不同・補助イベント混在は不可）。
   * @param currentState 現在の raw_state（`RawStateResolver.resolve` の結果）。
   * @returns 遷移時刻を含む {@link StateTransition}。
   * @throws {Error} 配列が空、または `currentState` が最新イベント（先頭要素）の状態と
   *   一致しない（呼び出し規約違反）場合。
   */
  find(events: Event[], currentState: RawState): StateTransition {
    if (events.length === 0) {
      throw new Error('StateTransitionFinder.find: no state-bearing events to locate a transition')
    }

    const latest = events[0]
    if (rawStateOf(latest) !== currentState) {
      throw new Error(
        `StateTransitionFinder.find: currentState "${currentState}" does not match the latest event state "${rawStateOf(latest)}"`
      )
    }

    // 降順入力なので先頭（最新）から前方へ、同じ raw_state が続く限り走査し、区間の先頭
    // （＝最古）の received_at を起点にする。異なる raw_state に当たった時点で区間が切れる。
    let transitionedAt = latest.receivedAt
    for (let i = 1; i < events.length; i++) {
      if (rawStateOf(events[i]) !== currentState) break
      transitionedAt = events[i].receivedAt
    }

    return createStateTransition(currentState, transitionedAt)
  }
}
