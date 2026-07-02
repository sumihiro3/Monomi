import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { EventRepository } from '../db/repositories/event-repository.js'
import { InstanceRepository } from '../db/repositories/instance-repository.js'
import { PrStatusRepository } from '../db/repositories/pr-status-repository.js'
import { ProjectRepository } from '../db/repositories/project-repository.js'
import { SessionRepository } from '../db/repositories/session-repository.js'
import { TokenRepository } from '../db/repositories/token-repository.js'
import type { Database } from '../db/database.js'
import { epochMsNow, type EpochMs } from '../domain/time.js'
import { EscalationThresholds } from '../status/escalation.js'
import { AuthResolver } from './auth-resolver.js'
import { EventsController } from './controllers/events-controller.js'
import { InstancesController } from './controllers/instances-controller.js'
import { EventIngestionService } from './event-ingestion-service.js'
import { InstanceStatusService } from './instance-status-service.js'
import { Router } from './router.js'
import { TokenService } from './token-service.js'

/** release-1 は同一マシン通信のみ（§3.1）。既定で loopback にのみバインドする。 */
const DEFAULT_HOST = '127.0.0.1'

/** リクエストボディの最大許容サイズ（byte）。個人利用の hook ペイロードには十分な上限。 */
const MAX_BODY_BYTES = 1_000_000

/** JSON パース不能なボディを表す番兵エラー（400 へ写すため一般 `Error` と区別する）。 */
class InvalidJsonBodyError extends Error {}

/** 最大サイズ超過を表す番兵エラー（413 へ写す）。 */
class PayloadTooLargeError extends Error {}

/** {@link createHubServer} の任意依存（テスト時の決定性のために時刻・閾値を注入できる）。 */
export interface HubServerOptions {
  /** status 導出・ingest の権威時刻の供給関数。省略時は {@link epochMsNow}。 */
  now?: () => EpochMs
  /** 放置昇格閾値（config 由来）。省略時は既定 2h/6h/24h/72h。 */
  thresholds?: EscalationThresholds
}

/**
 * DB ハンドルから Repository → UseCase → Controller → Router を配線し、待受準備の整った
 * {@link HttpServer} を返す（class-diagram §3 の DI 配線）。
 *
 * 閾値の config 上書きは HttpServer 起動時に注入する設計（class-diagram 未解決点の確定）で、
 * 呼び出し元（{@link ./serve.js serve}）が config から組み立てた {@link EscalationThresholds}
 * を渡す。全ルートは同一の {@link AuthResolver} で認証ゲートされる（HttpServer の前段で適用）。
 *
 * @param db 初期化済みの hub データベース。
 * @param options 時刻・閾値の注入（省略可）。
 * @returns ルート登録済みの {@link HttpServer}。
 */
export function createHubServer(db: Database, options: HubServerOptions = {}): HttpServer {
  const now = options.now ?? epochMsNow
  const thresholds = options.thresholds ?? EscalationThresholds.withDefaults()

  const devices = new DeviceRepository(db)
  const projects = new ProjectRepository(db)
  const instances = new InstanceRepository(db)
  const sessions = new SessionRepository(db)
  const events = new EventRepository(db)
  const tokens = new TokenRepository(db)
  const prStatus = new PrStatusRepository(db)

  const tokenService = new TokenService(tokens, devices)
  const authResolver = new AuthResolver(tokenService)

  const ingestion = new EventIngestionService(devices, projects, instances, sessions, events, now)
  const statusService = new InstanceStatusService(
    instances,
    sessions,
    events,
    projects,
    devices,
    prStatus,
    thresholds
  )

  const eventsController = new EventsController(ingestion)
  const instancesController = new InstancesController(statusService, now)

  const router = new Router()
    .add('POST', '/api/v1/events', (req) => eventsController.handlePost(req))
    .add('GET', '/api/v1/instances', (req) => instancesController.handleList(req))
    .add('GET', '/api/v1/instances/:id', (req) => instancesController.handleDetail(req))

  return new HttpServer(router, authResolver)
}

/**
 * node:http による hub API サーバ（class-diagram §3 `HttpServer`）。
 *
 * リクエストパイプライン: ルート照合 → 認証（全ルートに {@link AuthResolver} を適用、
 * トークン無し/無効は 401、FR-03 AC-5）→ ボディ JSON パース（POST 系のみ）→ ハンドラ実行
 * → JSON 応答。境界での時刻変換（wire は ISO8601、内部は epoch ms、§0.5）は Controller/DTO
 * 側が担い、本クラスは HTTP の入出力にのみ責任を持つ。release-1 は同一マシン通信のみのため
 * 既定で loopback にバインドする。
 */
export class HttpServer {
  private readonly server: http.Server

  /**
   * @param router ルート照合器（登録済み）。
   * @param authResolver 全ルート共通の認証ミドルウェア。
   */
  constructor(
    private readonly router: Router,
    private readonly authResolver: AuthResolver
  ) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  /**
   * サーバを起動する。
   *
   * @param port 待受ポート（`0` で OS 割当のエフェメラルポート＝テスト用）。
   * @param host バインド先ホスト。省略時は loopback（`127.0.0.1`）。
   * @returns 実際に待ち受けているポート番号。
   */
  listen(port: number, host: string = DEFAULT_HOST): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      this.server.once('error', onError)
      this.server.listen(port, host, () => {
        this.server.removeListener('error', onError)
        const address = this.server.address() as AddressInfo | null
        resolve(address ? address.port : port)
      })
    })
  }

  /**
   * サーバを停止する。keep-alive で滞留した接続も明示的に切ってテストのハングを防ぐ。
   *
   * @returns 停止完了で解決する Promise。
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) {
        resolve()
        return
      }
      this.server.close((err) => (err ? reject(err) : resolve()))
      this.server.closeAllConnections()
    })
  }

  /**
   * 1 リクエストを処理する（パイプライン本体）。
   *
   * @param req node のリクエスト。
   * @param res node のレスポンス。
   */
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://localhost')
      const routeMatch = this.router.match(method, url.pathname)

      if (routeMatch.kind === 'not_found') {
        this.send(res, 404, { error: 'not_found' })
        return
      }
      if (routeMatch.kind === 'method_not_allowed') {
        this.send(res, 405, { error: 'method_not_allowed' })
        return
      }

      // 全ルートに認証を適用（§0.3 / FR-03 AC-5）。
      const device = this.authResolver.resolveDevice({
        headers: { authorization: req.headers.authorization },
      })
      if (device === null) {
        this.send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
        return
      }

      let body: unknown
      if (hasRequestBody(method)) {
        try {
          body = await readJsonBody(req)
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            this.send(res, 413, { error: 'payload_too_large' })
          } else {
            this.send(res, 400, { error: 'invalid_json' })
          }
          return
        }
      }

      const response = await routeMatch.handler({ params: routeMatch.params, body, device })
      this.send(res, response.status, response.body, response.headers)
    } catch {
      // Controller が写し損ねた想定外例外はすべて 500 に畳む（詳細は漏らさない）。
      this.send(res, 500, { error: 'internal_error' })
    }
  }

  /**
   * JSON 応答を書き出す。
   *
   * @param res node のレスポンス。
   * @param status HTTP ステータス。
   * @param body 応答ボディ（JSON へシリアライズ）。
   * @param headers 追加ヘッダ（省略可）。
   */
  private send(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(body))
  }
}

/** ボディを持ち得る HTTP メソッドか。 */
function hasRequestBody(method: string): boolean {
  const upper = method.toUpperCase()
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH'
}

/**
 * リクエストボディを読み切って JSON としてパースする。
 *
 * 空ボディは `undefined` を返す（後段の zod 検証で 400 になる）。{@link MAX_BODY_BYTES} を
 * 超えたら {@link PayloadTooLargeError}、JSON として不正なら {@link InvalidJsonBodyError} を投げる。
 *
 * @param req node のリクエスト。
 * @returns パース済みボディ、または空なら `undefined`。
 */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new InvalidJsonBodyError())
      }
    })
    req.on('error', reject)
  })
}
