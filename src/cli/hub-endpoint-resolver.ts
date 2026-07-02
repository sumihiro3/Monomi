import { isTailscaleIpv4 } from './network.js'

/**
 * hub 到達先の候補（§0.2 のマルチエンドポイント: LAN IP / Tailscale IP 等）。
 */
export interface HubEndpoint {
  /** ホスト名または IP。 */
  host: string
  /** 待受ポート。 */
  port: number
  /** 表示・ログ用のラベル（例 `localhost` / `lan` / `tailscale`）。 */
  label: string
}

/** {@link HubEndpointResolver.resolveReachable} の到達性プローブ用オプション（テストで注入）。 */
export interface ResolveReachableOptions {
  /** HTTP 実装（省略時はグローバル `fetch`）。テストで注入する。 */
  fetchImpl?: typeof fetch
  /**
   * 到達性判定に使う GET パス（既定 `/api/v1/instances`）。
   * 認証で 401 が返っても「hub に到達できた」ことは確認できるため、応答があれば到達とみなす。
   */
  probePath?: string
  /** 1 候補あたりのプローブ打ち切り時間（ミリ秒、既定 2000）。不達候補で長時間ブロックしないため。 */
  timeoutMs?: number
}

/** 到達性プローブに使う既定 GET パス（認証必須ルート。401 でも「到達」と判定する）。 */
const DEFAULT_PROBE_PATH = '/api/v1/instances'

/** 1 候補あたりのプローブ既定タイムアウト（ミリ秒）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 2000

/**
 * `HubEndpoint` を `http://host:port` のベース URL 文字列へ整形する。
 *
 * @param endpoint 対象エンドポイント。
 * @returns `http://host:port` 形式のベース URL。
 */
export function endpointBaseUrl(endpoint: HubEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`
}

/**
 * loopback（localhost）への単一エンドポイントを組み立てる（hub ロール／単一マシン構成の到達先）。
 *
 * @param port hub の待受ポート。
 * @returns localhost を指す {@link HubEndpoint}。
 */
export function localhostEndpoint(port: number): HubEndpoint {
  return { host: '127.0.0.1', port, label: 'localhost' }
}

/**
 * config の `hub_endpoints` 文字列（`http://host:port`）を {@link HubEndpoint} へ変換する（FR-05）。
 *
 * scheme が無ければ `http://` を補い、ポートが無ければ `defaultPort` を補う。Tailscale レンジ
 * （100.64.0.0/10）に属す IP は `tailscale`、それ以外は `lan` に分類して表示ラベルに使う。
 *
 * @param rawUrl config の 1 エンドポイント（`http://192.168.1.100:47632` など）。
 * @param defaultPort ポート未指定時に補う既定ポート（config.port）。
 * @returns 解析済みの {@link HubEndpoint}。
 * @throws {Error} URL として解釈できない場合。
 */
export function parseHubEndpoint(rawUrl: string, defaultPort: number): HubEndpoint {
  const trimmed = rawUrl.trim()
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`invalid hub endpoint "${rawUrl}" (expected http://host:port)`)
  }
  const port = url.port === '' ? defaultPort : Number(url.port)
  return {
    host: url.hostname,
    port,
    label: isTailscaleIpv4(url.hostname) ? 'tailscale' : 'lan',
  }
}

/**
 * 複数エンドポイントを優先順に到達性プローブし、最初に到達できた先を返す resolver（class-diagram §4 / §0.2）。
 *
 * child は LAN / Tailscale など複数の到達先を config に併記する。到達可否は「HTTP 応答が返るか」で
 * 判定し（認証で 401 が返っても hub には到達できている）、fetch 自体が reject する（接続不能・タイムアウト）
 * 候補のみ不達とみなして次へ進む。reporter（bash）側は同等ロジックをシェルで別実装する（§0.2）。
 */
export class HubEndpointResolver {
  /**
   * 到達可能な最初のエンドポイントを優先順で返す（FR-05 AC-1）。
   *
   * 候補を先頭から順に HTTP プローブし、最初に到達した先を採用する。全候補が不達なら
   * 試行した候補 URL 一覧を添えて例外を投げる（FR-05 AC-2）。
   *
   * @param endpoints 到達先候補（優先順）。
   * @param options fetch 実装・プローブパス・タイムアウトの差し替え（省略可）。
   * @returns 到達できた {@link HubEndpoint}。
   * @throws {Error} 候補が空、またはすべて不達の場合。
   */
  async resolveReachable(
    endpoints: HubEndpoint[],
    options: ResolveReachableOptions = {}
  ): Promise<HubEndpoint> {
    if (endpoints.length === 0) {
      throw new Error('no hub endpoint configured')
    }
    const fetchImpl = options.fetchImpl ?? fetch
    const probePath = options.probePath ?? DEFAULT_PROBE_PATH
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

    for (const endpoint of endpoints) {
      if (await this.isReachable(endpoint, fetchImpl, probePath, timeoutMs)) {
        return endpoint
      }
    }

    const tried = endpoints.map((e) => `  - ${endpointBaseUrl(e)} (${e.label})`).join('\n')
    throw new Error(`could not reach any hub endpoint. Tried:\n${tried}`)
  }

  /**
   * 単一エンドポイントへ GET プローブを投げ、到達可否を返す。
   *
   * HTTP 応答が返れば（ステータス不問で）到達とみなす。fetch が reject する接続不能・タイムアウトは
   * 不達として `false` を返す（例外は握りつぶし、呼び出し側の順次試行を止めない）。
   *
   * @param endpoint プローブ対象。
   * @param fetchImpl HTTP 実装。
   * @param probePath GET するパス。
   * @param timeoutMs 打ち切り時間（ミリ秒）。
   * @returns 到達できたら true。
   */
  private async isReachable(
    endpoint: HubEndpoint,
    fetchImpl: typeof fetch,
    probePath: string,
    timeoutMs: number
  ): Promise<boolean> {
    try {
      await fetchImpl(`${endpointBaseUrl(endpoint)}${probePath}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      })
      return true
    } catch {
      return false
    }
  }
}
