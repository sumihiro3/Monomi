import { z } from 'zod'
import { EVENT_TYPES } from '../domain/enums.js'
import { type EpochMs, toEpochMs } from '../domain/time.js'
import type { RunningWork } from '../status/running-work-resolver.js'

/**
 * `POST /api/v1/events` の受信ペイロード（§8.1 リクエスト。§0.1/§0.5 反映）。
 *
 * §0.1 の通り reporter は **生の `git remote get-url origin` 出力**（`remote_url`）を
 * そのまま送り、正規化は hub 側の {@link ../domain/project-key-normalizer.js} が一手に担う
 * （project_key を reporter 側で組み立てない）。時刻は §0.5 の通り ISO8601(Z) 文字列で送り、
 * hub が受信時に epoch ms へ変換する。`device_id` は §0.3 により Bearer トークンから
 * 解決した値を **Controller が権威として充填する**前提で、body の値は信頼しない。
 */
export const rawEventPayloadSchema = z.object({
  /** レポート送信元 device の id（§0.3: Controller が Bearer トークン由来の値で上書きする）。 */
  device_id: z.string().min(1),
  /** エージェント側の session_id。 */
  session_id: z.string().min(1),
  instance: z.object({
    /** `git remote get-url origin` の生出力。remote が無い場合は null/省略（§0.1）。 */
    remote_url: z.string().nullable().optional(),
    /** git toplevel。非 git なら cwd そのもの（§7.1）。 */
    path: z.string().min(1),
    /** ブランチ名。非 git なら null（§7.3）。 */
    branch: z.string().nullable().optional(),
    /** 対象ディレクトリが git 作業ツリーか（正規化文脈。§0.1）。 */
    is_git_repo: z.boolean(),
    /** `git rev-parse --git-common-dir` 相当。remote 無し git の融合キーに使う（§0.1）。 */
    common_dir: z.string().nullable().optional(),
  }),
  /** Claude Code フック起因のイベント種別（§4/§7.3）。 */
  event_type: z.enum(EVENT_TYPES),
  /** 例: `Notification` の matcher（`idle_prompt`/`permission_prompt`）。 */
  event_subtype: z.string().nullable().optional(),
  /** `PreToolUse`/`PostToolUse` のみ。 */
  tool_name: z.string().nullable().optional(),
  /** 切り詰めた tool_input（ファイルパス/コマンド先頭）。 */
  tool_summary: z.string().nullable().optional(),
  /** イベント発生時刻。ISO8601(Z) 文字列（§0.5）。`Date.parse` で解釈できること。 */
  occurred_at: z.string().refine((s) => Number.isFinite(Date.parse(s)), {
    message: 'occurred_at must be an ISO 8601 datetime string (e.g. "2026-07-01T05:12:03Z")',
  }),
})

/**
 * {@link rawEventPayloadSchema} の検証済み形状（wire そのままの snake_case）。
 *
 * `EventIngestionService.ingest` は信頼できない生ボディ（`unknown`）を受け取り内部で
 * `parse` するため、本型は主にテスト・呼び出し側が正しいペイロードを組み立てるための
 * ドキュメントとして公開する。
 */
export type RawEventPayload = z.infer<typeof rawEventPayloadSchema>

/**
 * 導出済みステータス（§8.2 レスポンスの `status`）。
 *
 * `display`/`raw_state` は wire では小文字 snake（例 `approval_wait`）。§0.5 に従い
 * `priority`（数値優先度）も含め、CLI ロールアップは `max()` するだけで済むようにする。
 */
export interface StatusDto {
  /** 表示ステータス（小文字。`active`/`approval_wait`/`next_wait`/`pr_wait`/`stale`/`closed`）。 */
  display: string
  /** 内部状態（小文字。`active`/`approval_wait`/`next_wait`/`closed`）。 */
  raw_state: string
  /** 現 raw_state 連続区間の開始からの経過秒数（received_at 基準、§0.5）。 */
  elapsed_seconds: number
  /** 放置へ昇格したか（`display === 'stale'` と同義）。 */
  is_stale: boolean
  /** `display` の数値優先度（§5.2 / §0.5）。 */
  priority: number
}

/** PR レビュー状態（§8.2 の `pr`）。release-1 は poller 未実装のため常に `none`。 */
export interface PrDto {
  /** `none`/`awaiting_review`/`changes_requested`/`approved`/`merged`。 */
  state: string
}

/** 代表 session の要約（§8.2 の `session`）。 */
export interface SessionDto {
  /** session_id。 */
  id: string
  /** 最終ハートビート時刻（ISO8601）。release-1 は未更新のため常に null。 */
  last_heartbeat_at: string | null
}

/** project の参照（§8.2 の `project`）。 */
export interface ProjectRefDto {
  id: string
  name: string
}

/** device の参照（§8.2 の `device`）。 */
export interface DeviceRefDto {
  id: string
  name: string
}

/**
 * 一覧の 1 行（§8.2 `GET /api/v1/instances` の `instances[]` 要素）。
 *
 * hub は instance ごとに配下 session を rollup した代表ステータスを返す。project 単位の
 * ロールアップは CLI 側（`ClientRollup`）の関心事なのでここでは行わない（§5.3）。
 */
export interface InstanceStatusRow {
  instance_id: string
  project: ProjectRefDto
  device: DeviceRefDto
  path: string
  branch: string | null
  status: StatusDto
  pr: PrDto
  session: SessionDto
  running_work: RunningWorkDto | null
}

/**
 * 「実行中の作業名」の wire 表現（§8.4 の `running_work`、release-18 FR-05）。
 *
 * status レイヤーの {@link RunningWork} をそのまま wire DTO として露出していた設計
 * （既知課題 A6）を解消し、`StatusDto`/`StatusResult` と同じ「ドメイン型→薄い変換→wire DTO」の
 * パターンに揃える（{@link toRunningWorkDto}）。`started_at` は ISO8601(Z) 文字列（§0.5）で、
 * 旧 hub（release-16/17。`started_at` を含まない応答を返す）との混在時の後方互換のため
 * `null` を許容する（CLI 側は `null`/欠落のいずれでも「経過時間なし」の従来表示にフォールバックする）。
 */
export interface RunningWorkDto {
  kind: string
  name: string
  started_at: string | null
}

/**
 * status レイヤーの {@link RunningWork} を wire の {@link RunningWorkDto} へ写す
 * （`toStatusDto`（instance-status-service.ts）と同型の明示的変換ステップ、既知課題 A6 解消）。
 *
 * @param work 導出済みの running work（`null` 可）。
 * @returns wire 形の {@link RunningWorkDto}。`work` が `null` ならそのまま `null`。
 */
export function toRunningWorkDto(work: RunningWork | null): RunningWorkDto | null {
  if (work === null) {
    return null
  }
  return {
    kind: work.kind,
    name: work.name,
    started_at: epochMsToIso8601(work.startedAt),
  }
}

/** 直近イベント 1 件（§10.4 Agent View Lv.1 の生ログ）。 */
export interface RecentEventDto {
  /** イベント行の id（`events.id`、autoincrement）。CLI 側の React key 安定化に使う。 */
  id: number
  event_type: string
  event_subtype: string | null
  tool_name: string | null
  tool_summary: string | null
  /** クライアント時刻（ISO8601）。 */
  occurred_at: string
  /** hub 受信時刻（ISO8601、§0.5）。 */
  received_at: string
}

/**
 * 詳細（§8.2 `GET /api/v1/instances/:id`）。一覧 1 行に直近イベント列を足したもの。
 */
export interface InstanceDetail extends InstanceStatusRow {
  /** 直近イベント（新しい順、Agent View Lv.1）。 */
  recent_events: RecentEventDto[]
}

/**
 * device 一覧の 1 行（§9 `GET /api/v1/devices` の `devices[]` 要素、FR-03 AC-1）。
 *
 * wire は snake_case・小文字 role（config/DDL の `hub`/`child` 語彙に合わせる）。時刻は §7.2 の
 * 通り内部 epoch ms を API 応答時に ISO8601(Z) へ変換して返す。`has_active_token` は当該 device に
 * 未 revoke のトークンが1つ以上あるか（`devices revoke` 済みかを一覧で判別するための表示用フラグ）。
 */
export interface DeviceDto {
  /** device_id（§7.3 devices.id）。 */
  id: string
  /** 表示名（§7.3 devices.name）。 */
  name: string
  /** 役割（wire は小文字 `hub`/`child`）。 */
  role: string
  /** 初回登録時刻（ISO8601）。 */
  first_seen_at: string
  /** 最終観測時刻（ISO8601）。 */
  last_seen_at: string
  /** 有効トークンを1つ以上持つか（false なら revoke 済み or 未発行）。 */
  has_active_token: boolean
}

/** `GET /api/v1/devices` のレスポンスエンベロープ（§9 / FR-03 AC-1）。 */
export interface DevicesEnvelope {
  devices: DeviceDto[]
}

/** `POST /api/v1/devices/:id/revoke` のレスポンス（§9 / FR-03 AC-2）。 */
export interface DeviceRevokeResult {
  ok: boolean
  /** 失効対象の device_id。 */
  device_id: string
  /** 実際に失効させたトークン数（既に全失効済みなら 0）。 */
  revoked: number
}

/**
 * `POST /api/v1/pair/claim` の受信ペイロード（§9 / FR-02 AC-3）。
 *
 * ペアリングは**トークン発行前**の未認証経路なので、child は自身の `device_id` と
 * `name`（hostname）を body で申告する。§0.3 の「body の `device_id` を無視して Bearer 由来値で
 * 上書き」は認証済みの書き込み経路（`/events`）の話であり、まだトークンを持たないペアリングには
 * 当てはまらない（このペイロードの `device_id` こそが登録される child の id になる）。role は
 * hub 側で常に `CHILD` 固定にする（hub 同士のペアリングは v1 スコープ外）。
 */
export const pairClaimPayloadSchema = z.object({
  /** hub が発行した 6 桁コード（照合対象）。 */
  code: z.string().min(1),
  /**
   * 登録する child の device_id（child が自機の値を申告）。
   *
   * 申告値はクライアントがそのまま送るため {@link ../domain/device-id.js deriveDeviceId} の
   * ような正規化はせず、文字種（英数字・`_`・`.`・`-`）と最大長のみを制約する（#9）。
   */
  device_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/),
  /** child の表示名（hostname 相当）。 */
  name: z.string().min(1).max(128),
})

/** {@link pairClaimPayloadSchema} の検証済み形状（wire そのままの snake_case）。 */
export type PairClaimPayload = z.infer<typeof pairClaimPayloadSchema>

/**
 * `POST /api/v1/pair/start` の応答（loopback 限定、§9 / FR-02 AC-1/AC-2）。
 *
 * `code` は hub CLI がユーザーへ表示する平文の 6 桁コード。時刻は §7.2 の通り内部 epoch ms を
 * ISO8601(Z) へ変換して返す。`ttl_seconds` は失効までの残り秒数（表示補助）。
 */
export interface PairStartResponse {
  /** 発行した 6 桁コード（平文）。 */
  code: string
  /** コード失効時刻（ISO8601）。 */
  expires_at: string
  /** 失効までの秒数（表示補助、既定 300 = 5 分）。 */
  ttl_seconds: number
}

/**
 * `POST /api/v1/pair/claim` 成功時の応答（token + 設定、§9 / FR-02 AC-3）。
 *
 * child はこの `token` を `config.yml` に保存して以降の Bearer 認証に使う（生値は一度だけ返す）。
 */
export interface PairClaimResponse {
  /** child が保存する device_token（生値）。 */
  token: string
  /** 登録された device_id（申告値）。 */
  device_id: string
  /** 割り当てられた役割（wire は小文字。常に `child`）。 */
  role: string
}

/**
 * ISO8601 文字列を epoch ミリ秒へ変換する（§0.5: wire は ISO8601、内部は epoch ms）。
 *
 * @param iso ISO8601(Z) 文字列。
 * @returns epoch ミリ秒（{@link EpochMs}）。
 * @throws {Error} `Date.parse` が解釈できない場合。
 */
export function parseIso8601ToEpochMs(iso: string): EpochMs {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid ISO 8601 datetime: "${iso}"`)
  }
  return toEpochMs(ms)
}

/**
 * epoch ミリ秒を ISO8601(Z) 文字列へ変換する（API 応答用、§7.2）。
 *
 * @param ms epoch ミリ秒。
 * @returns `Date#toISOString` 形式の文字列。
 */
export function epochMsToIso8601(ms: EpochMs): string {
  return new Date(ms).toISOString()
}

/**
 * ドメインの大文字 enum（`APPROVAL_WAIT` 等）を wire の小文字表現へ写す。
 *
 * `RawState` / `DisplayStatus` / `RepresentedStatus` はいずれも `SCREAMING_SNAKE_CASE`
 * なので `toLowerCase()` で §8.2 の wire 表現（`approval_wait` 等）に一致する。
 *
 * @param status 大文字のステータス列挙値。
 * @returns 小文字表現。
 */
export function toWireStatus(status: string): string {
  return status.toLowerCase()
}

/**
 * `project_key`（value）から表示名を自動生成する（§7.3: display_name 未設定時）。
 *
 * `host/owner/repo` 形式・`local:{device}:{path}`・`nogit:{device}:{cwd}` のいずれも
 * 末尾のスラッシュ区切りセグメント（≒ リポジトリ名 / ディレクトリ名）を採る。
 * 例 `github.com/sumihiro/ProjectLens` → `ProjectLens`。
 *
 * @param projectKeyValue 正規化済みの project_key 文字列。
 * @returns 表示名。
 */
export function deriveProjectName(projectKeyValue: string): string {
  const segments = projectKeyValue.split('/').filter((s) => s.length > 0)
  const last = segments[segments.length - 1]
  return last && last.length > 0 ? last : projectKeyValue
}
