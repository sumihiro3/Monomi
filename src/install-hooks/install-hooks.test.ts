import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHookCommand,
  buildHookDefinitions,
  isMonomiCommand,
  MONOMI_HOOK_MARKER,
} from './hook-definitions.js'
import {
  installHooks,
  mergeMonomiHooks,
  removeMonomiHooks,
  uninstallHooks,
  type ClaudeSettings,
} from './install-hooks.js'

/** install-hooks が網羅すべき 7 フックイベント（AC-1）。 */
const SEVEN_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const

/** 他ツール由来のフックと Monomi 無関係な設定を含む fixture（AC-2 検証用）。 */
function fixtureSettings(): ClaudeSettings {
  return {
    someOtherSetting: true,
    permissions: { allow: ['Bash'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool guard --pre' }] },
      ],
      Notification: [
        { matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'other-notify' }] },
      ],
      // Monomi が触らないイベント（別ツールの権限フック）。
      PermissionRequest: [{ hooks: [{ type: 'command', command: 'another-tool approve' }] }],
    },
  }
}

/** settings 内の全 command エントリのうち述語に一致するものを数える。 */
function countCommands(settings: ClaudeSettings, predicate: (command: string) => boolean): number {
  let count = 0
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        if (typeof entry.command === 'string' && predicate(entry.command)) count += 1
      }
    }
  }
  return count
}

const countMonomi = (settings: ClaudeSettings): number =>
  countCommands(settings, (c) => c.includes(MONOMI_HOOK_MARKER))

const countForeign = (settings: ClaudeSettings): number =>
  countCommands(settings, (c) => !c.includes(MONOMI_HOOK_MARKER))

/** Notification イベント配下の Monomi matcher 集合を取り出す。 */
function monomiNotificationMatchers(settings: ClaudeSettings): string[] {
  return (settings.hooks?.Notification ?? [])
    .filter((g) => g.hooks?.some((h) => isMonomiCommand(h.command)))
    .map((g) => g.matcher ?? '')
}

describe('buildHookDefinitions', () => {
  it('covers all 7 hook events with Notification split into two matchers (8 entries)', () => {
    const defs = buildHookDefinitions()
    expect(defs).toHaveLength(8)
    const events = new Set(defs.map((d) => d.event))
    for (const event of SEVEN_EVENTS) expect(events.has(event)).toBe(true)

    const notif = defs.filter((d) => d.event === 'Notification')
    expect(notif.map((d) => d.matcher).sort()).toEqual(['idle_prompt', 'permission_prompt'])
    // PreToolUse/PostToolUse は全ツールにマッチさせる。
    for (const d of defs.filter((d) => d.event === 'PreToolUse' || d.event === 'PostToolUse')) {
      expect(d.matcher).toBe('*')
    }
    // 全 command にマーカーが載っている。
    for (const d of defs) expect(isMonomiCommand(d.command)).toBe(true)
  })

  it('embeds the reporter script path and subtype in the command', () => {
    const defs = buildHookDefinitions('/custom/monomi-report.sh')
    const notifPerm = defs.find(
      (d) => d.event === 'Notification' && d.matcher === 'permission_prompt'
    )
    expect(notifPerm?.command).toBe(
      `bash /custom/monomi-report.sh --subtype permission_prompt ${MONOMI_HOOK_MARKER}`
    )
    const sessionStart = defs.find((d) => d.event === 'SessionStart')
    expect(sessionStart?.command).toBe(`bash /custom/monomi-report.sh ${MONOMI_HOOK_MARKER}`)
  })
})

describe('buildHookCommand', () => {
  it('appends the marker as a trailing bash comment', () => {
    expect(buildHookCommand('/x/report.sh')).toBe(`bash /x/report.sh ${MONOMI_HOOK_MARKER}`)
    expect(buildHookCommand('/x/report.sh', 'idle_prompt')).toBe(
      `bash /x/report.sh --subtype idle_prompt ${MONOMI_HOOK_MARKER}`
    )
    // マーカーは空白で区切られており、シェルではコメント（副作用なし）になる。
    expect(buildHookCommand('/x/report.sh')).toContain(` ${MONOMI_HOOK_MARKER}`)
  })
})

describe('mergeMonomiHooks (pure)', () => {
  it('adds 8 Monomi entries without touching foreign hooks', () => {
    const before = fixtureSettings()
    const { settings, added, removed } = mergeMonomiHooks(before)
    expect(added).toBe(8)
    expect(removed).toBe(0)
    expect(countMonomi(settings)).toBe(8)
    expect(countForeign(settings)).toBe(3)
    // 入力は変更しない（純関数）。
    expect(countMonomi(before)).toBe(0)
  })

  it('is idempotent: merging twice yields the same Monomi entry count', () => {
    const once = mergeMonomiHooks(fixtureSettings()).settings
    const twice = mergeMonomiHooks(once)
    expect(twice.removed).toBe(8)
    expect(twice.added).toBe(8)
    expect(countMonomi(twice.settings)).toBe(8)
    expect(countForeign(twice.settings)).toBe(3)
  })

  it('registers both Notification subtypes even when a foreign Notification hook exists', () => {
    const { settings } = mergeMonomiHooks(fixtureSettings())
    expect(monomiNotificationMatchers(settings).sort()).toEqual([
      'idle_prompt',
      'permission_prompt',
    ])
    // 他ツールの permission_prompt グループも残る。
    const foreign = settings.hooks?.Notification?.filter((g) =>
      g.hooks?.some((h) => h.command === 'other-notify')
    )
    expect(foreign).toHaveLength(1)
  })

  it('works from an empty settings object', () => {
    const { settings, added } = mergeMonomiHooks({})
    expect(added).toBe(8)
    expect(countMonomi(settings)).toBe(8)
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([...SEVEN_EVENTS].sort())
  })
})

describe('removeMonomiHooks (pure)', () => {
  it('removes only Monomi entries and drops emptied groups/events', () => {
    const installed = mergeMonomiHooks(fixtureSettings()).settings
    const { settings, removed } = removeMonomiHooks(installed)
    expect(removed).toBe(8)
    expect(countMonomi(settings)).toBe(0)
    expect(countForeign(settings)).toBe(3)
    // Monomi 専用に増えたイベント（SessionStart 等）はキーごと消える。
    expect(settings.hooks?.SessionStart).toBeUndefined()
    // 他ツールしか無いイベントは残る。
    expect(settings.hooks?.PermissionRequest).toHaveLength(1)
    // Monomi エントリだけ抜けた Notification には他ツールグループが 1 つ残る。
    expect(settings.hooks?.Notification).toHaveLength(1)
    // Monomi 無関係のトップレベル設定は保持。
    expect(settings.someOtherSetting).toBe(true)
    expect(settings.permissions).toEqual({ allow: ['Bash'] })
  })

  it('leaves settings without a hooks key untouched', () => {
    const { settings, removed } = removeMonomiHooks({ foo: 1 })
    expect(removed).toBe(0)
    expect(settings).toEqual({ foo: 1 })
  })
})

describe('installHooks / uninstallHooks (filesystem)', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function tmpSettingsPath(initial?: ClaudeSettings): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-hooks-'))
    tmpDirs.push(dir)
    const p = path.join(dir, '.claude', 'settings.json')
    if (initial) {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(initial, null, 2))
    }
    return p
  }

  function read(p: string): ClaudeSettings {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ClaudeSettings
  }

  it('AC-1: registers all 7 hook events with the Monomi marker', () => {
    const settingsPath = tmpSettingsPath(fixtureSettings())
    const result = installHooks({ settingsPath })
    expect(result.added).toBe(8)

    const after = read(settingsPath)
    for (const event of SEVEN_EVENTS) {
      const groups = after.hooks?.[event] ?? []
      const hasMonomi = groups.some((g) => g.hooks?.some((h) => isMonomiCommand(h.command)))
      expect(hasMonomi, `event ${event} should have a Monomi hook`).toBe(true)
    }
    expect(monomiNotificationMatchers(after).sort()).toEqual(['idle_prompt', 'permission_prompt'])
  })

  it('AC-2: preserves foreign hooks and unrelated settings', () => {
    const settingsPath = tmpSettingsPath(fixtureSettings())
    installHooks({ settingsPath })
    const after = read(settingsPath)

    expect(countForeign(after)).toBe(3)
    expect(
      after.hooks?.PreToolUse?.some((g) =>
        g.hooks?.some((h) => h.command === 'other-tool guard --pre')
      )
    ).toBe(true)
    expect(after.hooks?.PermissionRequest).toHaveLength(1)
    expect(after.someOtherSetting).toBe(true)
    expect(after.permissions).toEqual({ allow: ['Bash'] })
  })

  it('AC-3: running twice does not duplicate Monomi hooks', () => {
    const settingsPath = tmpSettingsPath(fixtureSettings())
    installHooks({ settingsPath })
    const first = read(settingsPath)
    const second = installHooks({ settingsPath })
    const after = read(settingsPath)

    expect(second.removed).toBe(8)
    expect(countMonomi(after)).toBe(8)
    expect(countForeign(after)).toBe(3)
    // 2 回目の結果は 1 回目と完全に一致する（安定）。
    expect(after).toEqual(first)
  })

  it('AC-4: uninstall removes only Monomi hooks, foreign hooks remain', () => {
    const settingsPath = tmpSettingsPath(fixtureSettings())
    installHooks({ settingsPath })
    const result = uninstallHooks({ settingsPath })
    const after = read(settingsPath)

    expect(result.removed).toBe(8)
    expect(countMonomi(after)).toBe(0)
    expect(countForeign(after)).toBe(3)
    expect(after.hooks?.PermissionRequest).toHaveLength(1)
    expect(after.someOtherSetting).toBe(true)
  })

  it('creates settings.json (and parent dir) when it does not exist', () => {
    const settingsPath = tmpSettingsPath()
    expect(fs.existsSync(settingsPath)).toBe(false)
    installHooks({ settingsPath })
    expect(fs.existsSync(settingsPath)).toBe(true)
    expect(countMonomi(read(settingsPath))).toBe(8)
  })

  it('honors a custom reporter script path in the written command', () => {
    const settingsPath = tmpSettingsPath()
    installHooks({ settingsPath, reporterScript: '/opt/monomi/report.sh' })
    const after = read(settingsPath)
    const cmd = after.hooks?.SessionStart?.[0]?.hooks?.[0]?.command
    expect(cmd).toBe(`bash /opt/monomi/report.sh ${MONOMI_HOOK_MARKER}`)
  })

  it('writes atomically and leaves no temp file behind', () => {
    const settingsPath = tmpSettingsPath(fixtureSettings())
    installHooks({ settingsPath })
    const leftovers = fs
      .readdirSync(path.dirname(settingsPath))
      .filter((name) => name.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('refuses to overwrite malformed JSON (protects the file)', () => {
    const settingsPath = tmpSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{ this is not json ')
    expect(() => installHooks({ settingsPath })).toThrow(/malformed JSON/)
    // 元ファイルは無傷。
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ this is not json ')
  })

  it('rejects a non-object top-level settings.json', () => {
    const settingsPath = tmpSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '[1, 2, 3]')
    expect(() => installHooks({ settingsPath })).toThrow(/expected a JSON object/)
  })

  it('treats an empty settings.json file as an empty object', () => {
    const settingsPath = tmpSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '')
    installHooks({ settingsPath })
    expect(countMonomi(read(settingsPath))).toBe(8)
  })
})
