import type { Event } from '../../domain/entities.js'
import type { EventType } from '../../domain/enums.js'
import { toEpochMs, type EpochMs } from '../../domain/time.js'
import type { Database } from '../database.js'

/** {@link EventRepository.recentPageForSession} の keyset カーソル（ページ境界）。 */
export interface EventPageCursor {
  receivedAt: EpochMs
  id: number
}

/**
 * 追記する新規イベント。`id` は AUTOINCREMENT で DB が採番するため入力から除く。
 * `received_at`（§0.5 の権威時刻）は hub 受信時に UseCase 側が埋めて渡す。
 */
export type NewEvent = Omit<Event, 'id'>

/** `events` テーブルの生行。 */
interface EventRow {
  id: number
  session_id: string
  instance_id: string
  event_type: string
  event_subtype: string | null
  tool_name: string | null
  tool_summary: string | null
  occurred_at: number
  received_at: number
}

/** DB 行を {@link Event} へ写す。 */
function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    sessionId: row.session_id,
    instanceId: row.instance_id,
    eventType: row.event_type as EventType,
    eventSubtype: row.event_subtype,
    toolName: row.tool_name,
    toolSummary: row.tool_summary,
    occurredAt: toEpochMs(row.occurred_at),
    receivedAt: toEpochMs(row.received_at),
  }
}

/**
 * `events` テーブルのアクセサ（§7.3 + §0.5 `received_at`）。
 *
 * `events` は追記専用（更新・削除はしない）。status 導出は `received_at` を権威時刻に
 * 用いるため、`append` の入力には呼び出し側が算出した `received_at` を必ず含める。
 */
export class EventRepository {
  constructor(private readonly db: Database) {}

  /**
   * イベントを 1 件追記し、採番された `id` を含む {@link Event} を返す。
   *
   * クラス図では戻り値 void だが、採番 id を後続処理・テストで確認できるよう
   * 永続化後の行を返す（呼び出し側は無視してよい）。
   *
   * @param event `id` を除く新規イベント（`received_at` を含む）。
   * @returns 採番済み `id` を持つ永続化後の {@link Event}。
   */
  append(event: NewEvent): Event {
    const result = this.db
      .prepare(
        `INSERT INTO events
           (session_id, instance_id, event_type, event_subtype, tool_name, tool_summary,
            occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.sessionId,
        event.instanceId,
        event.eventType,
        event.eventSubtype,
        event.toolName,
        event.toolSummary,
        event.occurredAt,
        event.receivedAt
      )
    return { ...event, id: Number(result.lastInsertRowid) }
  }

  /**
   * 指定 session の全イベントを、hub 権威時刻（`received_at`）昇順で返す。
   *
   * status 導出（`StateTransitionFinder` 等）が received_at 基準で処理するため、
   * 取り出し順もそれに合わせる（同値は採番 `id` 昇順でタイブレーク）。
   *
   * @param sessionId session_id。
   * @returns 時系列順の {@link Event} 配列。
   */
  allForSession(sessionId: string): Event[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY received_at ASC, id ASC')
      .all(sessionId) as unknown as EventRow[]
    return rows.map(toEvent)
  }

  /**
   * 指定 instance の直近イベントを新しい順（`occurred_at` 降順）に返す（Agent View Lv.1）。
   *
   * 表示は人が読むクライアント時刻（`occurred_at`）順が自然で、`idx_events_instance_time`
   * にも一致する。
   *
   * @param instanceId instance の id。
   * @param limit 取得件数の上限。
   * @returns 新しい順の {@link Event} 配列。
   */
  recentForInstance(instanceId: string, limit: number): Event[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM events WHERE instance_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?'
      )
      .all(instanceId, limit) as unknown as EventRow[]
    return rows.map(toEvent)
  }

  /**
   * 指定 session のイベントを hub 権威時刻（received_at）の新しい順に、`limit` 件だけ返す
   * （keyset pagination）。status 導出（{@link StateTransitionFinder}）が現在の raw_state
   * 連続区間の境界を見つけるまで後ろ向きにページングするために使う。全履歴を毎回読む
   * コストを避ける（perf review 是正: 一覧/詳細 API が session の全イベントを毎回
   * フルロードしていた問題）。
   *
   * @param sessionId session_id。
   * @param limit 1 ページの件数。
   * @param cursor 前ページ最後の行の `(received_at, id)`。省略時は最新から開始。
   * @returns 新しい順の {@link Event} 配列（`cursor` より古い行のみ、最大 `limit` 件）。
   */
  recentPageForSession(sessionId: string, limit: number, cursor?: EventPageCursor): Event[] {
    const rows = cursor
      ? (this.db
          .prepare(
            `SELECT * FROM events
             WHERE session_id = ?
               AND (received_at < ? OR (received_at = ? AND id < ?))
             ORDER BY received_at DESC, id DESC
             LIMIT ?`
          )
          .all(
            sessionId,
            cursor.receivedAt,
            cursor.receivedAt,
            cursor.id,
            limit
          ) as unknown as EventRow[])
      : (this.db
          .prepare(
            'SELECT * FROM events WHERE session_id = ? ORDER BY received_at DESC, id DESC LIMIT ?'
          )
          .all(sessionId, limit) as unknown as EventRow[])
    return rows.map(toEvent)
  }
}
