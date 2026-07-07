import fs from 'node:fs'
import type { MonomiPaths } from '../config/paths.js'

/**
 * hub の稼働状態（FR-02 AC-1）。
 *
 * - `running`: port へ疎通できる（= hub がリクエストに応答できている）。pid ファイルが存在し
 *   その pid のプロセスが生存していれば pid/port を伴って報告し、pid ファイルが無い/古い場合
 *   （既存の pm2/launchd 常駐や旧バージョンからの引き継ぎ）でも port 疎通のみで `running` とする。
 * - `stopped`: pid ファイルが無く、port にも疎通できない（正常終了後の既定状態）。
 * - `stale`: pid ファイルはあるがそのプロセスが不在（クラッシュ等で pid ファイルだけ残った状態）。
 *   port 疎通の有無に関わらず、この判定を最優先する（`isProcessAlive` が唯一の生存確認手段のため）。
 */
export type HubLifecycleState = 'running' | 'stopped' | 'stale'

/** {@link hubStatus} の結果（FR-02 AC-1）。 */
export interface HubStatusResult {
  /** 3状態のいずれか。 */
  state: HubLifecycleState
  /** 生存確認できた pid（`running`/`stale` かつ判明している場合のみ）。 */
  pid?: number
  /** 疎通確認したポート（`running` の場合のみ）。 */
  port?: number
}

/** {@link hubStatus} の依存差し替え（テスト用）。 */
export interface HubStatusOptions {
  /** プロセス生存確認の差し替え。省略時は {@link isProcessAlive}。 */
  isAlive?: (pid: number) => boolean
  /** port 疎通確認の差し替え。省略時は {@link isPortReachable}。 */
  checkPort?: (port: number) => Promise<boolean>
}

/** {@link hubStop} の結果。 */
export interface HubStopResult {
  /**
   * 実際に SIGTERM を送って終了を確認できたら true。pid ファイルが無い/既に停止済み（stale pid
   * 含む）なら false（AC-2、エラーにしない）。SIGTERM を送ったが `waitMs` 内に終了確認できなかった
   * 場合も false（プロセスはまだ生存しているため pid ファイルは削除しない。呼び出し側が再試行・
   * 強制終了を判断できるようにする）。
   */
  stopped: boolean
  /** 対象にした pid（不明なら undefined）。 */
  pid?: number
  /** SIGTERM 送信後、`waitMs` 内に終了を確認できなかった場合に true（プロセスは生存継続中）。 */
  timedOut?: boolean
}

/** {@link hubStop} の依存差し替え（テスト用）。 */
export interface HubStopOptions {
  /** プロセス生存確認の差し替え。省略時は {@link isProcessAlive}。 */
  isAlive?: (pid: number) => boolean
  /** 停止シグナル送信の差し替え。省略時は `process.kill`。 */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void
  /** 終了確認の総待機時間（ミリ秒）。省略時 5000。 */
  waitMs?: number
  /** 終了確認のポーリング間隔（ミリ秒）。省略時 100。 */
  pollIntervalMs?: number
  /** ポーリング間の待機実装の差し替え（テストで実時間待機を避けるため）。省略時は実 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>
}

/** {@link hubStop} の既定の終了確認待機時間（ミリ秒）。 */
const DEFAULT_STOP_WAIT_MS = 5000

/** {@link hubStop} の既定のポーリング間隔（ミリ秒）。 */
const DEFAULT_STOP_POLL_INTERVAL_MS = 100

/** {@link isPortReachable} の到達性プローブに使う既定 GET パス（認証必須ルート。401 でも「到達」と判定する）。 */
const DEFAULT_PROBE_PATH = '/api/v1/instances'

/** {@link isPortReachable} の既定タイムアウト（ミリ秒）。不達ホストで長時間ブロックしないため。 */
const DEFAULT_PORT_CHECK_TIMEOUT_MS = 2000

/**
 * `~/.monomi/hub.pid` へ自 pid を書き込む（FR-02。`serve()` が起動成功時に呼ぶ）。
 *
 * 既存ファイルがあっても無条件に上書きする（stale pid の自己回復。既知課題 U10 の設計方針）。
 *
 * @param paths `~/.monomi` パス集合。
 * @param pid 書き込む pid（通常は `process.pid`）。
 */
export function writeHubPidFile(paths: MonomiPaths, pid: number): void {
  fs.writeFileSync(paths.hubPidFile, String(pid))
}

/**
 * `~/.monomi/hub.pid` を読み込む。
 *
 * ファイルが無い、または内容が pid として解釈できない（空・非数値）場合は `undefined` を返す
 * （例外を投げて呼び出し側の status/stop 判定を止めないため）。
 *
 * @param paths `~/.monomi` パス集合。
 * @returns 読み取れた pid、または `undefined`。
 */
export function readHubPidFile(paths: MonomiPaths): number | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(paths.hubPidFile, 'utf8').trim()
  } catch {
    return undefined
  }
  if (raw.length === 0) {
    return undefined
  }
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * `~/.monomi/hub.pid` を削除する（無ければ何もしない）。
 *
 * @param paths `~/.monomi` パス集合。
 */
export function removeHubPidFile(paths: MonomiPaths): void {
  fs.rmSync(paths.hubPidFile, { force: true })
}

/** `process.kill` と同じ signature の型。{@link isProcessAlive} の signal 送信部分を差し替える。 */
export type KillFn = typeof process.kill

/** {@link isProcessAlive} の依存差し替え（テスト用）。 */
export interface ProcessAliveOptions {
  /** 省略時は `process.kill`。 */
  kill?: KillFn
}

/**
 * 指定 pid のプロセスが生存しているかを確認する（signal 0 送信。実際には kill しない）。
 *
 * `無検証 kill をしない`（§非機能要件）の一環として、{@link hubStop} は必ずこの確認を経てから
 * SIGTERM を送る。ESRCH（対象無し）以外の例外（EPERM 等、他ユーザーの pid を再利用した場合）は
 * 「少なくとも何かが生きている」と見なし true を返す（誤って無関係プロセスへの signal 送信対象から
 * 除外しないための保守的な判定）。
 *
 * @param pid 確認対象の pid。
 * @param options `process.kill` の差し替え（省略可、テスト用。`hubStatus`/`hubStop` はさらに上位の
 *   `isAlive` 差し替えを持つため通常はこちらを直接注入する必要はない）。
 * @returns 生存していれば true。
 */
export function isProcessAlive(pid: number, options: ProcessAliveOptions = {}): boolean {
  const kill = options.kill ?? process.kill
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return !(err instanceof Error && 'code' in err && err.code === 'ESRCH')
  }
}

/** {@link isPortReachable} の依存差し替え（テスト用）。 */
export interface PortReachableOptions {
  /** HTTP 実装（省略時はグローバル `fetch`）。テストで注入する。 */
  fetchImpl?: typeof fetch
  /** 到達性判定に使う GET パス（既定 {@link DEFAULT_PROBE_PATH}）。 */
  probePath?: string
  /** 打ち切り時間（ミリ秒、既定 2000）。不達ホストで長時間ブロックしないため。 */
  timeoutMs?: number
}

/**
 * `127.0.0.1:port` への HTTP 疎通を確認する（hub が port で応答しているかの確認、FR-02）。
 *
 * `src/cli/hub-endpoint-resolver.ts` の `isReachable`/`localhostEndpoint` と同じ「GET して
 * 応答が返れば（ステータス不問で）到達、fetch 自体が reject する（接続不能・タイムアウト）場合
 * のみ不達」という判定パターンを再利用する。hub レイヤーは cli レイヤーに依存しない方針
 * （class-diagram: hub→status の依存方向を保つ）のため、同パターンをこのモジュール内に
 * 別実装として持つ（ロジックの二重実装ではあるが、依存方向の一貫性を優先した意図的な選択）。
 *
 * @param port 確認対象ポート。
 * @param options fetch 実装・プローブパス・タイムアウトの差し替え（省略可）。
 * @returns 応答が返れば true。fetch が reject する場合は false。
 */
export async function isPortReachable(
  port: number,
  options: PortReachableOptions = {}
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch
  const probePath = options.probePath ?? DEFAULT_PROBE_PATH
  const timeoutMs = options.timeoutMs ?? DEFAULT_PORT_CHECK_TIMEOUT_MS

  try {
    await fetchImpl(`http://127.0.0.1:${port}${probePath}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return true
  } catch {
    return false
  }
}

/**
 * hub の稼働状態を判定する（`monomi hub status` の実体 / FR-02 AC-1）。
 *
 * 判定順序（{@link HubLifecycleState} の各状態の説明を参照）:
 * 1. pid ファイルがあり、そのプロセスが不在 → `stale`（他の signal より優先。壊れたファイルの
 *    残存を最優先で知らせる）
 * 2. port に疎通できる → `running`（pid ファイル由来の pid が生存していれば併記、無ければ pid 省略）
 * 3. それ以外 → `stopped`
 *
 * @param paths `~/.monomi` パス集合。
 * @param port 確認対象ポート（config.port）。
 * @param options 生存確認・port 疎通確認の差し替え（省略可）。
 * @returns 判定済みの {@link HubStatusResult}。
 */
export async function hubStatus(
  paths: MonomiPaths,
  port: number,
  options: HubStatusOptions = {}
): Promise<HubStatusResult> {
  const isAlive = options.isAlive ?? isProcessAlive
  const checkPort = options.checkPort ?? isPortReachable

  const pid = readHubPidFile(paths)
  if (pid !== undefined && !isAlive(pid)) {
    return { state: 'stale', pid }
  }

  const reachable = await checkPort(port)
  if (reachable) {
    return { state: 'running', pid: pid !== undefined ? pid : undefined, port }
  }

  return { state: 'stopped' }
}

/**
 * hub を停止する（`monomi hub stop` の実体 / FR-02 AC-2）。
 *
 * pid ファイルが無い、またはそのプロセスが既に不在なら「停止済み」として `stopped: false` を返す
 * （エラーにしない。ただし残っていた stale pid ファイルは掃除する）。生存していれば SIGTERM を送り、
 * `waitMs` を上限に `pollIntervalMs` 間隔でプロセス終了をポーリングする
 * （§非機能要件「無検証 kill をしない」: 送信前に生存確認済み）。終了を確認できた場合のみ pid
 * ファイルを削除する。`waitMs` 内に終了を確認できなければプロセスは生存継続中とみなし、
 * pid ファイルは残したまま `timedOut: true` を返す（生存中の pid を見失わないため）。
 *
 * @param paths `~/.monomi` パス集合。
 * @param options 生存確認・signal 送信・待機の差し替え（省略可）。
 * @returns 実際に停止させたかを含む {@link HubStopResult}。
 */
export async function hubStop(
  paths: MonomiPaths,
  options: HubStopOptions = {}
): Promise<HubStopResult> {
  const isAlive = options.isAlive ?? isProcessAlive
  const sendSignal =
    options.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const waitMs = options.waitMs ?? DEFAULT_STOP_WAIT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const pid = readHubPidFile(paths)
  if (pid === undefined || !isAlive(pid)) {
    removeHubPidFile(paths)
    return { stopped: false, pid }
  }

  sendSignal(pid, 'SIGTERM')

  let remaining = waitMs
  while (remaining > 0 && isAlive(pid)) {
    await sleep(pollIntervalMs)
    remaining -= pollIntervalMs
  }

  if (isAlive(pid)) {
    return { stopped: false, pid, timedOut: true }
  }

  removeHubPidFile(paths)
  return { stopped: true, pid }
}
