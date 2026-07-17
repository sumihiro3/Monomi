import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MonomiRole } from '../config/config.js'
import { ensureMonomiHome, type MonomiPaths } from '../config/paths.js'
import {
  hubStop as hubStopImpl,
  isPortReachable,
  probeHub,
  type HubStopResult,
  type ProbeHubResult,
} from '../hub/hub-lifecycle.js'
import { t } from '../i18n/index.js'
import { compareVersion } from '../version-compare.js'
import { MONOMI_VERSION } from '../version.js'

/**
 * 自パッケージ内 CLI 実体（`dist/bin.js`）への既定パス。
 *
 * `import.meta.url`（このファイル自身の URL）起点で解決するため、npx 実行時のキャッシュ配置
 * （`~/.npm/_npx/<hash>/node_modules/monomi-cli/dist/...`）でも自パッケージ内の bin を正しく指す
 * （`install-hooks.ts` の `DEFAULT_REPORTER_SOURCE` と同パターン）。このファイルはビルド後
 * `dist/cli/hub-autostart.js` に配置され、そこから1階層上（パッケージルート直下）の `bin.js` を
 * 指す相対位置は `src/`・`dist/` いずれのツリーでも変わらない。
 */
const DEFAULT_CLI_ENTRY = new URL('../bin.js', import.meta.url)

/** {@link ensureHubRunning} の既定タイムアウト（ミリ秒）。DB 初期化を含む hub 起動を待つため長め。 */
const DEFAULT_AUTOSTART_TIMEOUT_MS = 10_000

/** {@link ensureHubRunning} の既定ポーリング間隔（ミリ秒）。 */
const DEFAULT_AUTOSTART_POLL_INTERVAL_MS = 200

/**
 * {@link ensureHubRunning} が hub プロセスを起動するのに使う spawn 実装の最小 signature。
 *
 * `node:child_process` の実 `spawn` はこの signature を満たす（呼び出し時に渡す `options` は
 * 実 `spawn` が受け付ける形の部分集合、返り値の `unref` も実 `ChildProcess` が持つ）。
 * テストでは fork/exec を伴わないモックに差し替える。
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached?: boolean; stdio?: Array<'ignore' | number> }
) => { unref: () => void }

/**
 * hub の graceful 停止の差し替え用 signature（`hub-lifecycle.ts` の {@link hubStopImpl}（`hubStop`）
 * と同じ形の部分集合。`ensureHubRunning` は `HubStopOptions`（isAlive/sendSignal/waitMs 等）まで
 * 貫通させず、テストではこの関数ごと丸ごとモックに差し替える前提）。
 */
export type HubStopFn = (paths: MonomiPaths) => Promise<HubStopResult>

/** {@link ensureHubRunning} の依存差し替え（テスト用 / FR-01 AC-1〜AC-4・FR-02 AC-1〜AC-6）。 */
export interface EnsureHubRunningOptions {
  /** port 疎通確認の差し替え（{@link waitUntilReachable} が使う）。省略時は `hub-lifecycle.ts` の {@link isPortReachable}。 */
  isReachable?: (port: number) => Promise<boolean>
  /** hub プロセス spawn の差し替え。省略時は `node:child_process` の実 `spawn`。 */
  spawn?: SpawnFn
  /** 自パッケージ CLI 実体パスの差し替え（テスト用）。省略時は {@link DEFAULT_CLI_ENTRY}。 */
  cliEntry?: string | URL
  /** 起動完了待ちの総タイムアウト（ミリ秒）。省略時 {@link DEFAULT_AUTOSTART_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 疎通確認のポーリング間隔（ミリ秒）。省略時 {@link DEFAULT_AUTOSTART_POLL_INTERVAL_MS}。 */
  pollIntervalMs?: number
  /** ポーリング間の待機実装の差し替え（テストで実時間待機を避けるため）。省略時は実 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>
  /**
   * 起動時の疎通確認 + hub 版取得の差し替え（テスト用 / FR-02）。省略時は `hub-lifecycle.ts` の
   * {@link probeHub}。`isReachable` とは別軸: こちらは初回の「疎通済みか・版はいくつか」の判定に、
   * `isReachable` は spawn 後の疎通待ちループにのみ使う。
   */
  probeVersion?: (port: number) => Promise<ProbeHubResult>
  /** hub の graceful 停止の差し替え（テスト用 / FR-02）。省略時は `hub-lifecycle.ts` の {@link hubStopImpl}（`hubStop`）。 */
  hubStop?: HubStopFn
  /** 自動更新フラグ（`config.yml` の `auto_update` / FR-05）。省略時 `true`。 */
  autoUpdate?: boolean
  /** 自版バージョン文字列の差し替え（テスト用）。省略時 {@link MONOMI_VERSION}。 */
  selfVersion?: string
}

/**
 * hub プロセスを detached + unref で spawn する（FR-01: 自己修復設計の起動そのもの）。
 *
 * 自パッケージ内 CLI 実体（{@link DEFAULT_CLI_ENTRY}、テストでは `options.cliEntry` で差し替え）を
 * `process.execPath` で `hub` サブコマンド付き起動する。外部パス・環境変数由来のコマンドは実行しない
 * （§非機能要件セキュリティ。実行コマンドは常に `process.execPath` + 自パッケージ内の固定相対パス）。
 * stdout/stderr は `paths.hubLogFile`（`~/.monomi/hub.log`）へ追記リダイレクトする。fd は spawn 呼び出し
 * （libuv 側の子プロセス生成)が完了した時点で子へ複製済みのため、spawn 直後に閉じてよい。
 *
 * クリーン環境（`~/.monomi` 自体が未作成）から呼ばれる可能性があるため、ログファイルを開く前に
 * {@link ensureMonomiHome} でディレクトリを用意する（AC-5 の受け入れ試験シナリオ）。
 *
 * @param paths `~/.monomi` パス集合。
 * @param options `spawn`/`cliEntry` の差し替え（省略可）。
 */
function spawnHub(paths: MonomiPaths, options: EnsureHubRunningOptions): void {
  ensureMonomiHome(paths)
  const spawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnFn)
  const cliEntry = options.cliEntry ?? DEFAULT_CLI_ENTRY
  const entryPath = typeof cliEntry === 'string' ? cliEntry : fileURLToPath(cliEntry)

  const fd = fs.openSync(paths.hubLogFile, 'a')
  try {
    const child = spawnFn(process.execPath, [entryPath, 'hub'], {
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * spawn 後の疎通待ちループ（fresh-start・restart 共通 / FR-01 AC-1、FR-02 AC-1）。
 *
 * @param port 確認対象ポート。
 * @param options `isReachable`/`timeoutMs`/`pollIntervalMs`/`sleep` の差し替え（省略可）。
 * @returns `timeoutMs`（既定 {@link DEFAULT_AUTOSTART_TIMEOUT_MS}）内に疎通できれば `true`。
 */
async function waitUntilReachable(
  port: number,
  options: EnsureHubRunningOptions
): Promise<boolean> {
  const isReachable = options.isReachable ?? isPortReachable
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTOSTART_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_AUTOSTART_POLL_INTERVAL_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let remaining = timeoutMs
  while (remaining > 0) {
    await sleep(pollIntervalMs)
    remaining -= pollIntervalMs
    if (await isReachable(port)) {
      return true
    }
  }
  return false
}

/**
 * hub の疎通を確認し、不在なら自己起動してから起動完了を待つ（FR-01）。加えて、既に疎通できる
 * 場合は hub の版を CLI 自版と照合し、必要なら graceful 停止 → 新版 spawn へ発展させる
 * （release-25-auto-update FR-02 の中核）。
 *
 * `monomi`（引数なし）実行時、ダッシュボード表示の前に呼ぶ（`cli.ts` の `case undefined`）。
 *
 * フロー:
 * 1. `role: child` なら何もしない（FR-01 AC-3。child は既存の `hub_endpoints` 接続をそのまま使う）。
 * 2. {@link probeHub}（`options.probeVersion`）で疎通と版ヘッダを同時に取得する。
 * 3. 不達なら {@link spawnHub} で detached spawn し、{@link waitUntilReachable} で起動完了を待つ
 *    （FR-01 AC-1。notice は返さない — 版照合の対象がまだ存在しないクリーンな初回起動のため）。
 * 4. 到達済みなら {@link compareVersion} で hub 版（応答ヘッダ）と自版（`options.selfVersion` /
 *    既定 {@link MONOMI_VERSION}）を比較する:
 *    - `same`（版一致）: 何もしない（FR-02 AC-4。stop/spawn いずれも呼ばない）
 *    - `newer`（hub の方が新しい）: hub には触れず「CLI が旧版」警告 notice のみ返す（FR-02 AC-3。
 *      新旧 CLI 交互実行によるフリップフロップを避けるため、hub のダウングレードはしない）
 *    - `older`/`unknown`（hub が旧版、または版ヘッダ欠落 = 版不明を旧版とみなす）: 5 へ
 * 5. `options.autoUpdate`（既定 `true`、通常は `config.yml` の `auto_update`）が `false` なら、
 *    停止・再起動はせず版ずれ notice のみ返す（FR-02 AC-6）
 * 6. `autoUpdate` が `true` なら `options.hubStop`（既定 `hub-lifecycle.ts` の `hubStop`。pid 生存確認 →
 *    SIGTERM → 終了確認ポーリングの graceful 停止）を呼ぶ:
 *    - 停止できた（`stopped: true`）: {@link spawnHub} で新版を spawn し {@link waitUntilReachable} で
 *      起動完了を待ち、「旧版 → 新版」の更新 notice を返す（FR-02 AC-1）
 *    - 停止できなかった（`timedOut` を含む `stopped: false`）: SIGKILL へはエスカレーションせず、
 *      「更新に失敗し旧版のまま継続する」警告 notice を返してそのまま起動を継続する（FR-02 AC-2）
 *
 * @param paths `~/.monomi` パス集合。
 * @param role この device の role（`loadConfig().role`）。
 * @param port hub の待受ポート（`loadConfig().port`）。
 * @param options 依存の差し替え（省略可、テスト用）。
 * @returns 起動 notice チャネル（release-25-auto-update）向けの i18n 解決済み文字列。notice が
 *   無ければ `null`。`role: child` は常に `null`。
 * @throws {Error} spawn 後の疎通確認が `timeoutMs` 内に成功しなかった場合（fresh-start・restart
 *   いずれも同じ扱い。`paths.hubLogFile` への参照を含む）。
 */
export async function ensureHubRunning(
  paths: MonomiPaths,
  role: MonomiRole,
  port: number,
  options: EnsureHubRunningOptions = {}
): Promise<string | null> {
  if (role === 'child') {
    return null
  }

  const probeVersion = options.probeVersion ?? probeHub
  const { reachable, version: hubVersion } = await probeVersion(port)

  if (!reachable) {
    spawnHub(paths, options)
    if (!(await waitUntilReachable(port, options))) {
      throw new Error(t('cli.hubAutostart.timeout', { hubLogFile: paths.hubLogFile }))
    }
    return null
  }

  const selfVersion = options.selfVersion ?? MONOMI_VERSION
  const comparison = compareVersion(hubVersion, selfVersion)

  if (comparison === 'same') {
    return null
  }

  const hubVersionLabel = hubVersion ?? t('cli.hubStatus.versionUnknown')

  if (comparison === 'newer') {
    return t('autoUpdate.cliOutdated', { hubVersion: hubVersionLabel, selfVersion })
  }

  // ここに到達するのは 'older' または 'unknown'（版不明 = 旧版）のみ（FR-02 の版比較ポリシー）。
  const autoUpdate = options.autoUpdate ?? true
  if (!autoUpdate) {
    return t('autoUpdate.hubMismatchSuppressed', { hubVersion: hubVersionLabel, selfVersion })
  }

  const stopHub = options.hubStop ?? hubStopImpl
  const stopResult = await stopHub(paths)
  if (!stopResult.stopped) {
    return t('autoUpdate.restartFailed', { hubVersion: hubVersionLabel })
  }

  spawnHub(paths, options)
  if (!(await waitUntilReachable(port, options))) {
    throw new Error(t('cli.hubAutostart.timeout', { hubLogFile: paths.hubLogFile }))
  }
  return t('autoUpdate.hubRestarted', { hubVersion: hubVersionLabel, selfVersion })
}
