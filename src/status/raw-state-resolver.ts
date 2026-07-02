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
 * 状態を持つイベントだけを抽出し、hub 権威時刻（received_at）降順（新しい順）に整列した
 * 新しい配列を返す（§0.5 / FR-08 P1）。
 *
 * status 導出の hot path では、この「関連イベントのみ・降順」配列を 1 度だけ生成し、
 * {@link RawStateResolver.resolve}（最新状態）と `StateTransitionFinder.find`（遷移時刻）の
 * 双方で共有する。以前は両者が各自 `filter`（＋finder は `sort`）していたため同一配列を
 * 複数回フルスキャンしていたが、この関数に集約することで抽出・整列を 1 回に減らす。降順に
 * 揃えるのは、finder が再ソートなしで先頭（最新）から単一パスで連続区間を辿れるようにするため。
 *
 * @param events 対象 session のイベント列（順不同で可。状態に無関係な補助イベントを含んでよい）。
 * @returns received_at 降順（同値は `id` 降順）の、状態を持つイベントだけの新しい配列。
 */
export function collectStateBearingDescending(events: Event[]): Event[] {
  return events.filter((e) => rawStateOf(e) !== null).sort((a, b) => compareByReceivedThenId(b, a))
}

/**
 * session のイベント列から現在の raw_state を判定するドメインサービス（§4 / §0.5）。
 *
 * 判定は「received_at 基準で最も新しい、状態を持つイベント」の写像に等しい。
 * 呼び出し規約として整列済み・関連イベントのみの配列（{@link collectStateBearingDescending}
 * の出力）を受け取り、その先頭要素（＝最新の状態イベント）の写像を返すだけにすることで、
 * 内部での再フィルタ・再ソートを排除する（FR-08 P1）。
 */
export class RawStateResolver {
  /**
   * 整列済みの状態イベント配列から現在の raw_state を導出する。
   *
   * 呼び出し規約（FR-08 P1）: `events` は {@link collectStateBearingDescending} が返す
   * 「状態を持つイベントのみ・received_at 降順（新しい順）」の配列であること。先頭が最新の
   * 状態イベントなので、内部で並べ替えず先頭要素の写像をそのまま返す。
   *
   * @param events 降順・状態イベントのみの配列（{@link collectStateBearingDescending} 出力）。
   * @returns 現在の raw_state。空配列（状態を持つイベントが 1 つも無い縮退ケース）は既定で
   *   `ACTIVE`（SessionStart 前などの縮退ケース。呼び出し側は経過時間 0 として扱う）。
   */
  resolve(events: Event[]): RawState {
    if (events.length === 0) return 'ACTIVE'
    return rawStateOf(events[0]) as RawState
  }
}
