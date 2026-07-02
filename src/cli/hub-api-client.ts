import fs from 'node:fs'
import { loadConfig } from '../config/config.js'
import { resolvePaths, type MonomiPaths } from '../config/paths.js'
import type { InstanceDetail, InstanceStatusRow } from '../hub/dto.js'
import { HubEndpointResolver, localhostEndpoint } from './hub-endpoint-resolver.js'

/** {@link HubApiClient} の依存（テストで baseUrl / token / fetch を差し替えるため）。 */
export interface HubApiClientOptions {
  /** hub のベース URL（例 `http://127.0.0.1:47632`）。末尾スラッシュは無視する。 */
  baseUrl: string
  /** `Authorization: Bearer` に載せるローカル device token（§0.3/§9）。 */
  token: string
  /** HTTP 実装の差し替え（省略時はグローバル `fetch`）。テストで注入する。 */
  fetchImpl?: typeof fetch
}

/** `GET /api/v1/instances` のレスポンスエンベロープ（§8.2）。 */
interface InstancesEnvelope {
  generated_at: string
  instances: InstanceStatusRow[]
}

/**
 * hub API への読み取り専用 HTTP クライアント（class-diagram §4 / §8.2）。
 *
 * すべてのリクエストに Bearer token を付与する（読み取りも認証必須、§8.2）。
 * status 導出・優先度・ロールアップは hub 側の責務であり、本クライアントは
 * wire 応答を型付きで受け取って返すだけ（CLI にロジックを持ち込まない、§0.5）。
 * release-1 の endpoint は localhost 固定（§3.1）。
 */
export class HubApiClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  /**
   * @param options baseUrl / token / fetch 実装。
   */
  constructor(options: HubApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
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
   * Bearer 付き GET を投げて JSON を返す共通処理。
   *
   * @param pathname `/api/v1/...` から始まるパス。
   * @returns パース済み JSON（呼び出し側で型を指定）。
   * @throws {Error} 応答が 2xx でない場合。
   */
  private async getJson<T>(pathname: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      headers: { authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      throw new Error(`hub request failed: GET ${pathname} -> ${res.status}`)
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

/**
 * `~/.monomi` の config（port）とローカル token を読み、既定の {@link HubApiClient} を作る。
 *
 * release-1 は endpoint が localhost 1 つのみのため {@link HubEndpointResolver} は
 * その 1 件をそのまま採用する（マルチエンドポイントは release-2、§0.2）。
 *
 * @param paths パス集合（省略時は {@link resolvePaths}）。
 * @returns 配線済みの {@link HubApiClient}。
 * @throws {Error} token 未生成（hub 未起動）などで接続情報が揃わない場合。
 */
export function createHubApiClient(paths: MonomiPaths = resolvePaths()): HubApiClient {
  const config = loadConfig(paths)
  const token = readLocalToken(paths.tokenFile)
  const endpoint = new HubEndpointResolver().resolveReachable([localhostEndpoint(config.port)])
  return new HubApiClient({ baseUrl: `http://${endpoint.host}:${endpoint.port}`, token })
}
