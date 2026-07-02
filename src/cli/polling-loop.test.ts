import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusRow } from '../hub/dto.js'
import { HubApiClient } from './hub-api-client.js'
import { endpointBaseUrl, type HubEndpoint, HubEndpointResolver } from './hub-endpoint-resolver.js'
import { PollingLoop, type ReresolveClient } from './polling-loop.js'

/** テスト用 fetch のシグネチャ（mock.calls の tuple 型を (url, init) に固定するため）。 */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** 型付き fetch モックを作る（hub-api-client.test.ts / hub-endpoint-resolver.test.ts と同じ流儀）。 */
function mockFetch(impl: FetchImpl): ReturnType<typeof vi.fn<FetchImpl>> {
  return vi.fn(impl)
}

/** 接続不能（fetch 自体が reject）をシミュレートする。 */
function connectionRefused(): never {
  throw new TypeError('fetch failed')
}

/** `GET /api/v1/instances` の 200 エンベロープを返す。 */
function instancesResponse(instances: InstanceStatusRow[]): Response {
  return new Response(JSON.stringify({ generated_at: '2026-07-02T00:00:00.000Z', instances }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const LAN: HubEndpoint = { host: '192.168.1.100', port: 47632, label: 'lan' }
const TAILSCALE: HubEndpoint = { host: '100.64.1.2', port: 47632, label: 'tailscale' }

/** 表示に効く最小フィールドだけ詰めた instance 行を作る。 */
function makeRow(id: string): InstanceStatusRow {
  return {
    instance_id: id,
    project: { id: `proj-${id}`, name: `Project-${id}` },
    device: { id: 'macmini', name: 'Mac mini' },
    path: `/dev/${id}`,
    branch: 'main',
    status: {
      display: 'active',
      raw_state: 'active',
      elapsed_seconds: 1,
      is_stale: false,
      priority: 1,
    },
    pr: { state: 'none' },
    session: { id: `sess-${id}`, last_heartbeat_at: null },
  }
}

/** HubApiClient を baseUrl + fetchImpl で組む（token は本テストの検証対象外なので付けない）。 */
function client(endpoint: HubEndpoint, fetchImpl: FetchImpl): HubApiClient {
  return new HubApiClient({
    baseUrl: endpointBaseUrl(endpoint),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

describe('PollingLoop.refresh — 再解決フォールバック（#1 / FR-05）', () => {
  it('初回エンドポイント失敗→再解決→次 tick で別エンドポイント成功', async () => {
    const rows = [makeRow('1')]
    // 単一の fetch を URL でルーティング: LAN は不達、Tailscale は 200。
    // createHubConnection の reresolve クロージャと同じく HubEndpointResolver で選び直す。
    const fetchImpl = mockFetch(async (input) => {
      const url = String(input)
      if (url.startsWith(endpointBaseUrl(LAN))) {
        return connectionRefused()
      }
      return instancesResponse(rows)
    })
    const resolver = new HubEndpointResolver()
    const reresolve: ReresolveClient = async () => {
      const endpoint = await resolver.resolveReachable([LAN, TAILSCALE], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      return client(endpoint, fetchImpl)
    }

    // 初回クライアントは不達の LAN に張られている。
    const loop = new PollingLoop(client(LAN, fetchImpl), 3000, reresolve)
    const updates: InstanceStatusRow[][] = []
    const errors: unknown[] = []
    loop.onUpdate((r) => updates.push(r))
    loop.onError((e) => errors.push(e))

    // tick 1: LAN で失敗 → error 通知 → 再解決で Tailscale クライアントへ差し替え。
    await loop.refresh()
    expect(errors).toHaveLength(1)
    expect(updates).toHaveLength(0)

    // tick 2: 差し替わった Tailscale クライアントで取得成功。
    await loop.refresh()
    expect(updates).toHaveLength(1)
    expect(updates[0]).toEqual(rows)
    // 2 回目のエラーは出ない（別エンドポイントで成功したため）。
    expect(errors).toHaveLength(1)
  })

  it('再解決自体が全不達でも例外を投げずポーリングを継続する（best-effort）', async () => {
    const fetchImpl = mockFetch(async () => connectionRefused())
    const resolver = new HubEndpointResolver()
    const reresolve = vi.fn<ReresolveClient>(async () => {
      // 全候補不達 → resolveReachable が例外を投げる（本番の全滅ケース）。
      const endpoint = await resolver.resolveReachable([LAN], {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      return client(endpoint, fetchImpl)
    })

    const loop = new PollingLoop(client(LAN, fetchImpl), 3000, reresolve)
    const errors: unknown[] = []
    loop.onError((e) => errors.push(e))

    // 再解決が reject しても refresh は resolve し、error 通知だけ出る。
    await expect(loop.refresh()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(reresolve).toHaveBeenCalledTimes(1)

    // 既存クライアント（LAN）を保持したまま次 tick も通常のエラーフローに戻る。
    await loop.refresh()
    expect(errors).toHaveLength(2)
    expect(reresolve).toHaveBeenCalledTimes(2)
  })

  it('回帰: reresolve 未注入なら初回のみ解決フローを維持する（失敗しても差し替えない）', async () => {
    // 常に不達。reresolve を渡さない = 初回に解決したクライアントを使い続ける従来挙動。
    const fetchImpl = mockFetch(async () => connectionRefused())
    const loop = new PollingLoop(client(LAN, fetchImpl))
    const updates: InstanceStatusRow[][] = []
    const errors: unknown[] = []
    loop.onUpdate((r) => updates.push(r))
    loop.onError((e) => errors.push(e))

    await loop.refresh()
    await loop.refresh()

    // 毎回同じ（不達の）クライアントを叩き、error 通知のみ。再解決は発生しない。
    expect(updates).toHaveLength(0)
    expect(errors).toHaveLength(2)
    // 2 回とも同じ LAN エンドポイントを叩いている（差し替えなし）。
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).toBe(`${endpointBaseUrl(LAN)}/api/v1/instances`)
    }
  })

  it('回帰: 取得成功時は reresolve を呼ばず update だけ配る', async () => {
    const rows = [makeRow('1')]
    const fetchImpl = mockFetch(async () => instancesResponse(rows))
    const reresolve = vi.fn<ReresolveClient>(async () => client(TAILSCALE, fetchImpl))

    const loop = new PollingLoop(client(LAN, fetchImpl), 3000, reresolve)
    const updates: InstanceStatusRow[][] = []
    loop.onUpdate((r) => updates.push(r))

    await loop.refresh()

    expect(updates).toEqual([rows])
    expect(reresolve).not.toHaveBeenCalled()
  })
})
