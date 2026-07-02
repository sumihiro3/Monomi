import type { HubApiClient } from './hub-api-client.js'

/** watch モードの既定ポーリング間隔（§8.2 / 非機能要件: 既定 3s、config で上書き可）。 */
export const DEFAULT_POLL_INTERVAL_MS = 3000

/**
 * ポーリング 1 tick で実行する非同期取得（AC-5: 一覧固有ではなく任意の取得を委譲）。
 *
 * 現行の {@link HubApiClient} を引数で受け取る形にすることで、再解決フォールバックで
 * `this.client` が差し替わっても常に最新のクライアントで取得できる（一覧は
 * `(c) => c.listInstances()`、詳細は `(c) => c.getInstanceDetail(id)` のように渡す）。
 */
export type FetchFn<T> = (client: HubApiClient) => Promise<T>

/** 取得成功時の通知リスナー（取得結果 `T` を受け取る）。 */
export type UpdateListener<T> = (value: T) => void

/** 取得失敗時の通知リスナー。 */
export type ErrorListener = (error: unknown) => void

/**
 * 到達先を再解決して新しい {@link HubApiClient} を返すファクトリ（watch 中フォールバック用 / #1・FR-05）。
 *
 * watch 中に接続先 hub が落ちて別エンドポイント（LAN → Tailscale 等）へ移った場合でも、
 * 取得失敗を検知して到達先を選び直せるようにする。中身は {@link ../cli/hub-api-client.js} の
 * `createHubConnection` が {@link HubEndpointResolver} 経由で組み立てる（層分離: {@link HubApiClient}
 * 自体は baseUrl 非依存のまま保つ）。
 */
export type ReresolveClient = () => Promise<HubApiClient>

/**
 * watch モードのポーリング制御（class-diagram §4 / §8.2）。
 *
 * SSE/WebSocket は使わず、取得関数（{@link FetchFn}）を数秒おきに呼び直す単純ポーリング
 * （個人利用規模のため、§8.2）。取得対象は一覧固有ではなく `fetchFn` に委ねる汎用形（AC-5）で、
 * 一覧（`listInstances`）にも詳細（`getInstanceDetail`）にも同じ機構を再利用できる。1 回だけの
 * 取得（初期表示）と、間隔ポーリング（watch ON）の両方を担う。取得結果 `T` は登録済みリスナーへ
 * 配る（View への反映は AppView の関心事）。
 *
 * @typeParam T `fetchFn` が返す取得結果の型（一覧なら `InstanceStatusRow[]`、詳細なら `InstanceDetail`）。
 */
export class PollingLoop<T> {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly updateListeners = new Set<UpdateListener<T>>()
  private readonly errorListeners = new Set<ErrorListener>()
  /** 進行中の取得があるかどうか。多重取得（前回未完了のまま次 tick）を抑止する。 */
  private inFlight = false

  /** hub への読み取りクライアント。再解決フォールバックで差し替わり得るため readonly にしない。 */
  private client: HubApiClient

  /**
   * @param fetchFn 1 tick で実行する取得関数。現行 client を受け取り取得結果 `T` を返す（AC-5）。
   * @param client hub への読み取りクライアント。
   * @param intervalMs 既定のポーリング間隔（省略時 {@link DEFAULT_POLL_INTERVAL_MS}）。
   * @param reresolve 取得失敗時に到達先を選び直すファクトリ（省略時は再解決しない / #1）。
   */
  constructor(
    private readonly fetchFn: FetchFn<T>,
    client: HubApiClient,
    private readonly intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    private readonly reresolve?: ReresolveClient
  ) {
    this.client = client
  }

  /**
   * 取得成功リスナーを登録する。
   *
   * @param listener 取得結果 `T` を受け取るコールバック。
   */
  onUpdate(listener: UpdateListener<T>): void {
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
   * error リスナーへ配る（ポーリングが 1 回の失敗で止まらないようにする）。失敗時に
   * {@link ReresolveClient} が注入されていれば到達先を選び直して次 tick 以降のクライアントを
   * 差し替える（watch 中に hub が別エンドポイントへ移っても追従する / #1）。
   *
   * @returns 取得と通知の完了を表す Promise。
   */
  async refresh(): Promise<void> {
    if (this.inFlight) {
      return
    }
    this.inFlight = true
    try {
      const value = await this.fetchFn(this.client)
      for (const listener of this.updateListeners) {
        listener(value)
      }
    } catch (error) {
      for (const listener of this.errorListeners) {
        listener(error)
      }
      await this.tryReresolve()
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 取得失敗後に到達先を再解決し、成功したら内部クライアントを差し替える（#1・FR-05）。
   *
   * 再解決自体の失敗（全エンドポイント不達など）は握りつぶす。既存クライアントをそのまま保ち、
   * 次 tick で通常の取得→error 通知フローへ戻す（ポーリングを止めない）。今 tick では差し替えた
   * クライアントで再取得はせず、次 tick に委ねる（多重取得を避け、挙動を単純に保つ）。
   *
   * @returns 再解決の試行完了を表す Promise（失敗しても resolve する）。
   */
  private async tryReresolve(): Promise<void> {
    if (this.reresolve === undefined) {
      return
    }
    try {
      this.client = await this.reresolve()
    } catch {
      // 再解決に失敗しても既存クライアントを維持して次 tick へ（フォールバックは best-effort）。
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
