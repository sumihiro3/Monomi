import fs from 'node:fs'
import { loadConfig, type MonomiConfig } from '../config/config.js'
import { type MonomiPaths, resolvePaths } from '../config/paths.js'
import type {
  DeviceDto,
  DeviceRevokeResult,
  DevicesEnvelope,
  InstanceDetail,
  InstanceStatusRow,
  PairClaimPayload,
  PairClaimResponse,
  PairStartResponse,
} from '../hub/dto.js'
import {
  endpointBaseUrl,
  type HubEndpoint,
  HubEndpointResolver,
  localhostEndpoint,
  parseHubEndpoint,
} from './hub-endpoint-resolver.js'

/** {@link HubApiClient} の依存（テストで baseUrl / token / fetch を差し替えるため）。 */
export interface HubApiClientOptions {
  /** hub のベース URL（例 `http://127.0.0.1:47632`）。末尾スラッシュは無視する。 */
  baseUrl: string
  /**
   * `Authorization: Bearer` に載せるローカル device token（§0.3/§9）。
   * 認証必須の読み取り・管理ルートでは必須。未認証の public ルート（`pairStart`/`pairClaim`）
   * しか使わないペアリング文脈ではまだ token が無いため省略できる。
   */
  token?: string
  /** HTTP 実装の差し替え（省略時はグローバル `fetch`）。テストで注入する。 */
  fetchImpl?: typeof fetch
}

/**
 * `POST /api/v1/pair/claim` が非 2xx（コード不一致・失効・ペイロード不正など）を返したときのエラー。
 *
 * 「hub に到達したが hub が明示的に拒否した」ことを表す。呼び出し側（{@link ../cli/pairing-client.js}）は
 * これを**確定的な失敗**として扱い、他エンドポイントの順次試行を打ち切る（接続不能とは区別する）。
 */
export class PairRejectedError extends Error {
  /**
   * @param httpStatus 応答ステータス（例 400）。
   * @param errorCode wire の `error` コード（例 `code_expired` / `invalid_code`）。
   * @param message 表示用メッセージ。
   */
  constructor(
    readonly httpStatus: number,
    readonly errorCode: string,
    message: string
  ) {
    super(message)
    this.name = 'PairRejectedError'
  }
}

/** `GET /api/v1/instances` のレスポンスエンベロープ（§8.2）。 */
interface InstancesEnvelope {
  generated_at: string
  instances: InstanceStatusRow[]
}

/**
 * 応答から hub の版を読み取るヘッダ名（FR-01。`HttpServer.send()` が全応答へ付与する）。
 *
 * `src/hub/hub-lifecycle.ts` の `HUB_VERSION_HEADER` と同じ値。hub レイヤーへ依存を持ち込まない
 * ため（class-diagram: hub→cli の依存方向を保つ）、cli 側にも同じ定数を独立して持つ
 * （probeHub と同じ「依存方向の一貫性を優先した意図的な二重定義」パターン、`hub-lifecycle.ts` 参照）。
 */
const HUB_VERSION_HEADER = 'x-monomi-hub-version'

/**
 * hub API への読み取り専用 HTTP クライアント（class-diagram §4 / §8.2）。
 *
 * すべてのリクエストに Bearer token を付与する（読み取りも認証必須、§8.2）。
 * status 導出・優先度・ロールアップは hub 側の責務であり、本クライアントは
 * wire 応答を型付きで受け取って返すだけ（CLI にロジックを持ち込まない、§0.5）。
 * 接続先はエンドポイント非依存（`baseUrl` を受け取るだけ）で、到達先の選定は
 * {@link createHubApiClient} が {@link HubEndpointResolver} 経由で行う（§0.2 / FR-05）。
 */
export class HubApiClient {
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly fetchImpl: typeof fetch
  /**
   * 直近の Bearer 付き GET 応答（{@link getJson}）から読み取った hub の版（FR-04）。
   * 追加リクエストは発生させず、既存ポーリング応答のヘッダを読むだけに留める（FR-04 の要件）。
   * 一度も GET していない、または応答にヘッダが無かった（旧版 hub 等）場合は `undefined`。
   */
  private lastHubVersion: string | undefined

  /**
   * @param options baseUrl / token / fetch 実装。
   */
  constructor(options: HubApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * 直近の {@link getJson} 応答（`listInstances`/`getInstanceDetail`/`listDevices`）から読み取った
   * `X-Monomi-Hub-Version` ヘッダの値を返す（FR-04）。
   *
   * child のポーリングループ（`app-view.tsx`）が、追加リクエストを発生させずに接続中 hub の版を
   * 監視するための経路。一度も GET していない、またはヘッダが無かった（旧版 hub との通信等）
   * 場合は `undefined`＝版不明（呼び出し側は `version-compare.ts` の `compareVersion` で
   * `'unknown'` として扱う）。
   *
   * @returns 直近応答の hub 版、または `undefined`。
   */
  getLastHubVersion(): string | undefined {
    return this.lastHubVersion
  }

  /**
   * 稼働中 instance を導出済みステータス付きで列挙する（§8.2）。
   *
   * @returns instance 行の配列（エンベロープの `instances`）。
   * @throws {Error} 非 2xx 応答（認証失敗を含む）。
   */
  async listInstances(): Promise<InstanceStatusRow[]> {
    const body = await this.getJson<InstancesEnvelope>('/api/v1/instances')
    return body.instances
  }

  /**
   * 1 instance の詳細（直近イベント付き、Agent View Lv.1）を取得する（§8.2 / §10.4）。
   *
   * @param id instance の id。
   * @returns 詳細 DTO。
   * @throws {Error} 非 2xx 応答（404 を含む）。
   */
  async getInstanceDetail(id: string): Promise<InstanceDetail> {
    return this.getJson<InstanceDetail>(`/api/v1/instances/${encodeURIComponent(id)}`)
  }

  /**
   * 登録デバイスを一覧する（`monomi hub devices list` の実体、FR-03 AC-1）。
   *
   * @returns device 行の配列（エンベロープの `devices`）。
   * @throws {Error} 非 2xx 応答（認証失敗を含む）。
   */
  async listDevices(): Promise<DeviceDto[]> {
    const body = await this.getJson<DevicesEnvelope>('/api/v1/devices')
    return body.devices
  }

  /**
   * device に紐づく有効トークンを一括失効させる（`monomi hub devices revoke <id>` の実体、
   * FR-03 AC-2）。
   *
   * @param id 失効対象の device_id。
   * @returns 失効結果（`{ ok, device_id, revoked }`）。
   * @throws {Error} 非 2xx 応答（未登録 device の 404 を含む）。
   */
  async revokeDevice(id: string): Promise<DeviceRevokeResult> {
    return this.postJson<DeviceRevokeResult>(`/api/v1/devices/${encodeURIComponent(id)}/revoke`)
  }

  /**
   * 6 桁ペアリングコードを発行させる（`monomi hub pair` の実体、§9 / FR-02 AC-1）。
   *
   * `pair/start` は未認証 public ルートだが loopback からのみ受け付ける（hub 側でガード、AC-2）。
   * `monomi hub pair` は起動中 hub の localhost を叩くため baseUrl は 127.0.0.1 で構成する。
   *
   * @returns 発行された `code` / `expires_at` / `ttl_seconds`。
   * @throws {Error} 非 2xx 応答（loopback 以外からの 403 を含む）。
   */
  async pairStart(): Promise<PairStartResponse> {
    return this.postPublicJson<PairStartResponse>('/api/v1/pair/start')
  }

  /**
   * ペアリングコードを照合して child 用 device_token を受け取る（`monomi pair` の実体、§9 / FR-02 AC-3）。
   *
   * `pair/claim` は未認証 public ルート。child は自機の `device_id`・`name`（hostname）を申告する。
   *
   * @param payload `code` / `device_id` / `name`。
   * @returns 発行された `token` / `device_id` / `role`。
   * @throws {PairRejectedError} hub が非 2xx で拒否した場合（コード失効・不一致・ペイロード不正）。
   * @throws {Error} hub へ到達できない場合（fetch 由来のネットワークエラー）。
   */
  async pairClaim(payload: PairClaimPayload): Promise<PairClaimResponse> {
    return this.postPublicJson<PairClaimResponse>('/api/v1/pair/claim', payload)
  }

  /**
   * Bearer 付き GET を投げて JSON を返す共通処理。
   *
   * `X-Monomi-Hub-Version` ヘッダは 2xx/非2xx を問わず全応答に付与される（FR-01）ため、
   * ok 判定より先に {@link lastHubVersion} へ読み取る（FR-04）。追加リクエストは発生させない。
   *
   * @param pathname `/api/v1/...` から始まるパス。
   * @returns パース済み JSON（呼び出し側で型を指定）。
   * @throws {Error} 応答が 2xx でない場合。
   */
  private async getJson<T>(pathname: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      headers: this.authHeaders(),
    })
    this.lastHubVersion = res.headers.get(HUB_VERSION_HEADER) ?? undefined
    if (!res.ok) {
      throw new Error(`hub request failed: GET ${pathname} -> ${res.status}`)
    }
    return (await res.json()) as T
  }

  /**
   * `Authorization` ヘッダを組み立てる。token 未設定（public ルート専用構成）なら空にする。
   *
   * @returns fetch へ渡すヘッダ辞書。
   */
  private authHeaders(): Record<string, string> {
    return this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }
  }

  /**
   * 認証を付けずに public ルート（pair/start・pair/claim）へ POST し JSON を返す共通処理。
   *
   * 非 2xx は {@link PairRejectedError} に変換する（hub が到達した上で拒否したことを表す）。
   * fetch 自体の失敗（接続不能）はそのまま伝播させ、呼び出し側が「到達不能」として扱えるようにする。
   *
   * @param pathname `/api/v1/...` から始まるパス。
   * @param body 送信ボディ（省略時は空ボディ）。
   * @returns パース済み JSON（呼び出し側で型を指定）。
   * @throws {PairRejectedError} 応答が 2xx でない場合。
   */
  private async postPublicJson<T>(pathname: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as {
        error?: string
        message?: string
      } | null
      throw new PairRejectedError(
        res.status,
        detail?.error ?? 'pair_failed',
        detail?.message ?? `hub rejected the request: POST ${pathname} -> ${res.status}`
      )
    }
    return (await res.json()) as T
  }

  /**
   * Bearer 付き POST を投げて JSON を返す共通処理（body 省略可）。
   *
   * @param pathname `/api/v1/...` から始まるパス。
   * @param body 送信ボディ（省略時は空ボディ）。
   * @returns パース済み JSON（呼び出し側で型を指定）。
   * @throws {Error} 応答が 2xx でない場合。
   */
  private async postJson<T>(pathname: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`hub request failed: POST ${pathname} -> ${res.status}`)
    }
    return (await res.json()) as T
  }
}

/**
 * ローカルの `~/.monomi/token` を読み出す。
 *
 * @param tokenFile トークンファイルのパス。
 * @returns 生トークン。
 * @throws {Error} 未生成（hub 未起動）または空の場合。
 */
function readLocalToken(tokenFile: string): string {
  if (!fs.existsSync(tokenFile)) {
    throw new Error(`Monomi token not found at ${tokenFile}. Start the hub first (monomi hub).`)
  }
  const raw = fs.readFileSync(tokenFile, 'utf8').trim()
  if (raw.length === 0) {
    throw new Error(`Monomi token file is empty: ${tokenFile}`)
  }
  return raw
}

/** {@link createHubApiClient} の依存注入点（テストで HTTP 実装を差し替える）。 */
export interface CreateHubApiClientOptions {
  /** HTTP 実装（到達性プローブと本クライアントの双方で使う。省略時はグローバル `fetch`）。 */
  fetchImpl?: typeof fetch
}

/**
 * config から試行する hub 到達先候補を優先順で組み立てる（FR-05 AC-1）。
 *
 * child は config の `hub_endpoints`（LAN / Tailscale 併記）を優先順にそのまま候補にする。
 * hub ロールや `hub_endpoints` 未設定時は自機の localhost を唯一の候補にする（`monomi hub devices ...`
 * などローカル hub API を叩く管理コマンドはこの経路を通る）。
 *
 * @param config ロード済み設定。
 * @returns 到達先候補（優先順）。
 */
function buildEndpointCandidates(config: MonomiConfig): HubEndpoint[] {
  const configured = config.hubEndpoints ?? []
  if (config.role === 'child' && configured.length > 0) {
    return configured.map((url) => parseHubEndpoint(url, config.port))
  }
  return [localhostEndpoint(config.port)]
}

/**
 * `~/.monomi` の config（role/port/hub_endpoints）とローカル token を読み、到達可能な hub へ
 * 配線した {@link HubApiClient} を作る（FR-05）。
 *
 * child では `hub_endpoints` を優先順に HTTP プローブし、最初に到達した先へ接続する（AC-1）。
 * 全候補が不達なら {@link HubEndpointResolver} が試行 URL 一覧つきの例外を投げる（AC-2）。
 *
 * @param paths パス集合（省略時は {@link resolvePaths}）。
 * @param options fetch 実装の差し替え（省略可）。
 * @returns 配線済みの {@link HubApiClient}。
 * @throws {Error} token 未生成（hub 未起動）、または全エンドポイント不達の場合。
 */
export async function createHubApiClient(
  paths: MonomiPaths = resolvePaths(),
  options: CreateHubApiClientOptions = {}
): Promise<HubApiClient> {
  return (await createHubConnection(paths, options)).client
}

/**
 * 初回配線済みの {@link HubApiClient} と、到達先を選び直す再解決ファクトリの組。
 *
 * watch モード（{@link ../cli/polling-loop.js} の `PollingLoop`）が取得失敗時に到達先を選び直せる
 * よう、config 由来の endpoints/token/fetchImpl を握り潰さずに閉じ込めた再解決関数を同梱する（#1）。
 */
export interface HubConnection {
  /** 初回到達先へ配線済みの読み取りクライアント。 */
  client: HubApiClient
  /**
   * 到達先を再解決して新しい {@link HubApiClient} を返すファクトリ。
   *
   * config の endpoints を優先順に再プローブし、最初に到達した先へ配線し直す。全候補が不達なら
   * {@link HubEndpointResolver} が例外を投げる（呼び出し側 = `PollingLoop` は握りつぶして次 tick へ）。
   */
  reresolve: () => Promise<HubApiClient>
}

/**
 * config（role/port/hub_endpoints）とローカル token を読み、初回配線済みクライアントと
 * 再解決ファクトリの組（{@link HubConnection}）を作る（FR-05 / #1）。
 *
 * {@link createHubApiClient} との違いは、到達先選定に必要な endpoints/token/fetchImpl を
 * クロージャに閉じ込めて `reresolve` として返す点。watch 中に接続先 hub が落ちても、同じ config を
 * 使って別エンドポイントへ張り替えられる（{@link HubApiClient} は baseUrl 非依存のまま保つ）。
 *
 * @param paths パス集合（省略時は {@link resolvePaths}）。
 * @param options fetch 実装の差し替え（省略可）。
 * @returns 初回クライアントと再解決ファクトリの組。
 * @throws {Error} token 未生成（hub 未起動）、または初回に全エンドポイント不達の場合。
 */
export async function createHubConnection(
  paths: MonomiPaths = resolvePaths(),
  options: CreateHubApiClientOptions = {}
): Promise<HubConnection> {
  const config = loadConfig(paths)
  const token = readLocalToken(paths.tokenFile)
  const endpoints = buildEndpointCandidates(config)
  const resolver = new HubEndpointResolver()
  const reresolve = async (): Promise<HubApiClient> => {
    const endpoint = await resolver.resolveReachable(endpoints, {
      fetchImpl: options.fetchImpl,
    })
    return new HubApiClient({
      baseUrl: endpointBaseUrl(endpoint),
      token,
      fetchImpl: options.fetchImpl,
    })
  }
  return { client: await reresolve(), reresolve }
}
