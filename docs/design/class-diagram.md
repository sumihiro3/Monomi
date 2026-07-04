# Monomi v1 — クラス図

[`ARCHITECTURE.md`](../ARCHITECTURE.md)（現状スナップショット）に対応する実装クラス図。release-1〜11 の実装（`src/`）を反映した現況を、レイヤーごとに 4 枚のクラス図＋責任分解表へ分ける（命名・型はレイヤー間およびソースと一貫させる）。命名の変遷など凍結済みの設計経緯は `monomi-handoff.md` を参照。

**方針**: 独自ロジックが複雑になる箇所（project_key 正規化・status 導出）は god class にせず、責務ごとに値オブジェクト／ドメインサービス／モジュール関数へ分解する。Hub API は Controller（薄い）→ UseCase/Service（業務ロジック）→ Repository（永続化）の 3 層に分離し、Controller に業務ロジックを書かない。CLI は表示・入力処理に専念し、状態導出ロジックを一切持たない。エンティティ・DTO・状態は TS の `interface`／判別ユニオンで表し、振る舞いは別のドメインサービス・モジュール関数に置く（データと振る舞いの分離）。

> 図中の `<<module (foo.ts)>>` はクラスではなく当該ファイルが公開するモジュール関数群を表す（`$` は静的／モジュールレベルの目印）。`class Foo~T~` はジェネリック（`Foo<T>`）を意味する。

---

## 1. ドメインモデル（共有の土台）

```mermaid
classDiagram
  class ProjectKey {
    <<interface (value object)>>
    +string value
    +ProjectKeyKind kind
  }
  class ProjectKeyOps {
    <<module (project-key.ts)>>
    +createProjectKey(value: string, kind: ProjectKeyKind) ProjectKey$
    +inferProjectKeyKind(value: string) ProjectKeyKind$
    +projectKeyEquals(a: ProjectKey, b: ProjectKey) bool$
  }
  class ProjectKeyKind {
    <<enumeration>>
    GIT_REMOTE
    LOCAL_NO_REMOTE
    NO_GIT
  }
  class ProjectKeyNormalizer {
    <<domain service>>
    +normalize(rawRemoteUrl: string|null, ctx: NormalizeContext) ProjectKey
    -stripSchemeAndAuth(url: string) string
    -toHostOwnerRepo(hostAndPath: string) string
  }
  class NormalizeContext {
    <<interface (value object)>>
    +string deviceId
    +string cwd
    +bool isGitRepo
    +string commonDir
  }
  class DeviceId {
    <<module (device-id.ts)>>
    +deriveDeviceId(hostname: string) string$
    +FALLBACK_DEVICE_ID
  }
  class Device {
    <<entity>>
    +string id
    +string name
    +DeviceRole role
    +EpochMs firstSeenAt
    +EpochMs lastSeenAt
  }
  class DeviceRole {
    <<enumeration>>
    HUB
    CHILD
  }
  class Project {
    <<entity>>
    +string id
    +ProjectKey projectKey
    +string displayName
    +EpochMs createdAt
  }
  class Instance {
    <<entity>>
    +string id
    +string projectId
    +string deviceId
    +string path
    +string branch
    +EpochMs createdAt
    +EpochMs removedAt
  }
  class Session {
    <<entity>>
    +string id
    +string instanceId
    +string agentType
    +int pid
    +EpochMs startedAt
    +EpochMs endedAt
    +string endReason
    +EpochMs lastHeartbeatAt
  }
  class Event {
    <<entity>>
    +int id
    +string sessionId
    +string instanceId
    +EventType eventType
    +string eventSubtype
    +string toolName
    +string toolSummary
    +EpochMs occurredAt
    +EpochMs receivedAt
  }
  class EventType {
    <<enumeration>>
    SessionStart
    UserPromptSubmit
    PreToolUse
    PostToolUse
    Notification
    Stop
    SessionEnd
    WorktreeCreate
    WorktreeRemove
    session_lost
  }
  class DeviceToken {
    <<entity>>
    +int id
    +string deviceId
    +string tokenHash
    +EpochMs createdAt
    +EpochMs revokedAt
  }
  class PrStatus {
    <<entity>>
    +int id
    +string projectId
    +string branch
    +int prNumber
    +string state
    +string url
    +EpochMs checkedAt
  }
  class EpochMs {
    <<branded number (time.ts)>>
  }
  class DurationMs {
    <<branded number (time.ts)>>
  }

  ProjectKeyNormalizer ..> ProjectKey : creates
  ProjectKeyNormalizer ..> NormalizeContext : uses
  ProjectKeyOps ..> ProjectKey : creates/compares
  ProjectKey --> ProjectKeyKind
  Project --* ProjectKey : has
  Instance --> Project : projectId
  Instance --> Device : deviceId
  Session --> Instance : instanceId
  Event --> Session : sessionId
  Event --> EventType
  Device --> DeviceRole
  DeviceToken --> Device : deviceId
  PrStatus --> Project : projectId
```

**責務**: `ProjectKeyNormalizer` が正規化ロジック（scheme/認証除去 → host 小文字化 → 末尾 `.git` 除去 → `host/owner/repo` 固定、scp 形式/URL 形式両対応、非 remote/非 git は `local:{device_id}:...`/`nogit:{device_id}:...`）を一手に引き受ける（`ARCHITECTURE.md` §11）。エンティティ（`Device`〜`PrStatus`）は `src/domain/entities.ts` の TS `interface`（データのみ）で、`ProjectKey` の生成・比較・種別判定は `src/domain/project-key.ts` の関数（`ProjectKeyOps`）へ、device_id 派生は `src/domain/device-id.ts`（`DeviceId`）へ分ける。`EpochMs`/`DurationMs` は `src/domain/time.ts` のブランド型（数値の取り違え防止）。

> **null 許容フィールド**（TS の `| null`）: `Project.displayName`・`Instance.branch`/`removedAt`・`Session.pid`/`endedAt`/`endReason`/`lastHeartbeatAt`・`Event.eventSubtype`/`toolName`/`toolSummary`・`DeviceToken.revokedAt`・`PrStatus.prNumber`/`url`。図では簡潔さのため型に併記していない。token の失効判定は列挙メソッドではなく `revokedAt`（＋ hub 側 `TokenService`）で行う。

---

## 2. Status 導出エンジン（最も複雑なロジック。責務ごとに分解）

```mermaid
classDiagram
  class RawState {
    <<enumeration>>
    ACTIVE
    APPROVAL_WAIT
    NEXT_WAIT
    CLOSED
  }
  class DisplayStatus {
    <<enumeration>>
    ACTIVE
    APPROVAL_WAIT
    NEXT_WAIT
    PR_WAIT
    STALE
  }
  class RepresentedStatus {
    <<type alias>>
    DisplayStatus_or_CLOSED
  }
  class RawStateRules {
    <<module (raw-state-resolver.ts)>>
    +rawStateOf(event: Event) RawState
    +collectStateBearingDescending(events: Event[]) Event[]
    +compareByReceivedThenId(a: Event, b: Event) int
  }
  class RawStateResolver {
    <<domain service>>
    +resolve(events: Event[]) RawState
  }
  class StateTransition {
    <<interface (value object)>>
    +RawState rawState
    +EpochMs transitionedAt
  }
  class StateTransitionFinder {
    <<domain service>>
    +find(events: Event[], currentState: RawState) StateTransition
  }
  class RunBoundaryScanner {
    <<module (run-boundary-scanner.ts)>>
    +scanForRunBoundary(page: Event[], currentState: RawState|null) RunBoundaryScanResult$
  }
  class RunBoundaryScanResult {
    <<interface>>
    +bool boundaryFound
    +RawState state
  }
  class EscalationThresholdValues {
    <<interface (value object)>>
    +DurationMs active
    +DurationMs approvalWait
    +DurationMs nextWait
    +DurationMs prWait
  }
  class EscalationThresholds {
    <<value object (class)>>
    +DurationMs active
    +DurationMs approvalWait
    +DurationMs nextWait
    +DurationMs prWait
    +withDefaults(overrides: Partial~EscalationThresholdValues~) EscalationThresholds$
    +forState(rawState: RawState) DurationMs
  }
  class EscalationPolicy {
    <<domain service>>
    +classify(transition: StateTransition, now: EpochMs, thresholds: EscalationThresholds, hasPrWaiting: bool) RepresentedStatus
  }
  class StatusPriority {
    <<domain service>>
    +priorityOf(display: RepresentedStatus) int
    +higherOf(a: StatusResult, b: StatusResult) StatusResult
  }
  class StatusResult {
    <<interface (value object)>>
    +RawState rawState
    +RepresentedStatus display
    +DurationMs elapsedMs
    +bool isStale
    +int priority
  }
  class StatusDeriver {
    <<domain service (orchestrator)>>
    +deriveForSession(events: Event[], now: EpochMs, thresholds: EscalationThresholds, hasPrWaiting: bool) StatusResult
  }
  class InstanceStatusRollup {
    <<domain service>>
    +rollup(entries: RollupEntry[]) StatusResult
  }
  class RollupEntry {
    <<interface (value object), release-7>>
    +StatusResult status
    +EpochMs lastEventAt
  }

  RawStateResolver ..> RawStateRules : rawStateOf
  StateTransitionFinder ..> RawStateRules : rawStateOf
  StateTransitionFinder ..> StateTransition : produces
  RunBoundaryScanner ..> RawStateRules : rawStateOf
  RunBoundaryScanner ..> RunBoundaryScanResult : produces
  StatusDeriver ..> RawStateRules : collectStateBearingDescending
  StatusDeriver ..> RawStateResolver : uses
  StatusDeriver ..> StateTransitionFinder : uses
  StatusDeriver ..> EscalationPolicy : uses
  StatusDeriver ..> StatusResult : produces
  EscalationPolicy ..> EscalationThresholds : uses
  EscalationPolicy ..> StateTransition : uses
  EscalationPolicy ..> RepresentedStatus : produces
  EscalationThresholds ..> EscalationThresholdValues : from
  RawStateResolver ..> RawState : produces
  StatusResult ..> RepresentedStatus
  StatusPriority ..> StatusResult : compares
  InstanceStatusRollup ..> StatusPriority : uses (tie-break only)
  InstanceStatusRollup ..> RollupEntry : uses (recency selection)
  InstanceStatusRollup ..> StatusResult
  RollupEntry ..> StatusResult : wraps
```

**分解の理由**（`ARCHITECTURE.md` §5）:

- `RawStateRules`（`raw-state-resolver.ts` のモジュール関数）: `rawStateOf` が 1 イベント → `raw_state` の写像（`Notification(permission_prompt)→APPROVAL_WAIT`、`Notification(idle_prompt)/Stop→NEXT_WAIT`、`SessionStart/UserPromptSubmit/Pre|PostToolUse→ACTIVE`、`SessionEnd/session_lost→CLOSED`、状態を持たないイベントは `null`）を担う唯一の場所。`collectStateBearingDescending` は状態を持つイベントだけを `received_at` 降順で 1 度だけ抽出し、resolver/finder が同じ配列を共有できるようにする（同一列の重複フルスキャンを集約）。hub レイヤーはこの写像規則を直接 import せず、公開ヘルパー越しにのみ触る。
- `RawStateResolver`: 降順入力の先頭（最新）の `raw_state` を返すだけの薄いラッパ。
- `StateTransitionFinder`: 「現在の raw_state 連続区間の最初のイベント時刻」を探す責務だけを持つ。放置時計が idle 複数発火でリセットされない要件はここに閉じる（`createStateTransition` で凍結した `StateTransition` を返す）。
- `RunBoundaryScanner`（`scanForRunBoundary`）: `received_at` 降順の 1 ページを走査し、現区間と異なる `raw_state` に当たった時点で境界検出を返す。hub の `InstanceStatusService.loadEventsForCurrentRun` がページングを打ち切る判断に使う（全イベント読み込みを避ける最適化）。
- `EscalationThresholdValues` / `EscalationThresholds`: 前者は raw_state 別の放置昇格閾値を持つプレーンな値、後者は凍結クラス（`DEFAULT_ESCALATION_THRESHOLDS` = 2h/6h/24h/72h を `withDefaults` で補完、`forState` で raw_state 別に引ける。`CLOSED` は閾値を持たず例外）。既定値・config 上書きは hub 起動時（`serve`）に注入する。
- `EscalationPolicy`: 上記と遷移時刻から「放置（STALE）へ昇格したか」を判定するだけ。PR 待ちは `raw_state ≠ ACTIVE`（＝待機系）かつ `hasPrWaiting` の時のみ `PR_WAIT`、という分岐もここに閉じ、結果は `RepresentedStatus` を返す。
- `StatusPriority`: 表示ステータスの優先順位を数値化する唯一の場所（`STATUS_PRIORITY`: `CLOSED 0 < ACTIVE 1 < NEXT_WAIT 2 < PR_WAIT 3 < APPROVAL_WAIT 4 < STALE 5`）。`higherOf` は `{ priority, elapsedMs }` を持つ任意型に対するジェネリック比較で、同優先度は経過が長い方を採る。優先順位の定数は CLI 側で二重管理しない。
- `StatusResult`: 1 session/instance の最終ステータス（`interface`）。`createStatusResult` が `priority` を `STATUS_PRIORITY[display]` から埋めて凍結する。
- `StatusDeriver`: `resolver`/`finder`/`policy` を内部に持ち、状態イベントの抽出→ raw_state 判定→遷移時刻→分類→ `StatusResult` 生成を束ねる薄いオーケストレーター。状態を持つイベントが 0 件なら「稼働中・0 経過」に縮退させる。
- `InstanceStatusRollup`: 1 instance 配下の複数 `RollupEntry`（`StatusResult` ＋ 該当 session の直近イベント時刻 `lastEventAt`）から代表 `StatusResult` を選ぶ。release-8 FR-02（B8 対応）で完全 recency 優先へ変更: まず `CLOSED` を、他に live（非 closed）な session が instance 内に 1 つでもあれば `lastEventAt` の新旧に関わらず候補から除外する（§0.5「closed が active を覆い隠さない」不変条件の維持。全 session が closed の場合のみ closed 自身が候補に残る）。残った候補のうち最も新しい `lastEventAt` を持つ session を無条件に代表とし、複数候補が完全同一の `lastEventAt` を持つ場合のみ `StatusPriority.higherOf` でタイブレークする。release-7 FR-01 で導入した「instance 内の最新 `lastEventAt` から 15 分（`STALE_SESSION_THRESHOLD_MS`）以上離れた session を孤立 session として事前除外する」ロジックは release-8 で完全に削除された（recency 優先の下では候補の事前フィルタリングが結果に影響しないため）。`RollupEntry` の組み立て（`lastEventAt` に `loadEventsForCurrentRun` 先頭の `receivedAt` を採用）は呼び出し元の `InstanceStatusService.buildRow` が担う。

---

## 3. Hub API（Controller → UseCase → Repository の 3 層）

```mermaid
classDiagram
  class DeviceRepository {
    <<repository>>
    +upsert(device: Device) Device
    +findById(id: string) Device
    +list() Device[]
  }
  class ProjectRepository {
    <<repository>>
    +findOrCreateByKey(key: ProjectKey) Project
    +findById(id: string) Project
    +findByKey(key: string) Project
  }
  class InstanceRepository {
    <<repository>>
    +upsert(projectId: string, deviceId: string, path: string, branch: string|null) Instance
    +findById(id: string) Instance
    +findByDeviceAndPath(deviceId: string, path: string) Instance
    +listActive() Instance[]
    +markRemoved(id: string, at: EpochMs) void
  }
  class SessionRepository {
    <<repository>>
    +upsertStarted(instanceId: string, sessionId: string, startedAt: EpochMs) Session
    +markEnded(sessionId: string, reason: string, at: EpochMs) void
    +findById(id: string) Session
    +listByInstance(instanceId: string) Session[]
  }
  class EventRepository {
    <<repository>>
    +append(event: NewEvent) Event
    +allForSession(sessionId: string) Event[]
    +recentForInstance(instanceId: string, limit: int) Event[]
    +recentPageForSession(sessionId: string, limit: int, cursor: EventPageCursor) Event[]
  }
  class TokenRepository {
    <<repository>>
    +findByHash(hash: string) DeviceToken
    +findByDeviceId(deviceId: string) DeviceToken[]
    +create(deviceId: string, hash: string) DeviceToken
    +revoke(id: int, at: EpochMs) void
    +revokeByDeviceId(deviceId: string, at: EpochMs) int
    +listDeviceIdsWithActiveToken() string[]
  }
  class PrStatusRepository {
    <<repository>>
    +findByProjectBranch(projectId: string, branch: string) PrStatus
    +upsert(status: NewPrStatus) PrStatus
  }

  class EventIngestionService {
    <<use case>>
    +ingest(rawPayload: unknown) IngestResult
    -touchDevice(deviceId: string, at: EpochMs) void
  }
  class InstanceStatusService {
    <<use case>>
    +listInstances(now: EpochMs) InstanceStatusRow[]
    +getInstanceDetail(id: string, now: EpochMs) InstanceDetail
    -buildRow(instance: Instance, now: EpochMs) InstanceStatusRow
    -loadEventsForCurrentRun(sessionId: string) Event[]
  }
  class TokenService {
    <<domain service>>
    +issue(deviceId: string) string
    +verify(rawToken: string) Device
    +revoke(tokenId: int) void
    +hasActiveToken(deviceId: string) bool
    +activeDeviceIds() Set
    +revokeAllForDevice(deviceId: string) int
    -hash(rawToken: string) string
  }
  class PairingService {
    <<domain service>>
    +startPairing() PairingCode
    +claim(code: string, device: PairingClaimDeviceInfo) PairingClaimResult
    -registerFailure(now: EpochMs) void
  }
  class AuthResolver {
    <<middleware>>
    +resolveDevice(request: AuthResolvableRequest) Device
  }
  class Loopback {
    <<module (loopback.ts)>>
    +isLoopbackAddress(address: string|null) bool$
  }

  class HttpServer {
    <<infrastructure>>
    +listen(port: int, host: string) Promise
    +address() AddressInfo
    +close() Promise
  }
  class createHubServer {
    <<factory>>
    +createHubServer(db: Database, options: HubServerOptions) HttpServer$
  }
  class Router {
    <<infrastructure>>
    +add(method: string, pattern: string, handler, options) Router
    +match(method: string, path: string) RouteMatch
  }
  class EventsController {
    <<controller>>
    +handlePost(req: HubRequest) HubResponse
  }
  class InstancesController {
    <<controller>>
    +handleList(req: HubRequest) HubResponse
    +handleDetail(req: HubRequest) HubResponse
  }
  class PairController {
    <<controller>>
    +handleStart(req: PublicHubRequest) HubResponse
    +handleClaim(req: PublicHubRequest) HubResponse
  }
  class DevicesController {
    <<controller>>
    +handleList(req: HubRequest) HubResponse
    +handleRevoke(req: HubRequest) HubResponse
    -requireLoopback(req: HubRequest) HubResponse
  }

  EventIngestionService ..> ProjectKeyNormalizer : uses
  EventIngestionService ..> DeviceRepository
  EventIngestionService ..> ProjectRepository
  EventIngestionService ..> InstanceRepository
  EventIngestionService ..> SessionRepository
  EventIngestionService ..> EventRepository

  InstanceStatusService ..> InstanceRepository
  InstanceStatusService ..> SessionRepository
  InstanceStatusService ..> EventRepository
  InstanceStatusService ..> ProjectRepository
  InstanceStatusService ..> DeviceRepository
  InstanceStatusService ..> PrStatusRepository
  InstanceStatusService ..> StatusDeriver
  InstanceStatusService ..> InstanceStatusRollup
  InstanceStatusService ..> RunBoundaryScanner : loadEventsForCurrentRun

  TokenService ..> TokenRepository
  TokenService ..> DeviceRepository
  PairingService ..> TokenService
  PairingService ..> DeviceRepository
  AuthResolver ..> TokenService

  EventsController ..> EventIngestionService
  InstancesController ..> InstanceStatusService
  PairController ..> PairingService
  PairController ..> Loopback : handleStart loopback guard
  DevicesController ..> DeviceRepository
  DevicesController ..> TokenService
  DevicesController ..> Loopback : requireLoopback

  createHubServer ..> Router : wires
  createHubServer ..> HttpServer : builds
  createHubServer ..> AuthResolver
  HttpServer ..> Router : matches
  HttpServer ..> AuthResolver : auth gate (non-public routes)
  Router ..> EventsController
  Router ..> InstancesController
  Router ..> DevicesController
  Router ..> PairController
```

**責務分離**:

- **配線** は `createHubServer`（factory）が担い、Repository → Service → Controller → `Router` を組んで `HttpServer` を返す。閾値（`EscalationThresholds`）と権威時刻（`now`）はここで注入する。
- **認証は `HttpServer` 前段の 1 箇所**で全ルートに適用する（`AuthResolver` で Bearer token → device 解決、無効/失効は 401）。`{ public: true }` の `pair/start`/`pair/claim` だけ認証をスキップし `device: null` で通す。Controller は認証済みリクエストのみを受け取り、個別に `AuthResolver` を持たない（旧図の per-controller 依存は解消）。
- **loopback ガード**は `src/hub/loopback.ts`（`Loopback`）に集約し、`PairController.handleStart`（コード発行を localhost 限定）と `DevicesController`（device 管理を Bearer 認証に上乗せで localhost 限定）が共有する。Controller 間の直 import を避けるための hub 直下モジュール。
- **UseCase**（`EventIngestionService` / `InstanceStatusService`）が複数リポジトリ・ドメインサービスを束ねる。`EventIngestionService` は「reporter は生 remote を送り hub が正規化」「初出自動登録の冪等性」をここで実現する。`InstanceStatusService` は `StatusDeriver`/`InstanceStatusRollup` で状態を導出し、`RunBoundaryScanner` 経由でイベントページングを現在 run 分に絞る。
- **Repository** は SQL とスキーマ制約（`ARCHITECTURE.md` §7.3 ＋ `tokens` テーブル）にのみ責任を持つ。イベントは `NewEvent`、PR は `NewPrStatus` を受けて採番済みエンティティを返す。ハートビートは専用ルートを持たず、`POST /api/v1/events`（ハートビート系イベント）として ingest 経路に集約する（旧図の `HeartbeatController` は存在しない）。
- **TokenService / PairingService** を分離し、「token のハッシュ化（SHA-256）・検証・（device 単位の一括）revoke・有効 device 集合の列挙」と「6 桁コードの発行・TTL・失敗カウント・claim 時の device 競合判定」を別の責務として扱う。
- **wire DTO**（`src/hub/dto.ts`）: `InstanceStatusRow`／`InstanceDetail`（`InstanceStatusRow` を継承し `recent_events[]` を追加）／`DeviceDto`／`PairStartResponse`／`PairClaimPayload`・`PairClaimResponse` など。時刻の ISO8601 ⇄ epoch ms 変換（`parseIso8601ToEpochMs`/`epochMsToIso8601`）と表示状態の小文字化（`toWireStatus`）は Controller/DTO 境界で行う。

---

## 4. CLI（Ink。ビジネスロジックを持ち込まない）

```mermaid
classDiagram
  class HubEndpoint {
    <<interface (value object)>>
    +string host
    +int port
    +string label
  }
  class HubEndpointResolver {
    <<domain service>>
    +resolveReachable(endpoints: HubEndpoint[], options: ResolveReachableOptions) HubEndpoint
    -isReachable(endpoint: HubEndpoint, fetchImpl, probePath, timeoutMs) bool
  }
  class HubEndpointOps {
    <<module (hub-endpoint-resolver.ts)>>
    +endpointBaseUrl(endpoint: HubEndpoint) string$
    +localhostEndpoint(port: int) HubEndpoint$
    +parseHubEndpoint(rawUrl: string, defaultPort: int) HubEndpoint$
  }
  class Network {
    <<module (network.ts)>>
    +isTailscaleIpv4(address: string) bool$
    +detectReachableHosts(options: NetworkDetectOptions) NetworkCandidate[]$
    +buildCandidateUrls(port: int, options: NetworkDetectOptions) string[]$
  }
  class NetworkCandidate {
    <<interface>>
    +string host
    +tailscale_or_lan label
  }
  class HubApiClient {
    <<infrastructure>>
    +listInstances() InstanceStatusRow[]
    +getInstanceDetail(id: string) InstanceDetail
    +listDevices() DeviceDto[]
    +revokeDevice(id: string) DeviceRevokeResult
    +pairStart() PairStartResponse
    +pairClaim(payload: PairClaimPayload) PairClaimResponse
  }
  class HubConnection {
    <<interface>>
    +HubApiClient client
    +reresolve() HubApiClient
  }
  class createHubConnection {
    <<factory (hub-api-client.ts)>>
    +createHubApiClient(paths, options) HubApiClient$
    +createHubConnection(paths, options) HubConnection$
  }
  class PollingLoop~T~ {
    <<application service>>
    -bool inFlight
    -HubApiClient client
    +onUpdate(listener: UpdateListener~T~) void
    +onError(listener: ErrorListener) void
    +refresh() Promise
    +start(intervalMs: int) void
    +stop() void
    +isRunning() bool
  }
  class ClientRollup {
    <<utility>>
    +rollupByProject(instances: InstanceStatusRow[]) ProjectRow[]
  }
  class InstanceListStore {
    <<application state>>
    +instances() InstanceStatusRow[]
    +activeFilters() StatusFilter[]
    +setInstances(rows: InstanceStatusRow[]) void
    +setFilter(filters: StatusFilter[]) void
    +toggleFilter(filter: StatusFilter) void
    +clearFilters() void
    +filtered() InstanceStatusRow[]
    +projectRows() ProjectRow[]
  }
  class StatusDisplay {
    <<module (status-display.ts)>>
    +statusLabel(display: string) string$
    +statusColor(display: string) string$
    +statusGlyph(display: string) string$
    +filterForKey(input: string) StatusFilter$
    +formatAge(seconds: int) string$
    +FILTER_ORDER StatusFilter[]$
  }
  class I18n {
    <<module (i18n/index.ts, release-9)>>
    +t(key: TranslationKey, vars: VarsRecord) string$
    +setActiveLocale(locale: MonomiLocale) void$
    +getActiveLocale() MonomiLocale$
    +resolveLocale(locale: MonomiLocale) MonomiLocale$
  }
  class ViewMode {
    <<type alias>>
    list_or_detail
  }
  class KeyFlags {
    <<interface>>
    +bool upArrow
    +bool downArrow
    +bool leftArrow
    +bool rightArrow
    +bool return
    +bool escape
  }
  class KeyBindingHost {
    <<interface>>
    +moveSelection(delta: int) void
    +openDetail() void
    +back() void
    +toggleHelp() void
    +moveProject(delta: int) void
    +quit() void
  }
  class KeyBindingController {
    <<controller>>
    +handleKey(input: string, key: KeyFlags, viewMode: ViewMode) void
  }
  class ConfigWriter {
    <<module (config/config-writer.ts)>>
    +writeChildPairingConfig(configFile: string, config: ChildPairingConfig) void$
  }
  class PairingClient {
    <<module (pairing-client.ts)>>
    +runHubPair(deps: HubPairDeps) Promise
    +runChildPair(options: ChildPairOptions, deps: ChildPairDeps) Promise
    +normalizeEndpointUrl(input: string, defaultPort: int) string$
  }
  class AppView {
    <<ui component (container)>>
  }
  class WatchingIndicator {
    <<ui component (presentational, release-10 FR-02)>>
  }
  class InstanceTable {
    <<ui component (grid container)>>
  }
  class InstanceCard {
    <<ui component (presentational)>>
  }
  class CardGrid {
    <<module (card-grid.ts)>>
    +columnsForWidth(width: int, isTTY: bool) int$
    +MIN_CARD_WIDTH
  }
  class StatusFilterBar {
    <<ui component (presentational)>>
  }
  class DetailView {
    <<ui component (container)>>
  }
  class HelpOverlay {
    <<ui component (presentational)>>
    +HELP_OVERLAY_ROWS int$
  }
  class BoxBorder {
    <<module (box-border.ts, release-6)>>
    +displayWidth(text: string) int$
    +resolveBoxWidth(columns: int, isTTY: bool) int$
    +topBorderWithTitle(width: int, title: string) string$
    +bottomBorderWithLabel(width: int, label: string) string$
  }
  class EventScroll {
    <<module (event-scroll.ts, release-6)>>
    +DETAIL_RESERVED_ROWS int$
    +visibleRowsForHeight(rows: int, isTTY: bool, reserved: int) int$
    +clampOffset(total: int, visible: int, offset: int) int$
    +offsetForBottom(total: int, visible: int) int$
    +isAtBottom(total: int, visible: int, offset: int) bool$
    +windowForOffset(total: int, visible: int, offset: int) ScrollWindow$
    +wrapAwareWindowForTexts(texts, contentWidth, visible, offset) ScrollWindow$
    +hardLineAwareWindowForTexts(texts, visible, offset) ScrollWindow$
  }
  class ScrollWindow {
    <<interface>>
    +int startIndex
    +int endIndex
    +int visibleCount
    +string rangeLabel
    +int startSkipHardLines
    +int endSkipHardLines
  }
  class TerminalTitle {
    <<module (terminal-title.ts, release-6 FR-09)>>
    +DEFAULT_TERMINAL_TITLE string$
    +setTerminalTitle(stdout: WritableStream, title: string) void$
  }
  class SanitizeDisplayText {
    <<module (sanitize-display-text.ts)>>
    +sanitizeDisplayText(text: string) string$
    +sanitizeNullableDisplayText(text: string_or_null) string_or_null$
  }
  class MonomiVersion {
    <<module (version.ts, release-11)>>
    +MONOMI_VERSION string$
  }

  HubEndpointResolver ..> HubEndpointOps
  HubEndpointResolver ..> Network : isTailscaleIpv4
  HubEndpointOps ..> Network : isTailscaleIpv4
  HubEndpointOps ..> HubEndpoint
  Network ..> NetworkCandidate
  createHubConnection ..> HubEndpointResolver : resolveReachable
  createHubConnection ..> HubApiClient : builds
  createHubConnection ..> HubConnection : produces
  PollingLoop ..> HubApiClient : FetchFn receives client
  InstanceListStore ..> ClientRollup : uses
  KeyBindingController ..> InstanceListStore
  KeyBindingController ..> StatusDisplay : filterForKey
  KeyBindingController ..> KeyBindingHost : dispatches to
  KeyBindingController ..> KeyFlags
  AppView ..> InstanceListStore
  AppView ..> PollingLoop
  AppView ..> KeyBindingController
  AppView ..|> KeyBindingHost : implements
  AppView --> InstanceTable
  AppView --> StatusFilterBar
  AppView --> DetailView
  AppView --> HelpOverlay
  AppView --> WatchingIndicator
  InstanceTable --> InstanceCard
  InstanceTable ..> CardGrid : columnsForWidth
  InstanceCard ..> StatusDisplay
  InstanceCard ..> SanitizeDisplayText
  StatusFilterBar ..> StatusDisplay
  DetailView ..> HubApiClient : fetches detail
  DetailView ..> PollingLoop : polls detail
  DetailView ..> StatusDisplay
  DetailView ..> BoxBorder : layout
  DetailView ..> EventScroll : scroll window
  EventScroll ..> BoxBorder : displayWidth
  EventScroll ..> ScrollWindow : returns
  DetailView ..> SanitizeDisplayText
  AppView ..> TerminalTitle : FR-09
  TerminalTitle ..> SanitizeDisplayText : sanitizeDisplayText
  AppView ..> MonomiVersion : v{MONOMI_VERSION} header badge
  HelpOverlay ..> MonomiVersion : Monomi v{MONOMI_VERSION} footer line
  PairingClient ..> HubApiClient
  PairingClient ..> Network : buildCandidateUrls
  PairingClient ..> ConfigWriter : writeChildPairingConfig
  StatusDisplay ..> I18n : statusLabel resolves via t()
  AppView ..> I18n : t() (error prefix)
  DetailView ..> I18n : t() (box titles/labels)
  HelpOverlay ..> I18n : t() (help lines)
  InstanceTable ..> I18n : t() (empty-state label)
  WatchingIndicator ..> I18n : t() (app.watching label)

  note for InstanceTable "既知バックログ A4: 名前が実体（カードグリッド）と不一致、かつ useStdout+columnsForWidth のレイアウト計算を持ち presentational 規約を逸脱。release-5 では解消せず（InstanceCardGrid への改名等は別作業）。"
  note for WatchingIndicator "release-10 FR-02: components/* の慣例（状態を持たない presentational）に対する意図的な例外。1000ms 点滅トグル用の visible state と setInterval をここに閉じ込め、AppView 本体の再レンダーを誘発しない（既知の P4 悪化防止）。"
```

**責務分離**:

- `PollingLoop<T>` は watch モードの汎用ポーリング。取得対象は一覧固有ではなく `FetchFn<T>`（`(client) => Promise<T>`）に委ね、一覧（`(c) => c.listInstances()`）にも詳細（`(c) => c.getInstanceDetail(id)`）にも同じ機構を再利用する。`inFlight` で多重取得を抑止し、`start()` は即時 1 回取得してから間隔ポーリングする（既定 `DEFAULT_POLL_INTERVAL_MS = 3000`）。取得失敗は例外にせず `ErrorListener` へ配り、注入された `ReresolveClient` があれば到達先を選び直して次 tick 以降のクライアントを差し替える（LAN → Tailscale フォールバック）。
- `HubApiClient` は `baseUrl` 非依存の読み取り/管理クライアント（一覧・詳細・devices 一覧/revoke・pair start/claim）。到達先の選定は持たず、`createHubApiClient`/`createHubConnection`（factory）が `HubEndpointResolver` で候補を優先順にプローブして配線する。`createHubConnection` は再解決ファクトリ同梱の `HubConnection` を返し、`PollingLoop` の watch 中フォールバックに供給する。
- `HubEndpointResolver` と `HubEndpointOps`／`Network` がマルチエンドポイント方針（Tailscale `100.64.0.0/10` 優先 → LAN の順、到達可否は HTTP 応答有無で判定）を実装する。`Network` は `monomi hub pair` の候補 URL 提示（`buildCandidateUrls`）にも使う。reporter（bash）側は同等ロジックをシェルで別実装する。
- `PairingClient`（`runHubPair`/`runChildPair`）が §9 のペアリング CLI を実装し、`HubApiClient`（pair start/claim）・`Network`（候補 URL）・`ConfigWriter`（`role`/`hub_endpoints`/`device_id` の部分書き込み、`chmod 600`）を束ねる。
- `KeyBindingController` はキー → アクションの薄い写像に徹する。ビュー状態（選択位置・`ViewMode`）は持たず、`handleKey(input, KeyFlags, viewMode)` の引数で受け取り、画面遷移・選択移動は `KeyBindingHost`（`AppView` が React state で実装）へ委譲する。フィルタキー解決だけ `StatusDisplay.filterForKey` を使う。**`PollingLoop` には依存しない**（watch は常時 ON でトグルを持たないため、旧図の依存エッジは削除）。
- `InstanceListStore` は取得結果とフィルタ状態のみを保持し、`filtered()`/`projectRows()`（`ClientRollup` 委譲）を提供する。`ClientRollup` は hub が返す numeric priority を `max()` するだけで、優先順位の意味は解釈しない。
- View は Container（`AppView`／`DetailView`: 状態と API 呼び出しを持つ）と Presentational（`InstanceCard`／`StatusFilterBar`／`HelpOverlay`: props を描くだけ）に分離。`AppView` は 1 instance = 1 枚の `InstanceCard` を `InstanceTable`（列数は `CardGrid.columnsForWidth` が端末幅と TTY 判定で決定）で並べる。`DetailView` は自前で `PollingLoop<InstanceDetail>` を張り、`pollIntervalMs` 間隔で `getInstanceDetail` を呼び直して status/イベントタイムラインを自動更新し、アンマウントで確実に停止する。`WatchingIndicator`（release-10 FR-02、`app-view.tsx` から分離）は見た目は presentational だが、この分離規約に対する唯一の意図的な例外として `visible` state と 1000ms `setInterval` を自身に閉じ込める。理由は `AppView` がすでに抱える再レンダー過多（既知バックログ P4）を、点滅の再描画トリガーで悪化させないため（React は子の `setState` だけでは親を再レンダーしない性質を利用）。`isRunning: boolean` を props に取り、`AppView` 本体の state は増やさない。
- 表示語彙（ラベル・色・グリフ・経過時間・フィルタキー対応）は `StatusDisplay`（`status-display.ts`）に集約し、status 導出・優先順位ロジックは CLI に一切持たない。すべて hub 側 `StatusDeriver`／`InstanceStatusRollup` の責務。release-9-i18n 以降、ラベルの文字列自体は `StatusDisplay` が直接持たず `I18n`（`i18n/index.ts`）の `t()` 経由でアクティブロケールに応じて解決する（`StatusDisplay` が持つのは表示状態→翻訳キーの写像と色・グリフ。色・グリフはロケール非依存）。同様に `AppView`／`DetailView`／`HelpOverlay`／`InstanceTable`／`WatchingIndicator` の文言も `t()` 経由。
- release-6 で `DetailView` 用に追加された 4 モジュールは、いずれも React に依存しない純粋関数モジュール（`CardGrid` と同じ思想）。`BoxBorder`（`box-border.ts`）は表示幅計算・タイトル/範囲ラベル埋め込み罫線の生成、`EventScroll`（`event-scroll.ts`）は端末高さ→表示行数・スクロールウィンドウの算出（`DETAIL_RESERVED_BREAKDOWN` の各定数値は AppView/DetailView の JSX 行構成と手動同期が必要な暗黙結合を持つ点に注意）、`TerminalTitle`（`terminal-title.ts`）はターミナルのタブ/ウィンドウタイトル設定（OSC 0）、`SanitizeDisplayText`（`sanitize-display-text.ts`）はレポーター由来の自由記述からの ANSI/制御文字除去を担う。4 モジュールは独立ではなく、`EventScroll` は折り返し幅の見積もりに `BoxBorder.displayWidth`（East Asian Wide 対応の表示桁数計算）を再利用し、`TerminalTitle` はタイトル本文のサニタイズに `SanitizeDisplayText.sanitizeDisplayText` を再利用する（ANSI/制御文字除去ロジックの二重実装を避ける）。
- `SanitizeDisplayText` の呼び出し元は release-10-dashboard-polish のレビュー修正（CWE-150）で `DetailView` に加え `InstanceCard` にも拡大した。`device.name`（両者）・`branch`（`InstanceCard`。`DetailView` の `branch` は release-6 で対応済み）はレポーター元／ペアリング済み child が制御しうる自由記述で、hub 側の検証は型のみのため ANSI エスケープ・制御文字の混入（端末エスケープ注入）を描画直前の除染で防ぐ。
- `MonomiVersion`（`version.ts`, release-11）は `package.json` の `version` を読み込む唯一の入口（`import packageJson from '../package.json' with { type: 'json' }`）。公開 API バレル `src/index.ts` はこの値を re-export するだけで自前定義を持たない。値の定義をバレルから切り出して独立した葉モジュールにしたのは、`AppView`／`HelpOverlay` のような内部コンポーネントが表示用に同じ値を必要とする一方、これらが `index.ts` から直接 import すると `index.ts`（`AppView` を re-export）→ `app-view.tsx` → `index.ts` の循環依存が生じるため（バレルへの逆依存はバレルの「実装詳細の変更を外部へ波及させない」責務を壊す）。`index.ts`／`AppView`／`HelpOverlay` はいずれも `version.ts` を一方向に参照するのみで、`index.ts` 自体は図上のノードを持たない（公開 API の再エクスポート集約であり独自の振る舞いを持たないため）。ヘルプ末尾の表記は en/ja 共通のため `I18n` の `t()` を介さない生文字列。

---

## 責任分解の一覧表

| クラス / モジュール                                                         | レイヤー      | 種別                                            | 責務                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ProjectKey                                                                  | domain-model  | interface (value object)                        | 正規化済みプロジェクト識別子（value + kind）を保持                                                                                                                           |
| ProjectKeyKind / DeviceRole / EventType                                     | domain-model  | enum                                            | 種別の列挙（判別ユニオン）                                                                                                                                                   |
| ProjectKeyOps                                                               | domain-model  | module (project-key.ts)                         | ProjectKey の生成・種別判定・等価比較の関数群                                                                                                                                |
| ProjectKeyNormalizer                                                        | domain-model  | domain service                                  | git remote の表記ゆれを吸収し ProjectKey を生成する唯一の実装                                                                                                                |
| NormalizeContext                                                            | domain-model  | interface (value object)                        | 正規化に必要な文脈（device_id, cwd, isGitRepo, commonDir）                                                                                                                   |
| DeviceId                                                                    | domain-model  | module (device-id.ts)                           | hostname から device_id を派生（`deriveDeviceId`）                                                                                                                           |
| Device / Project / Instance / Session / Event / DeviceToken / PrStatus      | domain-model  | entity (interface)                              | §7.3 DDL に対応する永続エンティティ（データのみ）                                                                                                                            |
| EpochMs / DurationMs                                                        | domain-model  | branded number                                  | 時刻・期間の取り違え防止のためのブランド型                                                                                                                                   |
| RawState / DisplayStatus                                                    | status-engine | enum                                            | 内部状態／表示状態の列挙                                                                                                                                                     |
| RepresentedStatus                                                           | status-engine | type alias                                      | DisplayStatus ＋ CLOSED（優先度計算・分類結果の型）                                                                                                                          |
| RawStateRules                                                               | status-engine | module (raw-state-resolver.ts)                  | イベント → raw_state 写像、状態イベントの降順抽出・比較関数                                                                                                                  |
| RawStateResolver                                                            | status-engine | domain service                                  | 降順イベント列の先頭から raw_state を返す薄いラッパ                                                                                                                          |
| StateTransition / StateTransitionFinder                                     | status-engine | value object / domain service                   | 現在 raw_state 連続区間の開始時刻を特定                                                                                                                                      |
| RunBoundaryScanner                                                          | status-engine | module (run-boundary-scanner.ts)                | 1 ページを走査し現在 run の状態境界を検出（ページング打ち切り判断）                                                                                                          |
| EscalationThresholdValues / EscalationThresholds                            | status-engine | value object                                    | raw_state 別の放置昇格閾値（既定 2h/6h/24h/72h、config 上書き可）                                                                                                            |
| EscalationPolicy                                                            | status-engine | domain service                                  | 放置（STALE）への昇格判定、PR 待ち条件を含む                                                                                                                                 |
| StatusPriority                                                              | status-engine | domain service                                  | 表示ステータス優先順位の数値化・比較（`higherOf`）の唯一の場所                                                                                                               |
| StatusResult                                                                | status-engine | interface (value object)                        | 1 session/instance の最終ステータス（`createStatusResult` で凍結）                                                                                                           |
| StatusDeriver                                                               | status-engine | domain service（オーケストレータ）              | resolver/finder/policy を束ねる導出パイプライン                                                                                                                              |
| RollupEntry                                                                 | status-engine | interface (value object), release-7             | rollup 入力（`StatusResult` ＋ session 直近イベント時刻 `lastEventAt`）                                                                                                      |
| InstanceStatusRollup                                                        | status-engine | domain service                                  | instance 配下の session から代表ステータスを選出（release-8 FR-02: 完全 recency 優先。closed は live session があれば除外し §0.5 を維持、priority は同時刻タイブレークのみ） |
| DeviceRepository〜PrStatusRepository                                        | hub-api       | repository                                      | SQLite アクセスと冪等性制約                                                                                                                                                  |
| EventIngestionService                                                       | hub-api       | use case                                        | イベント受信・正規化・自動登録・冪等 upsert                                                                                                                                  |
| InstanceStatusService                                                       | hub-api       | use case                                        | 一覧・詳細取得のための status 導出／ページング呼び出し                                                                                                                       |
| TokenService                                                                | hub-api       | domain service                                  | token 発行・検証・（device 単位の）revoke・有効 device 集合列挙                                                                                                              |
| PairingService                                                              | hub-api       | domain service                                  | 6 桁コードの発行・TTL・失敗カウント・device 競合判定                                                                                                                         |
| AuthResolver                                                                | hub-api       | middleware                                      | Bearer token → device 解決（HttpServer 前段で全ルートに適用）                                                                                                                |
| Loopback                                                                    | hub-api       | module (loopback.ts)                            | 送信元が loopback かの判定（pair/start・devices 管理の共有ガード）                                                                                                           |
| Router                                                                      | hub-api       | infrastructure                                  | メソッド＋パターンのルート照合（public フラグ付き）                                                                                                                          |
| createHubServer                                                             | hub-api       | factory                                         | Repository→Service→Controller→Router→HttpServer の DI 配線                                                                                                                   |
| HttpServer                                                                  | hub-api       | infrastructure                                  | HTTP 入出力・認証ゲート・JSON 変換の薄い層                                                                                                                                   |
| EventsController / InstancesController / DevicesController / PairController | hub-api       | controller                                      | HTTP 入出力の薄い変換（devices/pair は loopback 上乗せ）                                                                                                                     |
| HubEndpoint / HubEndpointResolver / HubEndpointOps                          | cli-ink       | value object / service / module                 | マルチエンドポイントの到達可否判定・URL 整形                                                                                                                                 |
| Network                                                                     | cli-ink       | module (network.ts)                             | 到達先候補検出（Tailscale/LAN 分類）と候補 URL 生成                                                                                                                          |
| HubApiClient / createHubConnection / HubConnection                          | cli-ink       | infrastructure / factory                        | hub への HTTP クライアントと到達先配線・再解決ファクトリ                                                                                                                     |
| PollingLoop<T>                                                              | cli-ink       | application service                             | 汎用ポーリング（一覧・詳細）。多重取得抑止・失敗時フォールバック                                                                                                             |
| ClientRollup                                                                | cli-ink       | utility                                         | project 単位の priority max() 集計のみ                                                                                                                                       |
| InstanceListStore                                                           | cli-ink       | application state                               | フィルタ状態・取得結果の保持                                                                                                                                                 |
| StatusDisplay                                                               | cli-ink       | module (status-display.ts)                      | 表示語彙（ラベル/色/グリフ/経過時間/フィルタキー対応）。ラベル文字列は `I18n` の `t()` 経由で解決、色・グリフはロケール非依存                                                |
| I18n                                                                        | cli-ink       | module (i18n/index.ts, release-9)               | 表示文言解決の唯一の入口（`t`/`setActiveLocale`/`getActiveLocale`/`resolveLocale`）。ロケールはモジュールレベル・シングルトンで保持（React context 不使用）                  |
| ViewMode / KeyFlags / KeyBindingHost                                        | cli-ink       | type / interface                                | キー処理の入出力境界（AppView が Host を実装）                                                                                                                               |
| KeyBindingController                                                        | cli-ink       | controller                                      | キー入力 → アクションの薄い写像（PollingLoop に非依存）                                                                                                                      |
| ConfigWriter                                                                | cli-ink       | module (config/config-writer.ts)                | child ペアリング設定の部分書き込み（chmod 600）                                                                                                                              |
| PairingClient                                                               | cli-ink       | module (pairing-client.ts)                      | `monomi hub pair` / `monomi pair` のフロー実装                                                                                                                               |
| AppView / DetailView                                                        | cli-ink       | ui component (container)                        | 状態と API を持つコンテナ（DetailView は詳細を自動更新）                                                                                                                     |
| InstanceTable                                                               | cli-ink       | ui component (grid container)                   | カードグリッド描画（A4: 命名不一致・レイアウト計算保持の逸脱あり）                                                                                                           |
| InstanceCard / StatusFilterBar / HelpOverlay                                | cli-ink       | ui component (presentational)                   | props を描くだけ                                                                                                                                                             |
| WatchingIndicator                                                           | cli-ink       | ui component (presentational, release-10 FR-02) | props を描くだけの規約に対する意図的な例外。1000ms 点滅トグル用の state を自身に閉じ込め、AppView 本体の再レンダーを誘発しない                                               |
| CardGrid                                                                    | cli-ink       | module (card-grid.ts)                           | 端末幅と TTY からカード列数を算出する純粋関数                                                                                                                                |
| BoxBorder                                                                   | cli-ink       | module (box-border.ts, release-6)               | BOX幅・タイトル/範囲ラベル埋め込み罫線の生成（表示幅計算含む）                                                                                                               |
| EventScroll / ScrollWindow                                                  | cli-ink       | module + interface (event-scroll.ts, release-6) | 詳細ビューの表示行数・スクロールウィンドウ算出（React 非依存の純粋関数）                                                                                                     |
| TerminalTitle                                                               | cli-ink       | module (terminal-title.ts, release-6 FR-09)     | ターミナルのタブ/ウィンドウタイトルを OSC 0 で設定                                                                                                                           |
| SanitizeDisplayText                                                         | cli-ink       | module (sanitize-display-text.ts)               | レポーター由来の自由記述から ANSI/制御文字を除去（注入対策）                                                                                                                 |
| MonomiVersion                                                               | cli-ink       | module (version.ts, release-11)                 | `package.json` の `version` を読み込む唯一の入口。`index.ts`／`AppView`／`HelpOverlay` から一方向に参照される葉モジュール（バレルへの逆依存・循環依存を回避）                |

---

## 未解決点・既知バックログ（実装時に判断）

- `Event` は単一 `interface` ＋ `EventType` 判別子を採用（判別ユニオンへの切替は複雑化時に再検討）。
- project レベルのロールアップは CLI 側 `ClientRollup`（単純 `max()`）に限定。instance 側ロールアップ（`InstanceStatusRollup`）と共通化するかは将来判断。
- `EscalationThresholds` の config 上書きは hub 起動時（`serve` → `createHubServer` の `thresholds` 注入）で DI する方針に確定。
- `TokenService.hash` は SHA-256 固定。token 自体が十分なエントロピーを持つ前提のため、ソルト付き低速ハッシュ（bcrypt 等）は用いない。
- **A4（未解消）**: `InstanceTable` はカードグリッドの実体と名前が不一致で、`useStdout()` と列数・幅計算（レイアウトロジック）を保持し presentational 規約を逸脱している。`InstanceCardGrid` への改名、またはレイアウト計算の `card-grid.ts` への集約は、呼び出し側（`app-view.tsx`）の import 変更を伴うためまとまった別作業として行う（`known-issues.md` A4）。
