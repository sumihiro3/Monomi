import type { DeviceRepository } from '../db/repositories/device-repository.js'
import type { EventPageCursor, EventRepository } from '../db/repositories/event-repository.js'
import type { InstanceRepository } from '../db/repositories/instance-repository.js'
import type { PrStatusRepository } from '../db/repositories/pr-status-repository.js'
import type { ProjectRepository } from '../db/repositories/project-repository.js'
import type { SessionRepository } from '../db/repositories/session-repository.js'
import type { Event, Instance, Session } from '../domain/entities.js'
import type { RawState } from '../domain/enums.js'
import type { EpochMs } from '../domain/time.js'
import { EscalationThresholds } from '../status/escalation.js'
import { InstanceStatusRollup } from '../status/instance-status-rollup.js'
import { scanForRunBoundary } from '../status/run-boundary-scanner.js'
import { StatusDeriver } from '../status/status-deriver.js'
import type { StatusResult } from '../status/status-result.js'
import {
  deriveProjectName,
  epochMsToIso8601,
  type InstanceDetail,
  type InstanceStatusRow,
  type RecentEventDto,
  toWireStatus,
} from './dto.js'

/**
 * 詳細（Agent View Lv.1）で返す直近イベントの件数（release-6 FR-02 AC-2: 20→100）。
 *
 * CLI 側の下部イベント履歴BOXが表示する「全体件数(Z)」は、この取得済み上限（100件）で
 * あり、DB上の instance の真の全イベント件数ではない（FR-02 AC-4 はスコープ外の count
 * クエリを要求しない）。100件を超えるイベント履歴を持つ instance では、Z は実件数より
 * 少なく表示される。
 */
const RECENT_EVENTS_LIMIT = 100

/**
 * status 導出用に 1 度に読み込むイベントページの件数。
 *
 * `loadEventsForCurrentRun` がこの件数ずつ新しい順にページングし、現在の raw_state
 * 連続区間の境界（＝異なる raw_state のイベント）が見つかった時点で打ち切る。同一状態が
 * 長く続く稀なケースのみ追加ページを読む。
 */
const STATUS_EVENT_PAGE_SIZE = 200

/**
 * release-1 の PR 待ち有無。poller 未実装（§0.4 v1延期）のため常に false 固定
 * （`pr_status` テーブルは作られるが行は増えず、status 導出に影響しない）。
 */
const HAS_PR_WAITING = false

/**
 * 一覧・詳細取得のための status 導出を束ねる UseCase（class-diagram §3 / §5 / §0.5）。
 *
 * instance ごとに配下 session の events から `StatusDeriver` で session 単位の
 * {@link StatusResult} を導出し、`InstanceStatusRollup` で代表を選ぶ（§5.3: closed が
 * active を覆い隠さない）。閾値ロジック・優先度は status-engine 側に一本化されており、
 * 本 UseCase は wire 形（§8.2）への写像に徹する。project 単位のロールアップは CLI の
 * 関心事なので持たない。
 */
export class InstanceStatusService {
  private readonly deriver = new StatusDeriver()
  private readonly rollup = new InstanceStatusRollup()

  /**
   * @param instances instance Repository（`listActive` / `findById`）。
   * @param sessions session Repository（instance 配下 session の列挙）。
   * @param events event Repository（session 全イベント / instance 直近イベント）。
   * @param projects project Repository（表示名の解決）。
   * @param devices device Repository（デバイス名の解決）。
   * @param prStatus PR 状態 Repository（`pr` 表示用。release-1 では常に空）。
   * @param thresholds 放置昇格閾値（config 由来。省略時は既定 2h/6h/24h/72h）。
   */
  constructor(
    private readonly instances: InstanceRepository,
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly projects: ProjectRepository,
    private readonly devices: DeviceRepository,
    private readonly prStatus: PrStatusRepository,
    private readonly thresholds: EscalationThresholds = EscalationThresholds.withDefaults()
  ) {}

  /**
   * 稼働中（未削除）instance を導出済みステータス付きで列挙する（§8.2）。
   *
   * session を持たない instance（理論上生じない縮退ケース）は表示対象から除外する。
   * `listActive` は `removed_at IS NULL` の instance を返すため、代表 session が終了
   * （`closed`）していても行自体は返る（非表示化は CLI 側の関心事、§5.1/§5.3）。
   *
   * @param now hub の現在時刻（received_at 基準の権威時刻、§0.5）。
   * @returns instance ごとの {@link InstanceStatusRow}。
   */
  listInstances(now: EpochMs): InstanceStatusRow[] {
    const rows: InstanceStatusRow[] = []
    for (const instance of this.instances.listActive()) {
      const row = this.buildRow(instance, now)
      if (row !== null) {
        rows.push(row)
      }
    }
    return rows
  }

  /**
   * 1 instance の詳細（一覧 1 行 + 直近イベント）を返す（§8.2 / §10.4）。
   *
   * @param id instance の id。
   * @param now hub の現在時刻（received_at 基準の権威時刻、§0.5）。
   * @returns {@link InstanceDetail}。instance が存在しない、または session を持たない場合は null。
   */
  getInstanceDetail(id: string, now: EpochMs): InstanceDetail | null {
    const instance = this.instances.findById(id)
    if (instance === null) {
      return null
    }
    const row = this.buildRow(instance, now)
    if (row === null) {
      return null
    }
    const recentEvents: RecentEventDto[] = this.events
      .recentForInstance(id, RECENT_EVENTS_LIMIT)
      .map((e) => ({
        id: e.id,
        event_type: e.eventType,
        event_subtype: e.eventSubtype,
        tool_name: e.toolName,
        tool_summary: e.toolSummary,
        occurred_at: epochMsToIso8601(e.occurredAt),
        received_at: epochMsToIso8601(e.receivedAt),
      }))
    return { ...row, recent_events: recentEvents }
  }

  /**
   * 1 instance について代表 session の導出ステータスから wire 行を組み立てる。
   *
   * 配下 session 各々を `StatusDeriver` で導出し `InstanceStatusRollup` で代表を選ぶ。
   * rollup は入力配列の要素を参照同一のまま返すため、`indexOf` で代表 session を逆引きする。
   *
   * @param instance 対象 instance。
   * @param now 権威時刻。
   * @returns 組み立てた {@link InstanceStatusRow}。session が無ければ null。
   */
  private buildRow(instance: Instance, now: EpochMs): InstanceStatusRow | null {
    const sessions = this.sessions.listByInstance(instance.id)
    if (sessions.length === 0) {
      return null
    }

    const sessionStatuses = sessions.map((session) =>
      this.deriver.deriveForSession(
        this.loadEventsForCurrentRun(session.id),
        now,
        this.thresholds,
        HAS_PR_WAITING
      )
    )
    const representative = this.rollup.rollup(sessionStatuses)
    const representativeSession = sessions[sessionStatuses.indexOf(representative)]

    const project = this.projects.findById(instance.projectId)
    const device = this.devices.findById(instance.deviceId)
    const pr =
      instance.branch !== null
        ? this.prStatus.findByProjectBranch(instance.projectId, instance.branch)
        : null

    return {
      instance_id: instance.id,
      project: {
        id: instance.projectId,
        name: project
          ? (project.displayName ?? deriveProjectName(project.projectKey.value))
          : instance.projectId,
      },
      device: {
        id: instance.deviceId,
        name: device?.name ?? instance.deviceId,
      },
      path: instance.path,
      branch: instance.branch,
      status: this.toStatusDto(representative),
      pr: { state: pr?.state ?? 'none' },
      session: {
        id: representativeSession.id,
        last_heartbeat_at: this.formatHeartbeat(representativeSession),
      },
    }
  }

  /**
   * session の現在の raw_state 連続区間を判定するのに十分なイベントだけを、hub 権威時刻
   * （received_at）の新しい順にページングしながら取得する。
   *
   * 全履歴を毎回読む（`EventRepository.allForSession`）代わりに、直近ページ内で状態変化
   * （区間の境界）が見つかった時点で打ち切る。境界検出そのものは status レイヤーの
   * {@link scanForRunBoundary} に委譲し、hub 側は raw_state の写像規則を直接 import しない
   * （layer 境界の維持）。`StateTransitionFinder` は「最新（降順の先頭）から同じ raw_state
   * が続く区間だけ」を見るため、境界を跨いだ先の古いイベントは判定に不要——境界より前を
   * 読まなくても `deriveForSession` の結果は変わらない。返す配列は received_at 降順のままで、
   * `deriveForSession` がそれを状態イベントのみに絞って resolver / finder へ共有する
   * （FR-08 P1: 再ソートなしの単一パス消費）。同一状態が長時間続く稀なケースだけ追加ページを
   * 読み、必要な分だけコストが伸びる（真の履歴サイズを超えない）。
   *
   * @param sessionId 対象 session の id。
   * @returns 現在の raw_state 連続区間を判定するのに十分な、新しい順の {@link Event} 配列。
   */
  private loadEventsForCurrentRun(sessionId: string): Event[] {
    const collected: Event[] = []
    let cursor: EventPageCursor | undefined
    let currentState: RawState | null = null

    for (;;) {
      const page = this.events.recentPageForSession(sessionId, STATUS_EVENT_PAGE_SIZE, cursor)
      if (page.length === 0) break
      collected.push(...page)

      const scan = scanForRunBoundary(page, currentState)
      currentState = scan.state
      if (scan.boundaryFound) {
        return collected
      }

      if (page.length < STATUS_EVENT_PAGE_SIZE) break
      const last = page[page.length - 1]
      cursor = { receivedAt: last.receivedAt, id: last.id }
    }
    return collected
  }

  /**
   * {@link StatusResult} を wire の `status` オブジェクトへ写す。
   *
   * @param result 代表ステータス。
   * @returns §8.2 形式の status DTO。
   */
  private toStatusDto(result: StatusResult): InstanceStatusRow['status'] {
    return {
      display: toWireStatus(result.display),
      raw_state: toWireStatus(result.rawState),
      elapsed_seconds: Math.floor(result.elapsedMs / 1000),
      is_stale: result.isStale,
      priority: result.priority,
    }
  }

  /**
   * 代表 session の `last_heartbeat_at` を ISO8601 か null へ写す。
   *
   * @param session 代表 session。
   * @returns ISO8601 文字列、または未更新なら null。
   */
  private formatHeartbeat(session: Session): string | null {
    return session.lastHeartbeatAt === null ? null : epochMsToIso8601(session.lastHeartbeatAt)
  }
}
