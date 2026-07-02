import type { DeviceRepository } from '../../db/repositories/device-repository.js'
import type { Device } from '../../domain/entities.js'
import { type DeviceDto, epochMsToIso8601 } from '../dto.js'
import { isLoopbackAddress } from '../loopback.js'
import type { HubRequest, HubResponse } from '../router.js'
import type { TokenService } from '../token-service.js'

/**
 * `GET /api/v1/devices` / `POST /api/v1/devices/:id/revoke` の Controller
 * （class-diagram §3 / §9 / FR-03）。
 *
 * HTTP 入出力の薄い変換に徹し、業務は {@link DeviceRepository}（device 列挙・存在確認）と
 * {@link TokenService}（有効トークン有無・device 起点の一括失効）へ委譲する。全ルートは
 * {@link ../http-server.js HttpServer} 前段の {@link ../auth-resolver.js AuthResolver} で
 * 認証ゲートされるため、本 Controller は認証済みリクエストのみを受け取る。加えて、device 管理
 * という機微な操作のため Bearer 認証に上乗せして `req.remoteAddress` の loopback 判定を行う
 * （review #5+#7）。CLI の `monomi hub devices list/revoke` は localhost の hub API を叩くため
 * この上乗せガードを通過する。
 */
export class DevicesController {
  /**
   * @param devices device 列挙・存在確認用の Repository。
   * @param tokens 有効トークン判定・一括失効用の {@link TokenService}。
   */
  constructor(
    private readonly devices: DeviceRepository,
    private readonly tokens: TokenService
  ) {}

  /**
   * 登録デバイスを一覧する（トークン有効/失効を含む、FR-03 AC-1）。
   *
   * @param req 認証済みリクエスト（本ルートは body/param を使わない。`remoteAddress` で
   *   loopback 判定する）。
   * @returns loopback 以外は 403。loopback なら 200。`{ devices[] }`（`first_seen_at` 昇順）。
   */
  handleList(req: HubRequest): HubResponse {
    const guarded = this.requireLoopback(req)
    if (guarded !== null) {
      return guarded
    }
    // 1 クエリで有効トークン保有 device の集合を取得し、以降は Set.has で判定する
    // （review #3: per-device の hasActiveToken 呼び出しによる N+1 を撤廃）。
    const activeDeviceIds = this.tokens.activeDeviceIds()
    const devices = this.devices.list().map((device) => this.toDto(device, activeDeviceIds))
    return { status: 200, body: { devices } }
  }

  /**
   * device に紐づく全ての有効トークンを失効させる（FR-03 AC-2）。失効後は当該トークンでの
   * 認証が 401 になる（{@link TokenService.verify} が `null` を返す）。
   *
   * @param req 認証済みリクエスト（`params.id` に対象 device_id。`remoteAddress` で loopback
   *   判定する）。
   * @returns loopback 以外は 403。存在すれば 200（`{ ok, device_id, revoked }`）、
   *   未登録 device は 404。
   */
  handleRevoke(req: HubRequest): HubResponse {
    const guarded = this.requireLoopback(req)
    if (guarded !== null) {
      return guarded
    }
    const deviceId = req.params.id
    if (this.devices.findById(deviceId) === null) {
      return { status: 404, body: { error: 'device_not_found' } }
    }
    const revoked = this.tokens.revokeAllForDevice(deviceId)
    return { status: 200, body: { ok: true, device_id: deviceId, revoked } }
  }

  /**
   * Bearer 認証に上乗せする loopback 限定ガード（review #5+#7）。
   *
   * @param req 認証済みリクエスト。
   * @returns loopback なら `null`（後続処理を続ける）、非 loopback なら 403 の {@link HubResponse}。
   */
  private requireLoopback(req: HubRequest): HubResponse | null {
    if (isLoopbackAddress(req.remoteAddress)) {
      return null
    }
    return {
      status: 403,
      body: {
        error: 'loopback_required',
        message: 'device management routes are only accepted from loopback (127.0.0.0/8 or ::1)',
      },
    }
  }

  /**
   * {@link Device} を wire の {@link DeviceDto} へ写す（時刻 ISO8601 化・role 小文字化）。
   *
   * @param device 変換対象。
   * @param activeDeviceIds {@link TokenService.activeDeviceIds} で 1 回だけ取得した、有効トークン
   *   を持つ device_id の集合（review #3: per-device 問い合わせを避けるため呼び出し側から渡す）。
   */
  private toDto(device: Device, activeDeviceIds: ReadonlySet<string>): DeviceDto {
    return {
      id: device.id,
      name: device.name,
      role: device.role.toLowerCase(),
      first_seen_at: epochMsToIso8601(device.firstSeenAt),
      last_seen_at: epochMsToIso8601(device.lastSeenAt),
      has_active_token: activeDeviceIds.has(device.id),
    }
  }
}
