import fs from 'node:fs'
import path from 'node:path'
import {
  buildHookDefinitions,
  defaultSettingsPath,
  DEFAULT_REPORTER_SCRIPT,
  isMonomiCommand,
  type MonomiHookDefinition,
} from './hook-definitions.js'

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
  /** reporter スクリプトのパス（既定 `~/.monomi/monomi-report.sh`）。 */
  reporterScript?: string
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
 * Monomi の 7 フックを `~/.claude/settings.json` へ冪等に登録する（FR-01 AC-1〜AC-3）。
 *
 * read→merge→atomic write の順で行い、他ツール由来のフック・設定は保持する。
 *
 * @param options settings.json / reporter スクリプトのパス上書き（省略可）。
 * @returns 追加・除去件数を含む結果。
 */
export function installHooks(options: InstallHooksOptions = {}): InstallHooksResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath()
  const reporterScript = options.reporterScript ?? DEFAULT_REPORTER_SCRIPT
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
