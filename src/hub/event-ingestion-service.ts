import type { DeviceRepository } from '../db/repositories/device-repository.js'
import type { NewEvent } from '../db/repositories/event-repository.js'
import type { EventRepository } from '../db/repositories/event-repository.js'
import type { InstanceRepository } from '../db/repositories/instance-repository.js'
import type { ProjectRepository } from '../db/repositories/project-repository.js'
import type { SessionRepository } from '../db/repositories/session-repository.js'
import type { Event, ProjectKey } from '../domain/entities.js'
import { ProjectKeyNormalizer } from '../domain/project-key-normalizer.js'
import { epochMsNow, type EpochMs } from '../domain/time.js'
import { parseIso8601ToEpochMs, rawEventPayloadSchema } from './dto.js'

/**
 * `SessionEnd` の `end_reason` が payload に無い場合の既定値（§7.3 の許容値の一つ）。
 */
const DEFAULT_END_REASON = 'other'

/**
 * {@link EventIngestionService.ingest} の結果。
 *
 * クラス図では戻り値 void だが、`append` と同様に採番済みイベントと解決済み ID を返して
 * 後続処理・統合テストが検証できるようにする（呼び出し側は無視してよい）。
 */
export interface IngestResult {
  /** 追記された（received_at 付与済みの）イベント。 */
  event: Event
  /** 正規化して解決した project の id。 */
  projectId: string
  /** 冪等に解決した instance の id。 */
  instanceId: string
  /** 冪等に解決した session の id（= payload の session_id）。 */
  sessionId: string
  /** 正規化済みの {@link ProjectKey}。 */
  projectKey: ProjectKey
}

/**
 * イベント受信・正規化・初出自動登録を束ねる UseCase（class-diagram §3 / §0.1 / §0.5）。
 *
 * `ingest` は信頼できない生ボディを zod で検証し、`ProjectKeyNormalizer` で正規化した上で
 * device / project / instance / session を冪等に解決（初出なら自動登録）し、hub 権威時刻
 * （`received_at = now()`）を付与して event を追記する。正規化・冪等制約は下位の
 * ドメインサービス／Repository に委譲し、本 UseCase はそれらのオーケストレーションに徹する。
 *
 * §0.3 の認証モデル上、リクエストは既登録 device としてしか認証できない（token は pairing /
 * bootstrap が device 行と共に発行する）。そのため `ingest` は device 行の新規作成は行わず、
 * 既存 device の `last_seen_at` を received_at で touch するに留め、未知の device_id は
 * 認証不変条件の破れとして扱う（呼び出し規約違反）。「初出自動登録」は payload が完全に
 * 記述できる project / instance / session に適用される。
 */
export class EventIngestionService {
  private readonly normalizer = new ProjectKeyNormalizer()

  /**
   * @param devices device Repository（`last_seen_at` の touch に使う）。
   * @param projects project Repository（正規化キーで findOrCreate）。
   * @param instances instance Repository（(device_id, path) で upsert）。
   * @param sessions session Repository（session_id で upsertStarted / markEnded）。
   * @param events event Repository（received_at 付与済みイベントの append）。
   * @param now hub 権威時刻の供給関数（received_at と device.last_seen_at に使う。
   *   テストで決定性を得るため注入可能。省略時は {@link epochMsNow}）。
   */
  constructor(
    private readonly devices: DeviceRepository,
    private readonly projects: ProjectRepository,
    private readonly instances: InstanceRepository,
    private readonly sessions: SessionRepository,
    private readonly events: EventRepository,
    private readonly now: () => EpochMs = epochMsNow
  ) {}

  /**
   * 1 件のイベントを受信・正規化して永続化する（§8.1）。
   *
   * 手順:
   * 1. zod で生ボディを検証する（不正なら {@link z.ZodError} を投げる）。
   * 2. device の `last_seen_at` を received_at で touch する（未登録なら投げる）。
   * 3. `remote_url`＋文脈を {@link ProjectKeyNormalizer} で正規化し project を findOrCreate。
   * 4. (device_id, path) で instance を upsert（branch は DO UPDATE）。
   * 5. session を upsertStarted（初出なら登録、既存は保存）。`SessionEnd`/`session_lost`
   *    なら `markEnded` も行う。`payload.terminal` が undefined/null でなければ
   *    `sessions.updateTerminal` でターミナル特定情報のスナップショットを上書きする
   *    （旧 reporter の欠落ペイロードで既存値を NULL 上書きしない、release-23 FR-02 AC-5）。
   * 6. `received_at = now()` を付与し event を append。
   *
   * @param rawPayload 信頼できない生リクエストボディ（§8.1）。
   * @returns 採番済みイベントと解決済み ID（{@link IngestResult}）。
   * @throws {z.ZodError} payload が {@link rawEventPayloadSchema} に適合しない場合。
   * @throws {Error} `device_id` が未登録の場合（§0.3 の認証不変条件の破れ）。
   */
  ingest(rawPayload: unknown): IngestResult {
    const payload = rawEventPayloadSchema.parse(rawPayload)
    const receivedAt = this.now()
    const occurredAt = parseIso8601ToEpochMs(payload.occurred_at)

    this.touchDevice(payload.device_id, receivedAt)

    const projectKey = this.normalizer.normalize(payload.instance.remote_url ?? null, {
      deviceId: payload.device_id,
      cwd: payload.instance.path,
      isGitRepo: payload.instance.is_git_repo,
      commonDir: payload.instance.common_dir ?? undefined,
    })
    const project = this.projects.findOrCreateByKey(projectKey)

    const instance = this.instances.upsert(
      project.id,
      payload.device_id,
      payload.instance.path,
      payload.instance.branch ?? null
    )

    this.sessions.upsertStarted(instance.id, payload.session_id, occurredAt)
    if (payload.terminal !== undefined && payload.terminal !== null) {
      this.sessions.updateTerminal(
        payload.session_id,
        {
          tty: payload.terminal.tty ?? null,
          termProgram: payload.terminal.term_program ?? null,
          tmuxPane: payload.terminal.tmux_pane ?? null,
          tmuxSocket: payload.terminal.tmux_socket ?? null,
          wslDistro: payload.terminal.wsl_distro ?? null,
          wtSession: payload.terminal.wt_session ?? null,
          weztermPane: payload.terminal.wezterm_pane ?? null,
        },
        receivedAt
      )
    }
    if (payload.event_type === 'SessionEnd') {
      this.sessions.markEnded(
        payload.session_id,
        payload.event_subtype ?? DEFAULT_END_REASON,
        occurredAt
      )
    } else if (payload.event_type === 'session_lost') {
      this.sessions.markEnded(payload.session_id, 'session_lost', occurredAt)
    }

    const newEvent: NewEvent = {
      sessionId: payload.session_id,
      instanceId: instance.id,
      eventType: payload.event_type,
      eventSubtype: payload.event_subtype ?? null,
      toolName: payload.tool_name ?? null,
      toolSummary: payload.tool_summary ?? null,
      occurredAt,
      receivedAt,
    }
    const event = this.events.append(newEvent)

    return {
      event,
      projectId: project.id,
      instanceId: instance.id,
      sessionId: payload.session_id,
      projectKey,
    }
  }

  /**
   * 既存 device の `last_seen_at` を received_at で更新する（`first_seen_at`/name/role は保存）。
   *
   * @param deviceId 認証済み device の id。
   * @param at received_at（hub 権威時刻）。
   * @throws {Error} device が未登録の場合（§0.3: 認証済み device は必ず存在する前提）。
   */
  private touchDevice(deviceId: string, at: EpochMs): void {
    const device = this.devices.findById(deviceId)
    if (device === null) {
      throw new Error(
        `EventIngestionService.ingest: unknown device_id "${deviceId}" (device must be registered via bootstrap/pairing before reporting, §0.3)`
      )
    }
    this.devices.upsert({ ...device, lastSeenAt: at })
  }
}
