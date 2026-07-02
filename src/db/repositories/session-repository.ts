import type { Session } from '../../domain/entities.js'
import { toEpochMs, type EpochMs } from '../../domain/time.js'
import type { Database, PreparedStatement } from '../database.js'

/** `sessions` テーブルの生行。 */
interface SessionRow {
  id: string
  instance_id: string
  agent_type: string
  pid: number | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  last_heartbeat_at: number | null
}

/** DB 行を {@link Session} へ写す。 */
function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    instanceId: row.instance_id,
    agentType: row.agent_type,
    pid: row.pid,
    startedAt: toEpochMs(row.started_at),
    endedAt: row.ended_at === null ? null : toEpochMs(row.ended_at),
    endReason: row.end_reason,
    lastHeartbeatAt: row.last_heartbeat_at === null ? null : toEpochMs(row.last_heartbeat_at),
  }
}

/**
 * `sessions` テーブルのアクセサ（§7.3）。
 *
 * `last_heartbeat_at` はライブネス検知（§0.4 v1延期）の受け皿として列だけ存在し、
 * release-1 では**更新経路を設けない**（ハートビート API を実装しない方針の反映）。
 * そのため `touchHeartbeat` は本 Repository に実装しない。
 */
export class SessionRepository {
  /** {@link upsertStarted} 用の INSERT（FR-08 AC-2: 呼び出しごとの prepare() を避ける）。 */
  private readonly upsertStartedStmt: PreparedStatement
  /** {@link markEnded} 用の UPDATE。 */
  private readonly markEndedStmt: PreparedStatement
  /** {@link findById} 用の SELECT。 */
  private readonly findByIdStmt: PreparedStatement
  /** {@link listByInstance} 用の SELECT。 */
  private readonly listByInstanceStmt: PreparedStatement

  constructor(db: Database) {
    this.upsertStartedStmt = db.prepare(
      `INSERT INTO sessions (id, instance_id, agent_type, started_at)
       VALUES (?, ?, 'claude_code', ?)
       ON CONFLICT(id) DO NOTHING`
    )
    this.markEndedStmt = db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?')
    this.findByIdStmt = db.prepare('SELECT * FROM sessions WHERE id = ?')
    this.listByInstanceStmt = db.prepare(
      'SELECT * FROM sessions WHERE instance_id = ? ORDER BY started_at DESC, id DESC'
    )
  }

  /**
   * `SessionStart` 相当のイベントで session を冪等に登録する。
   *
   * `ON CONFLICT(id) DO NOTHING` で、同一 session_id の再送でも `started_at` を保存する。
   * `agent_type` は v1 固定の `claude_code`（§7.4）。
   *
   * @param instanceId 所属 instance の id。
   * @param sessionId エージェント側の session_id。
   * @param startedAt セッション開始時刻。
   * @returns 既存または新規の {@link Session}。
   */
  upsertStarted(instanceId: string, sessionId: string, startedAt: EpochMs): Session {
    this.upsertStartedStmt.run(sessionId, instanceId, startedAt)
    return this.findById(sessionId)!
  }

  /**
   * session を終了状態にする（`SessionEnd` / `session_lost`）。
   *
   * @param sessionId session_id。
   * @param reason 終了理由（`clear`/`logout`/`prompt_input_exit`/`session_lost`/`other`）。
   * @param at 終了時刻。
   */
  markEnded(sessionId: string, reason: string, at: EpochMs): void {
    this.markEndedStmt.run(at, reason, sessionId)
  }

  /**
   * id で session を取得する。
   *
   * @param id session_id。
   * @returns 見つかれば {@link Session}、無ければ null。
   */
  findById(id: string): Session | null {
    const row = this.findByIdStmt.get(id) as SessionRow | undefined
    return row ? toSession(row) : null
  }

  /**
   * instance 配下の session を新しい順（`started_at` 降順）に列挙する。
   *
   * @param instanceId instance の id。
   * @returns {@link Session} の配列。
   */
  listByInstance(instanceId: string): Session[] {
    const rows = this.listByInstanceStmt.all(instanceId) as unknown as SessionRow[]
    return rows.map(toSession)
  }
}
