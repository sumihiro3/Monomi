import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { render } from 'ink'
import { createElement } from 'react'
import { AppView } from './cli/components/app-view.js'
import { FocusService } from './cli/focus/focus-service.js'
import { GhosttyStrategy } from './cli/focus/ghostty-strategy.js'
import { TerminalAppStrategy } from './cli/focus/terminal-app-strategy.js'
import { TmuxFocusStrategy } from './cli/focus/tmux-strategy.js'
import { WslFocusStrategy } from './cli/focus/wsl-strategy.js'
import { createHubApiClient, createHubConnection } from './cli/hub-api-client.js'
import { ensureHubRunning as ensureHubRunningImpl } from './cli/hub-autostart.js'
import { MemoryWatchdog } from './cli/memory-watchdog.js'
import { type ChildPairOptions, runChildPair, runHubPair } from './cli/pairing-client.js'
import {
  loadConfig,
  loadLocale as loadLocaleFromConfig,
  type MonomiLocale,
  type MonomiRole,
} from './config/config.js'
import { ensureMonomiHome, resolvePaths } from './config/paths.js'
import { deriveDeviceId } from './domain/device-id.js'
import type { DeviceDto, DeviceRevokeResult } from './hub/dto.js'
import {
  hubStatus as hubStatusImpl,
  hubStop as hubStopImpl,
  type HubStatusResult,
  type HubStopResult,
} from './hub/hub-lifecycle.js'
import { main as runHubServer } from './hub/serve.js'
import { detectOsLocale } from './i18n/os-locale.js'
import { resolveLocale, setActiveLocale, t } from './i18n/index.js'
import { MONOMI_VERSION } from './index.js'
import {
  type InstallHooksOptions,
  type InstallHooksResult,
  installHooks as installHooksImpl,
  isMonomiHooksInstalled,
  uninstallHooks as uninstallHooksImpl,
} from './install-hooks/install-hooks.js'

/**
 * `monomi` bin の使い方（`--help`/引数不明時に表示）。
 *
 * `t()` はアクティブロケール解決後（{@link run} 冒頭の `setActiveLocale` 後）に評価する必要があるため、
 * モジュールスコープの `const` にせず関数にしている（`../i18n/index.js` の落とし穴を参照）。
 */
function usage(): string {
  return t('cli.usage')
}

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
  /**
   * hub の疎通を確認し、不在なら自己起動してから起動完了を待つ（`monomi`（引数なし）実行時、
   * ダッシュボード表示の前段。release-18-npx-quickstart FR-01）。`role: child` では何もせず、
   * 既に疎通できていれば spawn しない。spawn 後の疎通確認がタイムアウトした場合は例外を投げる
   * （`runGuarded` が終了コード 1 + メッセージ表示へ変換する）。
   */
  ensureHubRunning: () => Promise<void>
  /**
   * 稼働監視ログ（メモリ・stdoutバックプレッシャー計測）のウォッチドッグを起動する（`monomi`
   * （引数なし）実行時、`ensureHubRunning`/`maybePromptInstallHooks` の後・`runDashboard` の前段。
   * release-20-dashboard-heap-guard FR-01 AC-5）。Ink が書き込む `stdout` と同じストリームを
   * 監視対象にする必要があるため、既定実装（{@link defaultCliDeps}）は `process.stdout` を渡す。
   * 内部タイマーは `unref` 済みでプロセス終了を妨げず、`hub`/`--help` 等の他コマンド経路からは
   * 呼ばれない。
   */
  startMemoryWatchdog: () => void
  /**
   * CLI 表示ロケールを解決する（{@link run} 冒頭で `setActiveLocale` に渡す /
   * release-9-i18n FR-02 AC-4）。既定実装は `config.ts` の `loadLocale()`（`locale` フィールドのみを
   * 検証する軽量パス）を使う。`locale` と無関係なフィールドが不正な config.yml でも、--help/--version
   * のようなロケール解決だけで足りるコマンドが巻き込まれて落ちないようにするため
   * （review-changes 修正。{@link loadRole} のようなフルスキーマ検証とは意図的に非対称）。
   * `config.yml` の `locale` が未設定の場合は `detectOsLocale()`（release-19 FR-02）で OS 判定に
   * フォールバックする。macOS では `AppleLocale`（システムの実際の言語設定）を `LANG` より優先する
   * （`LANG` はシステム言語設定と連動する保証がなく、古い値のまま残っているケースが実機で確認された
   * ため）。
   */
  loadLocale: () => MonomiLocale
  /** `monomi hub devices list` の実体（localhost hub API をローカルトークンで叩く / FR-03 AC-1）。 */
  listDevices: () => Promise<DeviceDto[]>
  /** `monomi hub devices revoke <id>` の実体（FR-03 AC-2）。 */
  revokeDevice: (deviceId: string) => Promise<DeviceRevokeResult>
  /** `monomi hub pair` の実体（localhost hub でコード発行 → コード+候補 URL 表示 / FR-02b）。 */
  hubPair: () => Promise<void>
  /** `monomi pair --code ...` の実体（到達可能 hub で照合 → token+config 保存 / FR-02b）。 */
  childPair: (options: ChildPairOptions) => Promise<void>
  /** `monomi hub status` の実体（pid/port を突き合わせた3状態判定 / FR-02 AC-1）。 */
  hubStatus: () => Promise<HubStatusResult>
  /** `monomi hub stop` の実体（稼働中なら SIGTERM + pid ファイル削除 / FR-02 AC-2）。 */
  hubStop: () => Promise<HubStopResult>
  /** `monomi`（引数なし）の実体（Ink ダッシュボード、終了まで返らない）。 */
  runDashboard: () => Promise<void>
  /**
   * Monomi 起因のフックが `~/.claude/settings.json` へ既に登録済みかを判定する（初回セットアップ
   * 確認プロンプト / release-18-npx-quickstart FR-03 AC-3）。
   */
  isHooksInstalled: () => boolean
  /** 初回セットアップ確認プロンプトの拒否が既に永続化されているか（FR-03 AC-2）。 */
  isSetupPromptDeclined: () => boolean
  /** 初回セットアップ確認プロンプトの拒否を永続化する（FR-03 AC-2）。以後は再プロンプトしない。 */
  markSetupPromptDeclined: () => void
  /**
   * 現在の実行が対話端末（TTY）かどうか（FR-03 AC-4）。既定実装は
   * `process.stdin.isTTY && process.stdout.isTTY`。非対話（パイプ・CI 等）ではプロンプトを
   * 出さないための判定に使う。
   */
  isInteractive: () => boolean
  /**
   * `[Y/n]` 確認を行う（{@link isInteractive} が `true` の場合のみ呼ばれる）。空応答は既定 yes
   * として `true` を返す。
   */
  promptConfirm: (message: string) => Promise<boolean>
  /** 通常出力。 */
  log: (message: string) => void
  /** エラー出力。 */
  error: (message: string) => void
}

/**
 * このデバイス自身の device_id を解決する（`monomi hub`（bootstrap.ts）・`monomi pair`
 * （pairing-client.ts）と同一規則: config の明示値を優先し、未設定なら hostname から導出する）。
 * `f` フォーカス実行時の device_id 照合（AppView 側、FR-05 AC-2）に使う。
 */
function resolveLocalDeviceId(): string {
  return loadConfig().deviceId ?? deriveDeviceId(os.hostname())
}

/**
 * 実ターミナルへフォーカスを移す既定の {@link FocusService} を組み立てる（release-23-terminal-focus
 * FR-04d）。darwin 総当たり対象は Terminal.app・Ghostty、tmux/WSL2 はそれぞれ専用 strategy。
 * 各 strategy は `exec` 省略時に実 `execFile` ベースの既定実装を使う（テストでのみ差し替える）。
 */
function createDefaultFocusService(): FocusService {
  return new FocusService({
    darwinStrategies: [new TerminalAppStrategy(), new GhosttyStrategy()],
    tmuxStrategy: new TmuxFocusStrategy(),
    wslStrategy: new WslFocusStrategy(),
  })
}

/** hub へ接続して Ink ダッシュボードを描画し、終了まで待つ（FR-05 AC-1）。 */
async function runDashboard(): Promise<void> {
  // watch 中の取得失敗で到達先を選び直せるよう、client と再解決ファクトリを橋渡しする（#1）。
  const { client, reresolve } = await createHubConnection()
  const localDeviceId = resolveLocalDeviceId()
  const focusService = createDefaultFocusService()
  const { waitUntilExit } = render(
    createElement(AppView, {
      client,
      reresolve,
      localDeviceId,
      // FocusService#focus はインスタンスメソッド（内部で this.darwinStrategies 等を参照）のため、
      // AppView から素の関数として呼ばれても this を保てるよう bind する。
      focusRunner: focusService.focus.bind(focusService),
    })
  )
  await waitUntilExit()
}

/**
 * `[Y/n]` 確認を `node:readline/promises` で行う（FR-03。{@link CliDeps.promptConfirm} の既定実装）。
 *
 * 呼び出し側（{@link maybePromptInstallHooks}）が既に `deps.isInteractive()` で TTY 判定済みの
 * ときにのみ呼ぶ前提。空応答（Enter のみ）は既定 yes として `true` を返す。
 *
 * @param message 表示する質問文（例: `t('cli.setupPrompt.confirm')`）。
 * @returns 承諾 `true` / 拒否 `false`。
 */
async function promptConfirmDefault(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(message)).trim().toLowerCase()
    return answer === '' || answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

/** 実プロセスで使う既定の依存（bin 実行時に使う）。 */
export const defaultCliDeps: CliDeps = {
  installHooks: installHooksImpl,
  uninstallHooks: uninstallHooksImpl,
  runHub: () => runHubServer(),
  loadRole: () => loadConfig().role,
  ensureHubRunning: () => {
    const config = loadConfig()
    return ensureHubRunningImpl(resolvePaths(), config.role, config.port)
  },
  startMemoryWatchdog: () => {
    new MemoryWatchdog(resolvePaths(), { stdout: process.stdout }).start()
  },
  loadLocale: () => resolveLocale(loadLocaleFromConfig(), detectOsLocale()),
  listDevices: async () => (await createHubApiClient()).listDevices(),
  revokeDevice: async (deviceId: string) => (await createHubApiClient()).revokeDevice(deviceId),
  hubPair: () => runHubPair({ log: (message) => console.log(message) }),
  childPair: (options: ChildPairOptions) =>
    runChildPair(options, { log: (message) => console.log(message) }),
  hubStatus: () => hubStatusImpl(resolvePaths(), loadConfig().port),
  hubStop: () => hubStopImpl(resolvePaths()),
  runDashboard,
  isHooksInstalled: () => isMonomiHooksInstalled(),
  isSetupPromptDeclined: () => existsSync(resolvePaths().setupPromptStateFile),
  markSetupPromptDeclined: () => {
    const paths = resolvePaths()
    ensureMonomiHome(paths)
    writeFileSync(paths.setupPromptStateFile, '')
  },
  isInteractive: () => Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
  promptConfirm: promptConfirmDefault,
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
    return t('cli.hubDevices.listEmpty')
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
 * ダッシュボード表示前に、初回セットアップ（フック未登録）を検知して確認する
 * (release-18-npx-quickstart FR-03)。`deps.ensureHubRunning()` の後・`deps.runDashboard()` の前に
 * 呼ぶ（`run()` の `case undefined`）。
 *
 * 1. フック登録済みなら何もしない（AC-3）。
 * 2. 登録状態の判定自体が失敗した場合（`~/.claude/settings.json` が壊れた JSON 等）は、
 *    プロンプトを出さずダッシュボード表示を継続する（判定不能を「未登録」と誤認してプロンプト
 *    を出し、承諾時に `installHooks` がさらに壊れた JSON を書き込もうとする事態を避ける。
 *    `monomi install-hooks` を直接叩けば同じ壊れた JSON でエラーが表示される）。
 * 3. 過去に拒否が永続化されていれば再プロンプトせず案内1行のみ（AC-2）。
 * 4. 非対話（`deps.isInteractive()` が `false`）ならプロンプトを出さず案内1行のみで続行する
 *    （AC-4）。
 * 5. 対話端末なら確認し、承諾（`true`）で `deps.installHooks()` を実行（AC-1）、拒否（`false`）で
 *    `deps.markSetupPromptDeclined()` により永続化して案内1行を表示する（AC-2）。
 * 6. 承諾後の `deps.installHooks()` が失敗した場合（設定ファイルの書き込み権限不足等）も、
 *    上記の判定失敗・拒否の永続化失敗と同じ方針でダッシュボード表示をブロックせず、警告1行を
 *    表示して継続する。
 *
 * @param deps 差し替え可能な副作用。
 */
async function maybePromptInstallHooks(deps: CliDeps): Promise<void> {
  let hooksInstalled: boolean
  try {
    hooksInstalled = deps.isHooksInstalled()
  } catch {
    return
  }
  if (hooksInstalled) {
    return
  }

  if (deps.isSetupPromptDeclined()) {
    deps.log(t('cli.setupPrompt.notice'))
    return
  }

  if (!deps.isInteractive()) {
    deps.log(t('cli.setupPrompt.notice'))
    return
  }

  const accepted = await deps.promptConfirm(t('cli.setupPrompt.confirm'))
  if (!accepted) {
    // 永続化の失敗（書き込み権限等）はダッシュボード表示をブロックしない。次回また
    // プロンプトされるだけで済む（`isHooksInstalled` の判定失敗と同じ degrade-gracefully 方針）。
    try {
      deps.markSetupPromptDeclined()
    } catch {
      // 次回再プロンプトされる可能性を許容し、ここでは無視する。
    }
    deps.log(t('cli.setupPrompt.notice'))
    return
  }

  // 承諾後の書き込み失敗（パーミッション不足・ディスクフル等）も、判定失敗・拒否の永続化失敗と
  // 同じ degrade-gracefully 方針でダッシュボード表示をブロックしない。`monomi install-hooks` を
  // 直接叩けば同じ失敗が通常のエラー終了として報告される。
  let result: InstallHooksResult
  try {
    result = deps.installHooks()
  } catch (err) {
    deps.log(
      t('cli.setupPrompt.installFailure', {
        message: err instanceof Error ? err.message : String(err),
      })
    )
    return
  }
  deps.log(
    t('cli.installHooks.success', {
      added: result.added,
      settingsPath: result.settingsPath,
      removed: result.removed,
    })
  )
}

/**
 * `monomi` の引数を最小限のディスパッチで解決する（サブコマンドパーサ）。
 *
 * `install-hooks`/`uninstall-hooks`（FR-01）・`hub`（FR-03）・引数なし（FR-05 のダッシュボード）
 * へルーティングし、それぞれの実体呼び出しでスローされたエラーは終了コード 1 として握りつぶさず
 * メッセージ表示に変換する（bin から直接叩いたときにスタックトレースで壊れて見えないようにする）。
 * 引数なし経路（`case undefined`）では `runDashboard` の直前に `deps.startMemoryWatchdog()` を呼び、
 * 稼働監視ログ（メモリ・stdoutバックプレッシャー計測）を起動する（`hub` 等の他コマンド経路では
 * 呼ばない、release-20-dashboard-heap-guard FR-01 AC-5）。
 *
 * ロケール解決（`setActiveLocale`）もここで一度だけ行う（release-9-i18n FR-02 AC-4）。
 * `deps.loadLocale` が投げる例外（不正な `locale` 値の zod バリデーションエラー等）も、
 * 副作用呼び出しと同じく終了コード 1 + メッセージへ変換する（bin 直呼びでスタックトレースを
 * 露出させないという既存方針と整合させる）。
 *
 * @param argv `process.argv.slice(2)` 相当のサブコマンド引数。
 * @param deps 差し替え可能な副作用（省略時は {@link defaultCliDeps}）。
 * @returns プロセス終了コード。
 */
export async function run(argv: string[], deps: CliDeps = defaultCliDeps): Promise<number> {
  try {
    setActiveLocale(deps.loadLocale())
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err))
    return 1
  }

  const [command] = argv

  switch (command) {
    case undefined:
      return runGuarded(deps, async () => {
        await deps.ensureHubRunning()
        await maybePromptInstallHooks(deps)
        deps.startMemoryWatchdog()
        await deps.runDashboard()
      })

    case 'hub':
      return runGuarded(deps, () => handleHubCommand(argv.slice(1), deps))

    case 'pair':
      return runGuarded(deps, () => deps.childPair(parsePairArgs(argv.slice(1))))

    case 'install-hooks':
      return runGuarded(deps, async () => {
        const result = deps.installHooks()
        deps.log(
          t('cli.installHooks.success', {
            added: result.added,
            settingsPath: result.settingsPath,
            removed: result.removed,
          })
        )
      })

    case 'uninstall-hooks':
      return runGuarded(deps, async () => {
        const result = deps.uninstallHooks()
        deps.log(
          t('cli.uninstallHooks.success', {
            removed: result.removed,
            settingsPath: result.settingsPath,
          })
        )
      })

    case '--version':
    case '-v':
      deps.log(MONOMI_VERSION)
      return 0

    case '--help':
    case '-h':
      deps.log(usage())
      return 0

    default:
      deps.error(`${t('cli.unknownCommand', { command })}\n\n${usage()}`)
      return 1
  }
}

/**
 * `monomi hub ...` のサブディスパッチ。引数なしは hub サーバ起動（child ガード付き / FR-01 AC-2）、
 * `devices ...` はデバイス管理（FR-03）、`stop`/`status` はライフサイクル管理（FR-02）へ振り分ける。
 *
 * `devices`/`pair`/`stop`/`status` はいずれも localhost の hub をローカルトークンや pid ファイル越しに
 * 管理するだけのクライアント/管理コマンドであり、自身がサーバを起動しないため child ガードは掛けない
 * （hub 未起動なら各実体が明瞭なエラーで落ちる、または「停止済み/稼働中」を正しく報告する）。
 *
 * @param args `hub` の後続引数（`process.argv.slice(2).slice(1)` 相当）。
 * @param deps 差し替え可能な副作用。
 */
async function handleHubCommand(args: string[], deps: CliDeps): Promise<void> {
  const [sub] = args
  if (sub === undefined) {
    if (deps.loadRole() === 'child') {
      throw new Error(t('cli.hub.childRoleGuard'))
    }
    await runHubGuardingAddrInUse(deps)
    return
  }
  if (sub === 'pair') {
    await deps.hubPair()
    return
  }
  if (sub === 'status') {
    const result = await deps.hubStatus()
    deps.log(formatHubStatus(result))
    return
  }
  if (sub === 'stop') {
    const result = await deps.hubStop()
    deps.log(formatHubStop(result))
    return
  }
  if (sub === 'devices') {
    await handleDevicesCommand(args.slice(1), deps)
    return
  }
  throw new Error(`${t('cli.hub.unknownSubcommand', { sub })}\n\n${usage()}`)
}

/**
 * `deps.runHub()` を実行し、`EADDRINUSE`（port 使用中）で失敗した場合だけ「既に稼働中の可能性」を
 * 示す i18n メッセージへ変換する（FR-02。`monomi hub status` の案内を含める）。他の例外はそのまま
 * 上位（{@link runGuarded}）へ伝播させ、終了コード 1 + 元のメッセージ表示に委ねる。
 *
 * @param deps `runHub` を提供する差し替え可能な副作用。
 * @throws {Error} `deps.runHub()` が投げた例外（EADDRINUSE のみ文言を差し替える）。
 */
async function runHubGuardingAddrInUse(deps: CliDeps): Promise<void> {
  try {
    await deps.runHub()
  } catch (err) {
    if (err instanceof Error && err.message.includes('EADDRINUSE')) {
      throw new Error(t('cli.hub.addrInUse', { message: err.message }))
    }
    throw err
  }
}

/**
 * `monomi hub status` の表示整形（FR-02 AC-1）。
 *
 * @param result {@link HubStatusResult}。
 * @returns 表示用の1行文字列。
 */
function formatHubStatus(result: HubStatusResult): string {
  switch (result.state) {
    case 'running':
      return result.pid !== undefined
        ? t('cli.hubStatus.running', { pid: result.pid, port: result.port ?? '' })
        : t('cli.hubStatus.runningPidUnknown', { port: result.port ?? '' })
    case 'stale':
      return t('cli.hubStatus.stale', { pid: result.pid ?? '' })
    case 'stopped':
      return t('cli.hubStatus.stopped')
  }
}

/**
 * `monomi hub stop` の表示整形（FR-02 AC-2）。停止済みでもエラーにせず案内のみ表示する。
 *
 * `timedOut`（SIGTERM を送ったが `waitMs` 内に終了確認できず、pid ファイルも維持されたまま生存継続中）
 * を「既に停止済み」と混同しない。混同すると実際にはまだ稼働中の hub を「停止不要」と誤案内してしまう。
 *
 * @param result {@link HubStopResult}。
 * @returns 表示用の1行文字列。
 */
function formatHubStop(result: HubStopResult): string {
  if (result.stopped) {
    return t('cli.hubStop.stopped', { pid: result.pid ?? '' })
  }
  if (result.timedOut) {
    return t('cli.hubStop.timedOut', { pid: result.pid ?? '' })
  }
  return t('cli.hubStop.alreadyStopped')
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
        throw new Error(t('cli.pair.valueRequired', { flag }))
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
        throw new Error(`${t('cli.pair.unknownOption', { option: arg })}\n\n${usage()}`)
    }
  }
  if (code === undefined || code.length === 0) {
    throw new Error(t('cli.pair.codeRequired'))
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
        throw new Error(t('cli.hubDevices.deviceIdRequired'))
      }
      const result = await deps.revokeDevice(deviceId)
      deps.log(
        t('cli.hubDevices.revokeSuccess', { revoked: result.revoked, deviceId: result.device_id })
      )
      return
    }
    default:
      throw new Error(t('cli.hubDevices.unknownAction', { action: action ?? '' }))
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

/**
 * 直接起動判定用に `process.argv[1]` を実体パス（realpath）へ解決する。
 *
 * `npm install -g` / `npm link` は bin をシンボリックリンクとして配置するため、
 * `process.argv[1]` はシンボリックリンクのパスのままだが、`import.meta.url` は
 * Node がシンボリックリンクを解決した実体パスの URL になる。両者を素の文字列比較すると
 * シンボリックリンク経由の起動を「直接起動ではない」と誤判定し、以降の `run()` が
 * 発火しない（= npm 経由でグローバルインストールした `monomi` コマンドが無反応になる）。
 * `realpathSync` が失敗するケース（存在しないパス等）は起動判定に倒さず、素のパスへ
 * フォールバックする（例外で起動処理全体を止めないため）。
 */
export function resolveInvokedPath(argvPath: string | undefined): string | undefined {
  if (!argvPath) return undefined
  try {
    return realpathSync(argvPath)
  } catch {
    return argvPath
  }
}

// `node dist/cli.js` として直接起動されたときだけ実行する（`monomi` bin は release-17 以降
// `dist/bin.js` を指し、そこから Node バージョン検査後にこのモジュールを dynamic import して
// `run()` を明示的に呼ぶため、このガードは発火しない。`process.argv[1]` は `dist/bin.js` の
// パスであり、このファイル自身の `import.meta.url` とは一致しないため）。
// vitest からの import でも発火しない（hub/serve.ts と同じガード方式、§class-diagram §4）。
if (resolveInvokedPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
