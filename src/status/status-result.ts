import type { RawState } from '../domain/enums.js'
import type { DurationMs } from '../domain/time.js'
import { STATUS_PRIORITY, type RepresentedStatus } from './status-priority.js'

/**
 * 1 session（または rollup 後の 1 instance）の最終ステータス（クラス図 §2）。
 *
 * `rawState` は導出元の内部状態（`CLOSED` を含みうる）を保持し、`display` は §5.2 で
 * 表示に落とし込んだ状態（放置なら `STALE`、非表示なら `CLOSED`）。`priority` は
 * `display` から一意に定まる数値優先度で、CLI ロールアップが `max()` するだけで
 * 済むよう結果に埋め込んでおく（§0.5）。
 */
export interface StatusResult {
  /** 導出元の内部状態（表示が `STALE` でも元の raw_state はここに残す）。 */
  rawState: RawState
  /** §5.2 で確定した表示ステータス（`CLOSED` は非表示扱い）。 */
  display: RepresentedStatus
  /** 現 raw_state 連続区間の開始（遷移時刻）からの経過。received_at 基準（§0.5）。 */
  elapsedMs: DurationMs
  /** `display === 'STALE'`（放置に昇格したか）と同義。 */
  isStale: boolean
  /** `display` の数値優先度（{@link STATUS_PRIORITY}）。 */
  priority: number
}

/**
 * {@link StatusResult} を生成する唯一のファクトリ。
 *
 * `priority` を `display` から自動で導出することで、`display` と `priority` が食い違う
 * 結果が生まれないようにする。値オブジェクトとして凍結して返す。
 *
 * @param rawState 導出元の内部状態。
 * @param display 表示ステータス。
 * @param elapsedMs 遷移時刻からの経過（received_at 基準）。
 * @param isStale 放置へ昇格したか。
 * @returns 凍結済みの {@link StatusResult}。
 */
export function createStatusResult(
  rawState: RawState,
  display: RepresentedStatus,
  elapsedMs: DurationMs,
  isStale: boolean
): StatusResult {
  return Object.freeze({
    rawState,
    display,
    elapsedMs,
    isStale,
    priority: STATUS_PRIORITY[display],
  })
}
