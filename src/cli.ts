#!/usr/bin/env node
import { createElement } from 'react'
import { render } from 'ink'
import { fileURLToPath } from 'node:url'
import { AppView } from './cli/components/app-view.js'
import { createHubApiClient } from './cli/hub-api-client.js'
import {
  installHooks as installHooksImpl,
  uninstallHooks as uninstallHooksImpl,
  type InstallHooksOptions,
  type InstallHooksResult,
} from './install-hooks/install-hooks.js'
import { main as runHubServer } from './hub/serve.js'
import { MONOMI_VERSION } from './index.js'

/**
 * `monomi` bin の使い方（`--help`/引数不明時に表示）。
 */
const USAGE = `Monomi — a status dashboard for Claude Code across machines

使い方:
  monomi                  稼働中 instance をダッシュボード表示（Ink）
  monomi hub               hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
  monomi install-hooks      Claude Code の7フックを ~/.claude/settings.json へ登録
  monomi uninstall-hooks    Monomi 起因のフックのみ除去
  monomi --version, -v      バージョンを表示
  monomi --help, -h         このヘルプを表示`

/**
 * {@link run} が呼び出す副作用の集合。テストで実 HTTP/実 fs/実 Ink 起動を避けるために
 * 差し替え可能にする（他レイヤーの `ServeOptions` 等と同じ DI パターン）。
 */
export interface CliDeps {
  /** `monomi install-hooks` の実体。 */
  installHooks: (options?: InstallHooksOptions) => InstallHooksResult
  /** `monomi uninstall-hooks` の実体。 */
  uninstallHooks: (options?: Pick<InstallHooksOptions, 'settingsPath'>) => InstallHooksResult
  /** `monomi hub` の実体（起動して SIGINT/SIGTERM まで返らない）。 */
  runHub: () => Promise<void>
  /** `monomi`（引数なし）の実体（Ink ダッシュボード、終了まで返らない）。 */
  runDashboard: () => Promise<void>
  /** 通常出力。 */
  log: (message: string) => void
  /** エラー出力。 */
  error: (message: string) => void
}

/** hub へ接続して Ink ダッシュボードを描画し、終了まで待つ（FR-05 AC-1）。 */
async function runDashboard(): Promise<void> {
  const client = createHubApiClient()
  const { waitUntilExit } = render(createElement(AppView, { client }))
  await waitUntilExit()
}

/** 実プロセスで使う既定の依存（bin 実行時に使う）。 */
export const defaultCliDeps: CliDeps = {
  installHooks: installHooksImpl,
  uninstallHooks: uninstallHooksImpl,
  runHub: () => runHubServer(),
  runDashboard,
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
}

/**
 * `monomi` の引数を最小限のディスパッチで解決する（サブコマンドパーサ）。
 *
 * `install-hooks`/`uninstall-hooks`（FR-01）・`hub`（FR-03）・引数なし（FR-05 のダッシュボード）
 * へルーティングし、それぞれの実体呼び出しでスローされたエラーは終了コード 1 として握りつぶさず
 * メッセージ表示に変換する（bin から直接叩いたときにスタックトレースで壊れて見えないようにする）。
 *
 * @param argv `process.argv.slice(2)` 相当のサブコマンド引数。
 * @param deps 差し替え可能な副作用（省略時は {@link defaultCliDeps}）。
 * @returns プロセス終了コード。
 */
export async function run(argv: string[], deps: CliDeps = defaultCliDeps): Promise<number> {
  const [command] = argv

  switch (command) {
    case undefined:
      return runGuarded(deps, () => deps.runDashboard())

    case 'hub':
      return runGuarded(deps, () => deps.runHub())

    case 'install-hooks':
      return runGuarded(deps, async () => {
        const result = deps.installHooks()
        deps.log(
          `Monomi hooks installed: ${result.added} entr${result.added === 1 ? 'y' : 'ies'} in ${result.settingsPath} (${result.removed} stale entr${result.removed === 1 ? 'y' : 'ies'} replaced)`
        )
      })

    case 'uninstall-hooks':
      return runGuarded(deps, async () => {
        const result = deps.uninstallHooks()
        deps.log(`Monomi hooks removed: ${result.removed} entry(ies) from ${result.settingsPath}`)
      })

    case '--version':
    case '-v':
      deps.log(MONOMI_VERSION)
      return 0

    case '--help':
    case '-h':
      deps.log(USAGE)
      return 0

    default:
      deps.error(`monomi: unknown command "${command}"\n\n${USAGE}`)
      return 1
  }
}

/**
 * 副作用呼び出しを try/catch で包み、例外を終了コード 1 + エラーメッセージへ変換する共通処理。
 *
 * @param deps エラー出力に使う {@link CliDeps}。
 * @param action 実行する副作用。
 * @returns 成功時 0、例外時 1。
 */
async function runGuarded(deps: CliDeps, action: () => Promise<void>): Promise<number> {
  try {
    await action()
    return 0
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}

// `node dist/cli.js`（= `monomi` bin）として直接起動されたときだけ実行する。
// vitest からの import では発火しない（hub/serve.ts と同じガード方式、§class-diagram §4）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
