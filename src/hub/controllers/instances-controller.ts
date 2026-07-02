import { epochMsNow, type EpochMs } from '../../domain/time.js'
import { epochMsToIso8601 } from '../dto.js'
import type { InstanceStatusService } from '../instance-status-service.js'
import type { HubRequest, HubResponse } from '../router.js'

/**
 * `GET /api/v1/instances` / `GET /api/v1/instances/:id` の Controller
 * （class-diagram §3 / FR-03 / §8.2）。
 *
 * status 導出は {@link InstanceStatusService} に委譲し、Controller は wire 応答（一覧は
 * `generated_at` + `instances[]` のエンベロープ、詳細はオブジェクトそのもの）への写像に
 * 徹する。導出の権威時刻（received_at 基準の now、§0.5）は注入された時計から 1 回だけ採取し、
 * 同一応答内の `generated_at` と status 計算で同じ値を使う。
 */
export class InstancesController {
  /**
   * @param statusService 一覧・詳細の status 導出 UseCase。
   * @param now hub の現在時刻の供給関数（テストで決定性を得るため注入可能。省略時は {@link epochMsNow}）。
   */
  constructor(
    private readonly statusService: InstanceStatusService,
    private readonly now: () => EpochMs = epochMsNow
  ) {}

  /**
   * 稼働中 instance を導出済みステータス付きで一覧する（§8.2）。
   *
   * @param _req 認証済みリクエスト（本ルートは body/param を使わない）。
   * @returns 200。`{ generated_at, instances[] }`。
   */
  handleList(_req: HubRequest): HubResponse {
    const now = this.now()
    const instances = this.statusService.listInstances(now)
    return {
      status: 200,
      body: { generated_at: epochMsToIso8601(now), instances },
    }
  }

  /**
   * 1 instance の詳細（一覧 1 行 + 直近イベント）を返す（§8.2 / §10.4）。
   *
   * @param req 認証済みリクエスト（`params.id` に instance id）。
   * @returns 存在すれば 200（{@link ../dto.js InstanceDetail}）、無ければ 404。
   */
  handleDetail(req: HubRequest): HubResponse {
    const now = this.now()
    const detail = this.statusService.getInstanceDetail(req.params.id, now)
    if (detail === null) {
      return { status: 404, body: { error: 'instance_not_found' } }
    }
    return { status: 200, body: detail }
  }
}
