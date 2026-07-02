import type { Event } from '../domain/entities.js'
import type { RawState } from '../domain/enums.js'

/**
 * 1 イベントを raw_state へ写像する（§4 / §0.5）。状態導出に無関係なイベントは null。
 *
 * この写像は raw_state 判定の唯一の定義であり、`RawStateResolver`（最新状態）と
 * `StateTransitionFinder`（遷移時刻）の双方がこれを共有して二重定義を防ぐ。
 *
 * - `Notification(permission_prompt)` → `APPROVAL_WAIT`、`Notification(idle_prompt)` →
 *   `NEXT_WAIT`（§0.5: 権限待ちの観測は `PermissionRequest` ではなく `Notification` に一本化）。
 * - `SessionEnd` / `session_lost` → `CLOSED`（後者はライブネス検知由来。release-1 では
 *   発生しない想定だが、届いた場合はセッション終了として扱う）。
 * - `Stop` → `NEXT_WAIT`（§4: ターン終了の暫定。直後の `idle_prompt` か次の
 *   `UserPromptSubmit` で確定するまでは「次の指示待ち」とみなす）。
 * - `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` → `ACTIVE`。
 * - `WorktreeCreate` / `WorktreeRemove` は instance 登録の補助情報（§7.1）で状態に
 *   影響しないため null。未知の `Notification` matcher も状態判定には用いず null。
 *
 * @param event 対象イベント。
 * @returns 対応する raw_state。状態導出に無関係なら null。
 */
export function rawStateOf(event: Event): RawState | null {
  switch (event.eventType) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'ACTIVE'
    case 'Stop':
      return 'NEXT_WAIT'
    case 'Notification':
      if (event.eventSubtype === 'permission_prompt') return 'APPROVAL_WAIT'
      if (event.eventSubtype === 'idle_prompt') return 'NEXT_WAIT'
      return null
    case 'SessionEnd':
    case 'session_lost':
      return 'CLOSED'
    case 'WorktreeCreate':
    case 'WorktreeRemove':
      return null
    default:
      return null
  }
}

/**
 * 2 イベントを hub 権威時刻（received_at）昇順に並べる比較関数（§0.5）。
 *
 * received_at が同値のときは autoincrement な `id`（= hub の挿入順）でタイブレークし、
 * クロックスキューに依存しない安定した順序を与える。`occurred_at`（クライアント時刻）は
 * status 導出には用いない。
 *
 * @param a 比較対象。
 * @param b 比較対象。
 * @returns 負なら a が先、正なら b が先、0 なら同順。
 */
export function compareByReceivedThenId(a: Event, b: Event): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt
  return a.id - b.id
}

/**
 * session のイベント列から現在の raw_state を判定するドメインサービス（§4 / §0.5）。
 *
 * 判定は「received_at 基準で最も新しい、状態を持つイベント」の写像に等しい。
 * イベントの配列順には依存せず、内部で received_at → id 順に並べ替えて最新を選ぶ。
 */
export class RawStateResolver {
  /**
   * イベント列から raw_state を導出する。
   *
   * @param events 対象 session の全イベント（順不同で可）。
   * @returns 現在の raw_state。状態を持つイベントが 1 つも無い場合は既定で `ACTIVE`
   *   （SessionStart 前などの縮退ケース。呼び出し側は経過時間 0 として扱う）。
   */
  resolve(events: Event[]): RawState {
    const latest = this.latestRelevantEvent(events)
    return latest ? (rawStateOf(latest) as RawState) : 'ACTIVE'
  }

  /**
   * 状態を持つイベントのうち received_at 基準で最新のものを返す。
   *
   * @param events 対象イベント列。
   * @returns 最新の状態イベント。存在しなければ null。
   */
  private latestRelevantEvent(events: Event[]): Event | null {
    const relevant = events.filter((e) => rawStateOf(e) !== null)
    if (relevant.length === 0) return null
    return relevant.reduce((latest, e) => (compareByReceivedThenId(e, latest) >= 0 ? e : latest))
  }
}
