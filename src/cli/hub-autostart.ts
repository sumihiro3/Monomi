import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MonomiRole } from '../config/config.js'
import { ensureMonomiHome, type MonomiPaths } from '../config/paths.js'
import { isPortReachable } from '../hub/hub-lifecycle.js'
import { t } from '../i18n/index.js'

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

/** {@link ensureHubRunning} の依存差し替え（テスト用 / FR-01 AC-1〜AC-4）。 */
export interface EnsureHubRunningOptions {
  /** port 疎通確認の差し替え。省略時は `hub-lifecycle.ts` の {@link isPortReachable}。 */
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
 * hub の疎通を確認し、不在なら自己起動してから起動完了を待つ（FR-01 の中核）。
 *
 * `monomi`（引数なし）実行時、ダッシュボード表示の前に呼ぶ（`cli.ts` の `case undefined`）。
 *
 * 1. `role: child` なら何もしない（AC-3。child は既存の `hub_endpoints` 接続をそのまま使う）。
 * 2. `port` へ既に疎通できれば何もしない（AC-2。既存の手動運用・pm2/launchd 常駐と共存する）。
 * 3. 疎通できなければ {@link spawnHub} で detached spawn し、リトライ付き疎通確認で起動完了を待つ
 *    （AC-1）。
 * 4. `options.timeoutMs`（既定 {@link DEFAULT_AUTOSTART_TIMEOUT_MS}）内に疎通できなければ、
 *    `paths.hubLogFile`（`~/.monomi/hub.log`）への参照を含むエラーを投げる（AC-4）。
 *
 * @param paths `~/.monomi` パス集合。
 * @param role この device の role（`loadConfig().role`）。
 * @param port hub の待受ポート（`loadConfig().port`）。
 * @param options 依存の差し替え（省略可、テスト用）。
 * @returns hub が（既存または spawn 後に）疎通可能になった時点で解決する。
 * @throws {Error} spawn 後の疎通確認が `timeoutMs` 内に成功しなかった場合。
 */
export async function ensureHubRunning(
  paths: MonomiPaths,
  role: MonomiRole,
  port: number,
  options: EnsureHubRunningOptions = {}
): Promise<void> {
  if (role === 'child') {
    return
  }

  const isReachable = options.isReachable ?? isPortReachable
  if (await isReachable(port)) {
    return
  }

  spawnHub(paths, options)

  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTOSTART_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_AUTOSTART_POLL_INTERVAL_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let remaining = timeoutMs
  while (remaining > 0) {
    await sleep(pollIntervalMs)
    remaining -= pollIntervalMs
    if (await isReachable(port)) {
      return
    }
  }

  throw new Error(t('cli.hubAutostart.timeout', { hubLogFile: paths.hubLogFile }))
}
