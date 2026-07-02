#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { render } from 'ink'
import { createElement } from 'react'
import { AppView } from './cli/components/app-view.js'
import { createHubApiClient, createHubConnection } from './cli/hub-api-client.js'
import { type ChildPairOptions, runChildPair, runHubPair } from './cli/pairing-client.js'
import { loadConfig, type MonomiRole } from './config/config.js'
import type { DeviceDto, DeviceRevokeResult } from './hub/dto.js'
import { main as runHubServer } from './hub/serve.js'
import { MONOMI_VERSION } from './index.js'
import {
  type InstallHooksOptions,
  type InstallHooksResult,
  installHooks as installHooksImpl,
  uninstallHooks as uninstallHooksImpl,
} from './install-hooks/install-hooks.js'

/**
 * `monomi` bin の使い方（`--help`/引数不明時に表示）。
 */
const USAGE = `Monomi — a status dashboard for Claude Code across machines

使い方:
  monomi                          稼働中 instance をダッシュボード表示（Ink）
  monomi hub                       hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
  monomi hub pair                  6桁ペアリングコードを発行し到達先候補 URL を表示（hub 側）
  monomi hub devices list          登録デバイス一覧を表示（トークン有効/失効つき）
  monomi hub devices revoke <id>   device のトークンを失効（以後その token は 401）
  monomi pair --code <code> [--hub <url> ...]  hub とペアリングし token+設定を保存（child 側。
                                    --hub は複数指定可、指定順が到達優先順）
  monomi install-hooks              Claude Code の7フックを ~/.claude/settings.json へ登録
  monomi uninstall-hooks            Monomi 起因のフックのみ除去
  monomi --version, -v              バージョンを表示
  monomi --help, -h                 このヘルプを表示`

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
  /** このデバイスの role を解決する（`monomi hub` の child ガード用 / FR-01 AC-2）。 */
  loadRole: () => MonomiRole
  /** `monomi hub devices list` の実体（localhost hub API をローカルトークンで叩く / FR-03 AC-1）。 */
  listDevices: () => Promise<DeviceDto[]>
  /** `monomi hub devices revoke <id>` の実体（FR-03 AC-2）。 */
  revokeDevice: (deviceId: string) => Promise<DeviceRevokeResult>
  /** `monomi hub pair` の実体（localhost hub でコード発行 → コード+候補 URL 表示 / FR-02b）。 */
  hubPair: () => Promise<void>
  /** `monomi pair --code ...` の実体（到達可能 hub で照合 → token+config 保存 / FR-02b）。 */
  childPair: (options: ChildPairOptions) => Promise<void>
  /** `monomi`（引数なし）の実体（Ink ダッシュボード、終了まで返らない）。 */
  runDashboard: () => Promise<void>
  /** 通常出力。 */
  log: (message: string) => void
  /** エラー出力。 */
  error: (message: string) => void
}

/** hub へ接続して Ink ダッシュボードを描画し、終了まで待つ（FR-05 AC-1）。 */
async function runDashboard(): Promise<void> {
  // watch 中の取得失敗で到達先を選び直せるよう、client と再解決ファクトリを橋渡しする（#1）。
  const { client, reresolve } = await createHubConnection()
  const { waitUntilExit } = render(createElement(AppView, { client, reresolve }))
  await waitUntilExit()
}

/** 実プロセスで使う既定の依存（bin 実行時に使う）。 */
export const defaultCliDeps: CliDeps = {
  installHooks: installHooksImpl,
  uninstallHooks: uninstallHooksImpl,
  runHub: () => runHubServer(),
  loadRole: () => loadConfig().role,
  listDevices: async () => (await createHubApiClient()).listDevices(),
  revokeDevice: async (deviceId: string) => (await createHubApiClient()).revokeDevice(deviceId),
  hubPair: () => runHubPair({ log: (message) => console.log(message) }),
  childPair: (options: ChildPairOptions) =>
    runChildPair(options, { log: (message) => console.log(message) }),
  runDashboard,
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
}

/**
 * `monomi hub devices list` 用の整形。トークンの有効/失効を含めて等幅で表示する。
 *
 * @param devices hub から取得した device 一覧。
 * @returns 端末表示用の複数行文字列（0 件なら案内メッセージ）。
 */
function formatDevicesTable(devices: DeviceDto[]): string {
  if (devices.length === 0) {
    return 'No devices registered yet. Start the hub (monomi hub) or pair a device first.'
  }
  const header = ['DEVICE_ID', 'NAME', 'ROLE', 'TOKEN', 'LAST_SEEN'] as const
  const rows = devices.map((d) => [
    d.id,
    d.name,
    d.role,
    d.has_active_token ? 'active' : 'revoked',
    d.last_seen_at,
  ])
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)))
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, col) => cell.padEnd(widths[col]))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
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
      return runGuarded(deps, () => handleHubCommand(argv.slice(1), deps))

    case 'pair':
      return runGuarded(deps, () => deps.childPair(parsePairArgs(argv.slice(1))))

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
 * `monomi hub ...` のサブディスパッチ。引数なしは hub サーバ起動（child ガード付き / FR-01 AC-2）、
 * `devices ...` はデバイス管理（FR-03）へ振り分ける。
 *
 * `devices` 系は localhost の hub API をローカルトークンで叩くクライアントであり、サーバを
 * 起動しないため child ガードは掛けない（hub 未起動なら API クライアントが明瞭なエラーで落ちる）。
 *
 * @param args `hub` の後続引数（`process.argv.slice(2).slice(1)` 相当）。
 * @param deps 差し替え可能な副作用。
 */
async function handleHubCommand(args: string[], deps: CliDeps): Promise<void> {
  const [sub] = args
  if (sub === undefined) {
    if (deps.loadRole() === 'child') {
      throw new Error(
        "monomi hub: this device is configured as role:child. Run 'monomi hub' only on the hub device, or set role:hub in ~/.monomi/config.yml."
      )
    }
    await deps.runHub()
    return
  }
  if (sub === 'pair') {
    await deps.hubPair()
    return
  }
  if (sub === 'devices') {
    await handleDevicesCommand(args.slice(1), deps)
    return
  }
  throw new Error(`monomi hub: unknown subcommand "${sub}"\n\n${USAGE}`)
}

/**
 * `monomi pair` の引数（`--code <code>` 必須 / `--hub <url>` 任意・複数指定可）を解析する（FR-02b / #4）。
 *
 * `--flag value` と `--flag=value` の双方を受ける。`--hub` は指定された順に積み上げ、
 * {@link resolveEndpoints}（pairing-client.ts）側で先頭ほど優先度が高い到達先として扱われる。
 * `--code` 欠落・未知オプション・値欠落はエラーにして {@link runGuarded} で終了コード 1 へ変換させる。
 *
 * @param args `pair` の後続引数。
 * @returns 解析済みの {@link ChildPairOptions}（`hub` は未指定なら空配列）。
 * @throws {Error} `--code` 欠落・値欠落・未知オプションのいずれか。
 */
function parsePairArgs(args: string[]): ChildPairOptions {
  let code: string | undefined
  const hub: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const eq = arg.indexOf('=')
    const flag = eq >= 0 ? arg.slice(0, eq) : arg
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined
    const takeValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue
      }
      const next = args[i + 1]
      if (next === undefined) {
        throw new Error(`monomi pair: ${flag} requires a value`)
      }
      i += 1
      return next
    }
    switch (flag) {
      case '--code':
        code = takeValue()
        break
      case '--hub':
        hub.push(takeValue())
        break
      default:
        throw new Error(`monomi pair: unknown option "${arg}"\n\n${USAGE}`)
    }
  }
  if (code === undefined || code.length === 0) {
    throw new Error(
      'monomi pair: --code <code> is required. Get a code with `monomi hub pair` on the hub device.'
    )
  }
  return { code, hub }
}

/**
 * `monomi hub devices <action>` のディスパッチ（FR-03）。
 *
 * - `list`: 登録デバイスをトークン有効/失効つきで表示（AC-1）。
 * - `revoke <device_id>`: 当該 device のトークンを一括失効（AC-2）。id 省略はエラー。
 *
 * @param args `devices` の後続引数（`<action> [device_id]`）。
 * @param deps 差し替え可能な副作用。
 */
async function handleDevicesCommand(args: string[], deps: CliDeps): Promise<void> {
  const [action, deviceId] = args
  switch (action) {
    case 'list': {
      const devices = await deps.listDevices()
      deps.log(formatDevicesTable(devices))
      return
    }
    case 'revoke': {
      if (deviceId === undefined) {
        throw new Error('monomi hub devices revoke: a <device_id> argument is required.')
      }
      const result = await deps.revokeDevice(deviceId)
      deps.log(
        `Revoked ${result.revoked} token(s) for device "${result.device_id}". ` +
          'That device must pair again to reconnect.'
      )
      return
    }
    default:
      throw new Error(
        `monomi hub devices: unknown action "${action ?? ''}". Use "list" or "revoke <device_id>".`
      )
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
