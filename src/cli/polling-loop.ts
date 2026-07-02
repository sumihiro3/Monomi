import type { InstanceStatusRow } from '../hub/dto.js'
import type { HubApiClient } from './hub-api-client.js'

/** watch モードの既定ポーリング間隔（§8.2 / 非機能要件: 既定 3s、config で上書き可）。 */
export const DEFAULT_POLL_INTERVAL_MS = 3000

/** 取得成功時の通知リスナー。 */
export type InstancesListener = (rows: InstanceStatusRow[]) => void

/** 取得失敗時の通知リスナー。 */
export type ErrorListener = (error: unknown) => void

/**
 * watch モードのポーリング制御（class-diagram §4 / §8.2）。
 *
 * SSE/WebSocket は使わず、`GET /api/v1/instances` を数秒おきに叩き直す単純ポーリング
 * （個人利用規模のため、§8.2）。1 回だけの取得（初期表示）と、間隔ポーリング（watch ON）の
 * 両方を担う。取得結果は登録済みリスナーへ配る（View への反映は AppView の関心事）。
 */
export class PollingLoop {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly updateListeners = new Set<InstancesListener>()
  private readonly errorListeners = new Set<ErrorListener>()
  /** 進行中の取得があるかどうか。多重取得（前回未完了のまま次 tick）を抑止する。 */
  private inFlight = false

  /**
   * @param client hub への読み取りクライアント。
   * @param intervalMs 既定のポーリング間隔（省略時 {@link DEFAULT_POLL_INTERVAL_MS}）。
   */
  constructor(
    private readonly client: HubApiClient,
    private readonly intervalMs: number = DEFAULT_POLL_INTERVAL_MS
  ) {}

  /**
   * 取得成功リスナーを登録する。
   *
   * @param listener instance 行を受け取るコールバック。
   */
  onUpdate(listener: InstancesListener): void {
    this.updateListeners.add(listener)
  }

  /**
   * 取得失敗リスナーを登録する。
   *
   * @param listener エラーを受け取るコールバック。
   */
  onError(listener: ErrorListener): void {
    this.errorListeners.add(listener)
  }

  /**
   * 1 回だけ取得してリスナーへ配る（初期表示・手動更新用）。
   *
   * 進行中の取得がある場合は何もしない（多重取得の抑止）。失敗は例外を投げず
   * error リスナーへ配る（ポーリングが 1 回の失敗で止まらないようにする）。
   *
   * @returns 取得と通知の完了を表す Promise。
   */
  async refresh(): Promise<void> {
    if (this.inFlight) {
      return
    }
    this.inFlight = true
    try {
      const rows = await this.client.listInstances()
      for (const listener of this.updateListeners) {
        listener(rows)
      }
    } catch (error) {
      for (const listener of this.errorListeners) {
        listener(error)
      }
    } finally {
      this.inFlight = false
    }
  }

  /**
   * ポーリングを開始する（watch モード ON）。開始時に即 1 回取得する。
   *
   * 既に稼働中なら何もしない（冪等）。プロセスの終了を妨げないよう timer は `unref` する。
   *
   * @param intervalMs 間隔の上書き（省略時はコンストラクタ既定）。
   */
  start(intervalMs: number = this.intervalMs): void {
    if (this.timer !== null) {
      return
    }
    void this.refresh()
    this.timer = setInterval(() => {
      void this.refresh()
    }, intervalMs)
    // Node の timer は unref 可能。存在チェックしてから呼ぶ（型・環境差の保険）。
    this.timer.unref?.()
  }

  /**
   * ポーリングを停止する（watch モード OFF）。停止済みなら何もしない。
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * ポーリング中（watch モード ON）かどうか。
   *
   * @returns 稼働中なら true。
   */
  isRunning(): boolean {
    return this.timer !== null
  }
}
