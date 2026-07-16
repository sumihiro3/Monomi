import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureMonomiHome, resolvePaths, type MonomiPaths } from '../config/paths.js'
import { t } from '../i18n/index.js'
import { compareVersion } from '../version-compare.js'
import { MONOMI_VERSION } from '../version.js'
import {
  buildHookDefinitions,
  defaultSettingsPath,
  DEFAULT_REPORTER_SCRIPT,
  extractReporterVersion,
  injectReporterVersion,
  isMonomiCommand,
  type MonomiHookDefinition,
} from './hook-definitions.js'

/**
 * npm パッケージ同梱の reporter スクリプト（配置元）の既定パス。
 *
 * `import.meta.url`（このファイル自身の URL）起点で解決するため、`src/install-hooks/install-hooks.ts`
 * （vitest 実行時）・`dist/install-hooks/install-hooks.js`（pack 後）のいずれのツリーでも
 * 「install-hooks から見て2階層上 → `reporter/monomi-report.sh`」という同一の相対位置を指す
 * （src・dist はどちらもリポジトリ/パッケージルート直下に配置されるため）。
 */
const DEFAULT_REPORTER_SOURCE = new URL('../../reporter/monomi-report.sh', import.meta.url)

/** 配置後の reporter スクリプトに付与するパーミッション（owner rwx・group/other rx）。 */
const REPORTER_SCRIPT_MODE = 0o755

/**
 * 同梱の reporter スクリプトを `paths.home` 配下の `monomi-report.sh`（絶対パス）へ配置する
 * （FR-02。版マーカー注入は release-25-auto-update FR-03）。
 *
 * `paths.home` を {@link ensureMonomiHome} で用意してから常に上書きし、実行権限
 * （{@link REPORTER_SCRIPT_MODE}）を付与する。既存ファイルの内容がどうであれ同梱版を正として
 * 上書きする（手動配置していた既存ユーザーの改変も含めて上書きされる仕様）。
 *
 * `fs.copyFileSync` ではなくテキストとして読み込み、{@link injectReporterVersion} で版マーカー行
 * （`MONOMI_REPORTER_VERSION="__MONOMI_VERSION__"`）の値を実際の {@link MONOMI_VERSION} へ書き換えて
 * から書き込む。これにより reporter/monomi-report.sh 側はビルド時にバージョンを埋め込む必要がなく
 * （プレースホルダのまま同梱でき）、配置（= 実行）時点の CLI 版が常に反映される。マーカー行が無い
 * `source`（テスト用の素のスクリプト等）は無変更のまま書き込まれる。
 *
 * ここで解決する絶対パスは、フック command 文字列に埋め込む reporterScript の既定値
 * （{@link defaultReporterScriptFor} が導出する）と常に一致させる必要がある。両者が乖離すると
 * reporter は配置されるのにフックが別パスを呼び出し、状態レポートがサイレントに失敗する
 * （known-issues 参照）。
 *
 * @param paths `~/.monomi` のパス集合（テスト時は隔離用の一時ディレクトリを渡す）。
 * @param source 配置元スクリプトのパス（既定 {@link DEFAULT_REPORTER_SOURCE}。テスト用に上書き可能）。
 * @throws {Error} ディレクトリ作成・読み込み・書き込み・chmod のいずれかが失敗した場合
 *   （原因を `cause` に保持）。
 */
function deployReporterScript(
  paths: MonomiPaths,
  source: string | URL = DEFAULT_REPORTER_SOURCE
): void {
  const dest = path.join(paths.home, 'monomi-report.sh')
  try {
    ensureMonomiHome(paths)
    const scriptText = fs.readFileSync(source, 'utf8')
    fs.writeFileSync(dest, injectReporterVersion(scriptText, MONOMI_VERSION))
    fs.chmodSync(dest, REPORTER_SCRIPT_MODE)
  } catch (cause) {
    throw new Error(`failed to deploy reporter script to ${dest}: ${(cause as Error).message}`, {
      cause,
    })
  }
}

/**
 * フック command 文字列に埋め込む reporter パスの既定値を `paths.home` から導出する。
 *
 * `paths.home` が既定値（`~/.monomi`、`resolvePaths()` を無指定で呼んだ場合と同じ）と一致する
 * ときは、シェル展開前提の {@link DEFAULT_REPORTER_SCRIPT}（`~/.monomi/monomi-report.sh`）を
 * そのまま使う。`MONOMI_HOME` 環境変数などで `paths.home` が既定と異なる場所に変更されている
 * 場合は、{@link deployReporterScript} の実際の配置先と一致させるため `paths.home` 起点の絶対
 * パスを使う。これにより reporter の配置先とフックが呼び出すパスが常に一致する。
 *
 * @param paths `~/.monomi` のパス集合。
 * @returns フック command に埋め込む reporter パス。
 */
function defaultReporterScriptFor(paths: MonomiPaths): string {
  const defaultHome = path.join(os.homedir(), '.monomi')
  return paths.home === defaultHome
    ? DEFAULT_REPORTER_SCRIPT
    : path.join(paths.home, 'monomi-report.sh')
}

/** settings.json 内の 1 command エントリ（`hooks[event][i].hooks[j]`）。 */
export interface HookCommandEntry {
  type: string
  command: string
  [key: string]: unknown
}

/** settings.json 内の 1 matcher グループ（`hooks[event][i]`）。 */
export interface HookMatcherGroup {
  matcher?: string
  hooks: HookCommandEntry[]
  [key: string]: unknown
}

/**
 * Claude Code の settings.json のうち Monomi が触る範囲の型。
 *
 * `hooks` 以外の任意キー（`permissions` など他ツール・ユーザー設定）は
 * インデックスシグネチャで保持し、読み書きで消さない。
 */
export interface ClaudeSettings {
  hooks?: Record<string, HookMatcherGroup[]>
  [key: string]: unknown
}

/** {@link installHooks} / {@link uninstallHooks} の共通オプション。 */
export interface InstallHooksOptions {
  /** settings.json のパス（既定 `~/.claude/settings.json`）。 */
  settingsPath?: string
  /**
   * フック command 文字列に埋め込む reporter パス（省略時は {@link defaultReporterScriptFor} が
   * `paths`（実際の reporter 配置先）から導出する。`paths` も省略時は `~/.monomi/monomi-report.sh`
   * のシェル展開前提の表記になる）。
   */
  reporterScript?: string
  /** `~/.monomi` のパス集合（既定 {@link resolvePaths}）。reporter 配置先の解決に使う。テスト用。 */
  paths?: MonomiPaths
  /** 同梱 reporter スクリプトの配置元パス（既定はパッケージ同梱パス）。テストでの隔離用。 */
  reporterSourcePath?: string | URL
}

/** install/uninstall の結果サマリ（bin がユーザーへ表示するのに使う）。 */
export interface InstallHooksResult {
  /** 書き込んだ settings.json のパス。 */
  settingsPath: string
  /** 除去した Monomi command エントリ数。 */
  removed: number
  /** 追加した Monomi command エントリ数（uninstall では 0）。 */
  added: number
}

/**
 * settings オブジェクトから Monomi 起因の command エントリを全て取り除いた新しいオブジェクトを返す。
 *
 * 入力は変更しない（純関数）。他ツール由来のエントリ・matcher・キー順・不明フィールドは保持する。
 * matcher グループの `hooks` が空になればグループごと除去し、イベントの配列が空になれば
 * そのイベントキーを削除する（AC-4）。
 *
 * @param settings 読み込んだ settings.json。
 * @returns `{ settings, removed }` — Monomi エントリを除いた新オブジェクトと除去件数。
 */
export function removeMonomiHooks(settings: ClaudeSettings): {
  settings: ClaudeSettings
  removed: number
} {
  const next: ClaudeSettings = { ...settings }
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { settings: next, removed: 0 }
  }

  let removed = 0
  const nextHooks: Record<string, HookMatcherGroup[]> = {}

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      // 想定外の形状は触らずそのまま残す。
      nextHooks[event] = groups
      continue
    }

    const keptGroups: HookMatcherGroup[] = []
    for (const group of groups) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : []
      const keptEntries = entries.filter((entry) => {
        const isMonomi = isMonomiCommand(entry?.command)
        if (isMonomi) removed += 1
        return !isMonomi
      })

      if (keptEntries.length === 0 && entries.length > 0) {
        // このグループは Monomi エントリだけだった → グループごと落とす。
        continue
      }
      keptGroups.push(keptEntries === entries ? group : { ...group, hooks: keptEntries })
    }

    if (keptGroups.length > 0) {
      nextHooks[event] = keptGroups
    }
  }

  if (Object.keys(nextHooks).length > 0) {
    next.hooks = nextHooks
  } else {
    delete next.hooks
  }
  return { settings: next, removed }
}

/**
 * settings オブジェクトへ Monomi フック定義を冪等にマージした新しいオブジェクトを返す。
 *
 * 冪等性は **remove-then-add** で担保する: まず既存の Monomi エントリを全除去し、
 * 続けて与えた定義を追記する。よって2回実行しても重複しない（AC-3）。他ツールの
 * フックには一切触れない（AC-2）。
 *
 * @param settings 読み込んだ settings.json。
 * @param definitions 追加するフック定義（既定は {@link buildHookDefinitions}）。
 * @returns `{ settings, removed, added }` — マージ後の新オブジェクトと増減件数。
 */
export function mergeMonomiHooks(
  settings: ClaudeSettings,
  definitions: MonomiHookDefinition[] = buildHookDefinitions()
): { settings: ClaudeSettings; removed: number; added: number } {
  const { settings: cleaned, removed } = removeMonomiHooks(settings)

  const hooks: Record<string, HookMatcherGroup[]> = { ...(cleaned.hooks ?? {}) }
  for (const def of definitions) {
    const group: HookMatcherGroup = {
      ...(def.matcher !== undefined ? { matcher: def.matcher } : {}),
      hooks: [{ type: 'command', command: def.command }],
    }
    hooks[def.event] = [...(hooks[def.event] ?? []), group]
  }

  return { settings: { ...cleaned, hooks }, removed, added: definitions.length }
}

/** settings.json を読む。ファイルが無ければ空オブジェクト。壊れている JSON は例外にする。 */
function readSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) {
    return {}
  }
  const text = fs.readFileSync(settingsPath, 'utf8')
  if (text.trim() === '') {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    // 破損した settings.json を上書きで潰さないため、ここで止める（読めなければ書かない）。
    throw new Error(
      `refusing to modify malformed JSON at ${settingsPath}: ${(cause as Error).message}`,
      { cause }
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`refusing to modify ${settingsPath}: expected a JSON object at the top level`)
  }
  return parsed as ClaudeSettings
}

/**
 * `settingsPath` に Monomi 起因のフックが1件以上登録されているかを判定する
 * (release-18-npx-quickstart FR-03 AC-3)。
 *
 * ダッシュボード起動時の初回セットアップ確認プロンプト（`cli.ts` の `maybePromptInstallHooks`）が
 * フック未登録を検知するために使う。{@link readSettings} と同じ規約: ファイル不在/空/`hooks`
 * キー無しは「未登録」（`false`）。settings.json が壊れた JSON の場合は {@link readSettings} が
 * 投げる例外がそのまま伝播する（呼び出し側で「判定できない＝プロンプトを出さない」扱いにする
 * かどうかを決める。壊れた設定を黙って「未登録」と誤判定し、承諾時に `installHooks` がさらに
 * 壊れた JSON を書き込もうとする事態を避けるため、ここでは例外を握り潰さない）。
 *
 * @param settingsPath settings.json のパス（既定 {@link defaultSettingsPath}）。
 * @returns Monomi マーカーを含む command エントリが1件以上あれば `true`。
 */
export function isMonomiHooksInstalled(settingsPath: string = defaultSettingsPath()): boolean {
  const settings = readSettings(settingsPath)
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return false
  }
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const entries = Array.isArray(group?.hooks) ? group.hooks : []
      if (entries.some((entry) => isMonomiCommand(entry?.command))) {
        return true
      }
    }
  }
  return false
}

/**
 * settings.json をアトミックに書き込む（同ディレクトリの一時ファイル→rename）。
 *
 * 途中クラッシュしても元ファイルは無傷（rename は同一ボリューム上でアトミック）。
 * 親ディレクトリが無ければ作成する。
 */
function writeSettingsAtomic(settingsPath: string, settings: ClaudeSettings): void {
  const dir = path.dirname(settingsPath)
  fs.mkdirSync(dir, { recursive: true })
  const serialized = `${JSON.stringify(settings, null, 2)}\n`
  const tmpPath = path.join(dir, `.${path.basename(settingsPath)}.monomi-${process.pid}.tmp`)
  fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(tmpPath, settingsPath)
  } catch (cause) {
    fs.rmSync(tmpPath, { force: true })
    throw cause
  }
}

/**
 * 同梱 reporter の配置 → Monomi の 7 フックを `~/.claude/settings.json` へ冪等に登録する
 * （FR-02 AC-1〜AC-3 / FR-01 AC-1〜AC-3）。
 *
 * 先に {@link deployReporterScript} で `paths.home` 配下（既定 `~/.monomi/monomi-report.sh`）に
 * 配置し（失敗時はここで例外が伝播し、フック登録には進まない = AC-3）、成功したら read→merge→
 * atomic write の順でフックを登録する。フック command に埋め込む reporter パスは
 * {@link defaultReporterScriptFor} で同じ `paths` から導出するため、`MONOMI_HOME` 等で配置先を
 * 変えても reporter の実配置先とフックの呼び出し先は常に一致する。他ツール由来のフック・設定は
 * 保持する。
 *
 * @param options settings.json / reporter 関連パスの上書き（省略可）。
 * @returns 追加・除去件数を含む結果。
 * @throws {Error} reporter の配置に失敗した場合（権限エラー等。原因は `cause` に保持）。
 */
export function installHooks(options: InstallHooksOptions = {}): InstallHooksResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath()
  const paths = options.paths ?? resolvePaths()
  const reporterScript = options.reporterScript ?? defaultReporterScriptFor(paths)

  deployReporterScript(paths, options.reporterSourcePath)

  const current = readSettings(settingsPath)
  const { settings, removed, added } = mergeMonomiHooks(
    current,
    buildHookDefinitions(reporterScript)
  )
  writeSettingsAtomic(settingsPath, settings)
  return { settingsPath, removed, added }
}

/**
 * Monomi 起因のフックのみ `~/.claude/settings.json` から除去する（FR-01 AC-4）。
 *
 * 他ツールのフック・設定は残す。
 *
 * @param options settings.json のパス上書き（省略可）。
 * @returns 除去件数を含む結果（`added` は常に 0）。
 */
export function uninstallHooks(
  options: Pick<InstallHooksOptions, 'settingsPath'> = {}
): InstallHooksResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath()
  const current = readSettings(settingsPath)
  const { settings, removed } = removeMonomiHooks(current)
  writeSettingsAtomic(settingsPath, settings)
  return { settingsPath, removed, added: 0 }
}

/** {@link ensureReporterUpToDate} の依存差し替え（テスト用 / release-25-auto-update FR-03）。 */
export interface EnsureReporterUpToDateOptions {
  /** Monomi フック登録有無の判定に使う settings.json のパス（既定 {@link defaultSettingsPath}）。 */
  settingsPath?: string
  /** 自動更新フラグ（`config.yml` の `auto_update` / FR-05）。省略時 `true`。 */
  autoUpdate?: boolean
  /** 自版バージョン文字列の差し替え（テスト用）。省略時 {@link MONOMI_VERSION}。 */
  selfVersion?: string
  /** 上書き配置時に使う同梱 reporter の配置元パス（テスト用。省略時は {@link deployReporterScript} の既定）。 */
  reporterSourcePath?: string | URL
}

/**
 * 設置済み reporter スクリプトの版マーカーを自版と照合し、古ければ自動的に再配置する
 * （release-25-auto-update FR-03 の中核）。`monomi`（引数なし）実行時、
 * `maybePromptInstallHooks`（`cli.ts`）の後に呼ぶ。
 *
 * フロー:
 * 1. {@link isMonomiHooksInstalled}（`options.settingsPath`）で Monomi フックが登録済みかを確認する。
 *    未登録なら reporter もまだ配置されていない前提で何もせず `null` を返す（AC-4）。判定自体が
 *    失敗した場合（settings.json が壊れている等）も同じく `null` を返す（判定不能を「未登録」に
 *    倒す degrade-gracefully 方針。`maybePromptInstallHooks` と同じ）。
 * 2. 設置済み `paths.home/monomi-report.sh` を読み込み、{@link extractReporterVersion} でマーカーの
 *    値を取り出す（ファイル自体が読めない場合もマーカー無し = 版不明として扱う）。
 * 3. {@link compareVersion} で自版（`options.selfVersion` / 既定 {@link MONOMI_VERSION}）と比較する:
 *    - `same`（版一致）: 何もしない。設置済みファイルの本文が手動編集されていても一切触らない
 *      （AC-3）。
 *    - `newer`（設置済みの方が新しい）: 上書きせず、reporter 固有の「CLI 旧版」notice
 *      （`autoUpdate.reporterNewerThanCli`）を返す（hub 版照合と機構は同じだが、対象が reporter
 *      であることが伝わるよう文言は専用のものを使う）。
 *    - `older`/`unknown`（設置済みが旧版、またはマーカー欠落 = 版不明を旧版とみなす）: 4 へ。
 * 4. `options.autoUpdate`（既定 `true`）が `false` なら、上書きはせず版ずれ notice のみ返す（AC-5）。
 * 5. `autoUpdate` が `true` なら {@link deployReporterScript} で同梱版を上書き配置し、更新 notice
 *    （`autoUpdate.reporterUpdated`）を返す（AC-1・AC-2・AC-6）。{@link deployReporterScript} は
 *    ディスク満杯・権限エラー等で例外を投げうる契約（JSDoc `@throws` 参照）だが、この関数はダッシュ
 *    ボード起動シーケンス中に呼ばれるため 1・2 と同じ degrade-gracefully 方針で吸収し、失敗 notice
 *    （`autoUpdate.reporterUpdateFailed`）を返す。呼び出し元（`cli.ts`）へ例外を伝播させず、
 *    reporter 再配置の失敗でダッシュボード起動全体を止めない。
 *
 * @param paths `~/.monomi` パス集合。
 * @param options 依存の差し替え（省略可、テスト用）。
 * @returns 起動 notice チャネル（release-25-auto-update）向けの i18n 解決済み文字列。notice が
 *   無ければ `null`。この関数自体は例外を投げない（上記フロー内の失敗はすべて notice へ変換する）。
 */
export function ensureReporterUpToDate(
  paths: MonomiPaths,
  options: EnsureReporterUpToDateOptions = {}
): string | null {
  const settingsPath = options.settingsPath ?? defaultSettingsPath()
  let hooksInstalled: boolean
  try {
    hooksInstalled = isMonomiHooksInstalled(settingsPath)
  } catch {
    return null
  }
  if (!hooksInstalled) {
    return null
  }

  const deployedPath = path.join(paths.home, 'monomi-report.sh')
  let deployedText = ''
  try {
    deployedText = fs.readFileSync(deployedPath, 'utf8')
  } catch {
    deployedText = ''
  }
  const markerVersion = extractReporterVersion(deployedText)

  const selfVersion = options.selfVersion ?? MONOMI_VERSION
  const comparison = compareVersion(markerVersion, selfVersion)

  if (comparison === 'same') {
    return null
  }

  const markerLabel = markerVersion ?? t('cli.hubStatus.versionUnknown')

  if (comparison === 'newer') {
    return t('autoUpdate.reporterNewerThanCli', { reporterVersion: markerLabel, selfVersion })
  }

  // ここに到達するのは 'older' または 'unknown'（版不明 = 旧版）のみ。
  const autoUpdate = options.autoUpdate ?? true
  if (!autoUpdate) {
    return t('autoUpdate.reporterMismatchSuppressed', { reporterVersion: markerLabel, selfVersion })
  }

  try {
    deployReporterScript(paths, options.reporterSourcePath)
  } catch (cause) {
    // deployReporterScript は失敗時に例外を投げる契約（JSDoc @throws 参照）だが、この関数は
    // `monomi`（引数なし）のダッシュボード起動シーケンス中に呼ばれるため、isMonomiHooksInstalled・
    // fs.readFileSync の失敗と同じ degrade-gracefully 方針で吸収する。再配置失敗はダッシュボード
    // 起動を止める理由にならない（AC-1〜AC-6 のいずれも「起動を継続しつつ notice で伝える」設計）。
    const message = cause instanceof Error ? cause.message : String(cause)
    return t('autoUpdate.reporterUpdateFailed', { reporterVersion: markerLabel, message })
  }
  return t('autoUpdate.reporterUpdated', { reporterVersion: markerLabel, selfVersion })
}
