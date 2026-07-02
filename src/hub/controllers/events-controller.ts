import { z } from 'zod'
import type { EventIngestionService } from '../event-ingestion-service.js'
import type { HubRequest, HubResponse } from '../router.js'

/**
 * `POST /api/v1/events` の Controller（class-diagram §3 / FR-03 AC-1）。
 *
 * HTTP 入出力の薄い変換に徹し、業務ロジックは {@link EventIngestionService} に委譲する。
 * §0.3 のなりすまし書き込み防止のため、**ボディの `device_id` は無視し、認証済み device の
 * id で必ず上書き**してから ingest へ渡す（Bearer トークンから解決した値が唯一の権威）。
 * zod 検証エラーは 400、成功は 201 に写す。未登録 device 由来の例外は認証済み device を
 * 充填する構造上起こり得ないため、想定外例外として HttpServer 側の 500 に委ねる。
 */
export class EventsController {
  /**
   * @param ingestion イベント受信 UseCase。
   */
  constructor(private readonly ingestion: EventIngestionService) {}

  /**
   * イベントを 1 件受信して永続化する（§8.1）。
   *
   * @param req 認証済みリクエスト（`body` に生ペイロード、`device` に送信元）。
   * @returns 成功時 201（採番 id 等の ack）、ペイロード不正時 400。
   */
  handlePost(req: HubRequest): HubResponse {
    const base = typeof req.body === 'object' && req.body !== null ? req.body : {}
    // device_id はスプレッドの後に置き、ボディ指定を認証済み device の id で上書きする（§0.3）。
    const payload = { ...base, device_id: req.device.id }

    try {
      const result = this.ingestion.ingest(payload)
      return {
        status: 201,
        body: {
          ok: true,
          event_id: result.event.id,
          instance_id: result.instanceId,
          project_id: result.projectId,
        },
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        return { status: 400, body: { error: 'invalid_payload', issues: err.issues } }
      }
      throw err
    }
  }
}
