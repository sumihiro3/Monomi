import type { Session, SessionTerminal } from '../../domain/entities.js'
import { toEpochMs, type EpochMs } from '../../domain/time.js'
import type { Database, PreparedStatement } from '../database.js'

/**
 * {@link SessionRepository.updateTerminal} の入力。
 *
 * `seenAt` は呼び出し側が別引数（`at`）で渡すため、{@link SessionTerminal} から除いた形。
 */
export type SessionTerminalInput = Omit<SessionTerminal, 'seenAt'>

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
  tty: string | null
  term_program: string | null
  tmux_pane: string | null
  tmux_socket: string | null
  wsl_distro: string | null
  wt_session: string | null
  terminal_seen_at: number | null
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
    terminal:
      row.terminal_seen_at === null
        ? null
        : {
            tty: row.tty,
            termProgram: row.term_program,
            tmuxPane: row.tmux_pane,
            tmuxSocket: row.tmux_socket,
            wslDistro: row.wsl_distro,
            wtSession: row.wt_session,
            seenAt: toEpochMs(row.terminal_seen_at),
          },
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
  /** {@link updateTerminal} 用の UPDATE。 */
  private readonly updateTerminalStmt: PreparedStatement
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
    this.updateTerminalStmt = db.prepare(
      `UPDATE sessions
       SET tty = ?, term_program = ?, tmux_pane = ?, tmux_socket = ?, wsl_distro = ?, wt_session = ?,
           terminal_seen_at = ?
       WHERE id = ?`
    )
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
   * reporter が捕捉した最新のターミナル特定情報でセッションのスナップショットを上書きする
   * （release-23 FR-02b）。
   *
   * 呼び出し側（`EventIngestionService.ingest`、FR-02 AC-5）は `payload.terminal` が
   * undefined/null でないときのみ本メソッドを呼ぶ規約とする。旧 reporter の欠落ペイロード
   * で既存のスナップショットを NULL 上書きしないためで、本メソッド自体は無条件に上書きする
   * （`info` 内の個々の null は新 reporter が明示的に「取得不能」と報告した値としてそのまま
   * 採用する）。
   *
   * @param sessionId session_id。
   * @param info reporter が捕捉したターミナル特定情報（`seenAt` を除く）。
   * @param at スナップショットを hub が受信した時刻（`terminal_seen_at` に保存）。
   */
  updateTerminal(sessionId: string, info: SessionTerminalInput, at: EpochMs): void {
    this.updateTerminalStmt.run(
      info.tty,
      info.termProgram,
      info.tmuxPane,
      info.tmuxSocket,
      info.wslDistro,
      info.wtSession,
      at,
      sessionId
    )
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
