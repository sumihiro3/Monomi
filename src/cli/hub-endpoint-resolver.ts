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

/**
 * loopback（localhost）への単一エンドポイントを組み立てる（release-1 の唯一の到達先）。
 *
 * @param port hub の待受ポート。
 * @returns localhost を指す {@link HubEndpoint}。
 */
export function localhostEndpoint(port: number): HubEndpoint {
  return { host: '127.0.0.1', port, label: 'localhost' }
}

/**
 * 複数エンドポイントを順に試して到達できた先を返す想定の resolver（class-diagram §4 / §0.2）。
 *
 * release-1 は endpoint が localhost 1 つのみ（§3.1: 同一マシン内通信）のため、
 * 実際の到達性プローブ（順次フォールバック）は release-2 まで**スタブ**にとどめ、
 * 先頭のエンドポイントをそのまま採用する。マルチエンドポイント配線を後付けできるよう、
 * インターフェースだけ class-diagram に合わせて先に用意しておく。
 */
export class HubEndpointResolver {
  /**
   * 到達可能な最初のエンドポイントを返す。
   *
   * release-1 では到達性プローブを行わず先頭要素を返す（endpoints は常に長さ 1）。
   *
   * @param endpoints 到達先候補（優先順）。
   * @returns 採用したエンドポイント。
   * @throws {Error} 候補が空の場合。
   */
  resolveReachable(endpoints: HubEndpoint[]): HubEndpoint {
    const first = endpoints[0]
    if (first === undefined) {
      throw new Error('no hub endpoint configured')
    }
    return first
  }
}
