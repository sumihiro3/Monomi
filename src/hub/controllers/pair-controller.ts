import {
  epochMsToIso8601,
  type PairClaimResponse,
  pairClaimPayloadSchema,
  type PairStartResponse,
} from '../dto.js'
import { isLoopbackAddress } from '../loopback.js'
import type { PairingService } from '../pairing-service.js'
import type { HubResponse, PublicHubRequest } from '../router.js'

/**
 * `POST /api/v1/pair/start` / `POST /api/v1/pair/claim` の Controller（§9 / class-diagram §3 / FR-02）。
 *
 * class-diagram の通り本 Controller だけは {@link ../auth-resolver.js AuthResolver} を通さない
 * public ルート（認証スキップ）を担う。認可は HTTP の入出力変換の一部として `remoteAddress`
 * （`pair/start` の loopback 判定）とコード照合（`pair/claim`）で行い、業務ロジックは
 * {@link PairingService} へ委譲する。
 */
export class PairController {
  /**
   * @param pairing 6 桁コードの発行・照合を担う {@link PairingService}。
   */
  constructor(private readonly pairing: PairingService) {}

  /**
   * コードを発行する。loopback からのリクエストのみ受け付ける（§9 / FR-02 AC-2）。
   *
   * @param req public リクエスト（未認証。`remoteAddress` で送信元を判定）。
   * @returns loopback なら 200（`code`+`expires_at`+`ttl_seconds`）、それ以外は 403。
   */
  handleStart(req: PublicHubRequest): HubResponse {
    if (!isLoopbackAddress(req.remoteAddress)) {
      return {
        status: 403,
        body: {
          error: 'loopback_required',
          message: 'pair/start is only accepted from loopback (127.0.0.0/8 or ::1)',
        },
      }
    }
    const pairing = this.pairing.startPairing()
    const body: PairStartResponse = {
      code: pairing.code,
      expires_at: epochMsToIso8601(pairing.expiresAt),
      ttl_seconds: Math.round(pairing.ttlMs / 1000),
    }
    return { status: 200, body }
  }

  /**
   * コードを照合して child 用 device_token を発行する（§9 / FR-02 AC-3/AC-4/AC-5）。
   *
   * 未認証で受け、ペイロードの `device_id`/`name` で child を登録する（トークン発行前なので
   * body の申告値を用いる、§0.3）。TTL 切れ・無効化・不一致はそれぞれ 400 の判別可能な
   * エラーで返す（AC-5）。申告 device_id が既存かつ有効トークン保持なら乗っ取りとみなし 409
   * `device_conflict` を返し、`monomi hub devices revoke <id>` を案内する（§0.3）。
   *
   * @param req public リクエスト（未認証。`body` に {@link pairClaimPayloadSchema} 形状）。
   * @returns 成功時 200（`token`+`device_id`+`role`）、ペイロード不正/コード不正時 400、乗っ取り時 409。
   */
  handleClaim(req: PublicHubRequest): HubResponse {
    const parsed = pairClaimPayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid_payload', issues: parsed.error.issues } }
    }

    const { code, device_id, name } = parsed.data
    const result = this.pairing.claim(code, { deviceId: device_id, name })
    if (result.ok) {
      const body: PairClaimResponse = {
        token: result.token,
        device_id: result.deviceId,
        role: 'child',
      }
      return { status: 200, body }
    }
    if (result.reason === 'expired') {
      return {
        status: 400,
        body: {
          error: 'code_expired',
          message: 'pairing code has expired; run `monomi hub pair` again for a new code',
        },
      }
    }
    if (result.reason === 'device_conflict') {
      return {
        status: 409,
        body: {
          error: 'device_conflict',
          message: `device_id '${device_id}' already has an active token; run \`monomi hub devices revoke ${device_id}\` before re-pairing`,
        },
      }
    }
    return {
      status: 400,
      body: {
        error: 'invalid_code',
        message:
          'pairing code is invalid, already used, or has been invalidated by too many attempts',
      },
    }
  }
}
