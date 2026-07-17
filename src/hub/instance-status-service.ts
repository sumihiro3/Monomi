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
import type { RunningWork } from '../status/running-work-resolver.js'
import { scanForRunningWork } from '../status/running-work-resolver.js'
import { StatusDeriver } from '../status/status-deriver.js'
import type { StatusResult } from '../status/status-result.js'
import {
  deriveProjectName,
  epochMsToIso8601,
  type InstanceDetail,
  type InstanceStatusRow,
  type RecentEventDto,
  toPrDto,
  toRunningWorkDto,
  toTerminalDto,
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
   * @param prStatus PR 状態 Repository（`pr` 表示用、かつ `hasPrWaiting` 導出の入力元。FR-01
   * poller が書いた行を読む）。
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

    // FR-04: hasPrWaiting は session ごとの deriveForSession より前に確定させる必要がある
    // （status 導出の入力として渡すため）。instance.branch が無い（非 git / リモート未検出）
    // instance は PR を持ちようがないので prStatus を引かず null 固定。
    const pr =
      instance.branch !== null
        ? this.prStatus.findByProjectBranch(instance.projectId, instance.branch)
        : null
    const hasPrWaiting = pr !== null && pr.state === 'awaiting_review'

    const entries = sessions.map((session) => {
      const currentRunEvents = this.loadEventsForCurrentRun(session.id)
      return {
        status: this.deriver.deriveForSession(currentRunEvents, now, this.thresholds, hasPrWaiting),
        // 降順（received_at 新しい順）の先頭が直近イベント。イベント 0 件（理論上の縮退ケース。
        // 例: upsertStarted 後 events.append 前にプロセスがクラッシュし、イベントを一切持たない
        // session 行だけが残るケース）は session の起動時刻（startedAt）を使う。release-8 の
        // recency 優先化（instance-status-rollup.ts）は lastEventAt の値そのもので代表を選ぶため、
        // ここで `now`（呼び出しの都度更新される値）を使うと、このゼロイベント session が常に
        // 「最も新しい」と誤認され、他の実際に活動中の session を無条件に覆い隠してしまう
        // （release-8 review-changes で検出した回帰）。startedAt は固定の過去時刻なので、実際に
        // 新しいイベントを持つ他 session に正しく劣後する。
        lastEventAt: currentRunEvents[0]?.receivedAt ?? session.startedAt,
      }
    })
    const sessionStatuses = entries.map((entry) => entry.status)
    const representative = this.rollup.rollup(entries)
    const representativeSession = sessions[sessionStatuses.indexOf(representative)]

    const project = this.projects.findById(instance.projectId)
    const device = this.devices.findById(instance.deviceId)

    // ACTIVE ゲート（release-16 FR-02 line53 確定判断）: 代表 session が非 ACTIVE
    // （APPROVAL_WAIT/NEXT_WAIT/CLOSED）なら running_work は無条件で null とし、追加のイベント
    // 読み取りを一切行わない（既知課題 P3 の悪化防止）。承認待ち（APPROVAL_WAIT）中も
    // ここで null になる——line20（消灯は Stop/idle_prompt/SessionEnd のみ）と見かけ上矛盾するが、
    // line53 優先で確定済み（requirements.md 未解決事項の解消）。
    const runningWork =
      representative.rawState === 'ACTIVE'
        ? this.loadRunningWorkForCurrentRun(representativeSession.id)
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
      pr: toPrDto(pr),
      session: {
        id: representativeSession.id,
        last_heartbeat_at: this.formatHeartbeat(representativeSession),
        terminal: toTerminalDto(representativeSession.terminal),
      },
      running_work: toRunningWorkDto(runningWork),
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
   * session の現在の稼働区間（running work の区切り集合基準）を hub 権威時刻
   * （received_at）の新しい順にページングしながら走査し、「実行中の作業名」を選定する
   * （release-18 FR-04 導出規則）。呼び出し側（{@link buildRow}）が代表 session の
   * `StatusResult.rawState === 'ACTIVE'` のときだけ呼ぶ ACTIVE ゲートの内側であり、
   * 非 ACTIVE では呼ばれない（P3 悪化防止。この駆動ループ自体が呼ばれないので、以下の
   * 挙動は ACTIVE な instance にのみ影響する）。
   *
   * {@link loadEventsForCurrentRun} の姉妹メソッドで、同じ keyset ページング構造
   * （`EventRepository.recentPageForSession` + `STATUS_EVENT_PAGE_SIZE`）を流用するが、
   * 区切り判定は raw_state 境界（`scanForRunBoundary`）ではなく running work 専用の
   * 非対称な区切り集合（{@link scanForRunningWork} が定義。Workflow 候補は `SessionEnd`
   * のみ、fallback 候補は `Stop`/`Notification(idle_prompt)`/`SessionEnd`/
   * `UserPromptSubmit`）を使う。`loadEventsForCurrentRun` を再利用しない理由は、
   * raw_state 境界は `Notification(permission_prompt)`（`APPROVAL_WAIT`）でも区切ってしまうため、
   * 「Workflow 実行中 → 権限確認 → 承認 → 再開」のケースで承認前に投入された Workflow の
   * `PreToolUse` を取りこぼすこと（要件確定判断: ACTIVE ゲートが先に非 ACTIVE を弾くので、
   * この専用ローダ自身は permission_prompt を区切りにしない設計で正しい）。
   *
   * **駆動ループの終了条件（release-18 FR-04）**: `scanForRunningWork` が Workflow を確定した
   * 時点（最新＝降順走査の先頭側で確定するため、それ以上古いページを読む必要がない）、
   * `sessionEndFound`（`SessionEnd` 検出）、またはページ枯渇（`recentPageForSession` が空配列を
   * 返す／取得件数がページサイズ未満）——のいずれかでのみ打ち切る。fallback 側の区切り
   * （`Stop`/`UserPromptSubmit`/`idle_prompt`）だけがページ内に見つかった場合はページングを
   * 打ち切らず、`fallback`/`fallbackBoundaryReached` をキャリーして次の（より古い）ページの
   * 走査に進む——`SessionEnd` を送らない限り Workflow を探し続けるのが FR-04 の意図であり、
   * これが長時間 ACTIVE ランでの読み取り量増加（既知課題 P8、意図的に受容したトレードオフ）
   * の直接の原因になる。
   *
   * @param sessionId 対象 session（代表 session）の id。
   * @returns 導出した {@link RunningWork}。稼働区間内に該当イベントが無ければ null。
   */
  private loadRunningWorkForCurrentRun(sessionId: string): RunningWork | null {
    let fallback: RunningWork | null = null
    let fallbackBoundaryReached = false
    let cursor: EventPageCursor | undefined

    for (;;) {
      const page = this.events.recentPageForSession(sessionId, STATUS_EVENT_PAGE_SIZE, cursor)
      if (page.length === 0) break

      const scan = scanForRunningWork(page, fallback, fallbackBoundaryReached)
      if (scan.workflow !== null) {
        return scan.workflow
      }
      fallback = scan.fallback
      fallbackBoundaryReached = scan.fallbackBoundaryReached
      if (scan.sessionEndFound) {
        return fallback
      }

      if (page.length < STATUS_EVENT_PAGE_SIZE) break
      const last = page[page.length - 1]
      cursor = { receivedAt: last.receivedAt, id: last.id }
    }
    return fallback
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
