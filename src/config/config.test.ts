import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import {
  DEFAULT_PORT,
  loadConfig,
  loadConfigFromYaml,
  loadLocale,
  parseConfig,
  parseDurationMs,
} from './config.js'
import { MONOMI_HOME_ENV, resolvePaths } from './paths.js'

const H = 3_600_000
const S = 1_000

const DEFAULT_THRESHOLDS = {
  active: 2 * H,
  approvalWait: 6 * H,
  nextWait: 24 * H,
  prWait: 72 * H,
}

describe('resolvePaths', () => {
  afterEach(() => {
    delete process.env[MONOMI_HOME_ENV]
  })

  it('derives every path from an explicit home', () => {
    const p = resolvePaths('/custom/root')
    expect(p).toEqual({
      home: '/custom/root',
      configFile: '/custom/root/config.yml',
      dbFile: '/custom/root/monomi.db',
      outboxDir: '/custom/root/outbox',
      rejectedDir: '/custom/root/outbox/rejected',
      tokenFile: '/custom/root/token',
      hubPidFile: '/custom/root/hub.pid',
      hubLogFile: '/custom/root/hub.log',
      setupPromptStateFile: '/custom/root/setup-prompt-declined',
    })
  })

  it('honors the MONOMI_HOME env override', () => {
    process.env[MONOMI_HOME_ENV] = '/env/root'
    expect(resolvePaths().home).toBe('/env/root')
    expect(resolvePaths().configFile).toBe('/env/root/config.yml')
  })

  it('falls back to ~/.monomi when nothing is set', () => {
    delete process.env[MONOMI_HOME_ENV]
    expect(resolvePaths().home).toBe(path.join(os.homedir(), '.monomi'))
  })

  it('prefers the explicit argument over the env var', () => {
    process.env[MONOMI_HOME_ENV] = '/env/root'
    expect(resolvePaths('/arg/root').home).toBe('/arg/root')
  })
})

describe('parseDurationMs', () => {
  it('parses each supported unit', () => {
    expect(parseDurationMs('500ms')).toBe(500)
    expect(parseDurationMs('3s')).toBe(3_000)
    expect(parseDurationMs('30m')).toBe(1_800_000)
    expect(parseDurationMs('2h')).toBe(7_200_000)
    expect(parseDurationMs('1d')).toBe(86_400_000)
  })

  it('rejects malformed and unit-less input', () => {
    expect(() => parseDurationMs('2 h')).toThrow()
    expect(() => parseDurationMs('2hours')).toThrow()
    expect(() => parseDurationMs('1.5h')).toThrow()
    expect(() => parseDurationMs('3600000')).toThrow()
    expect(() => parseDurationMs('')).toThrow()
  })
})

describe('parseConfig defaults', () => {
  it('fills every field from an empty object', () => {
    const c = parseConfig({})
    expect(c.role).toBe('hub')
    expect(c.port).toBe(DEFAULT_PORT)
    expect(c.port).toBe(47632)
    expect(c.deviceId).toBeUndefined()
    expect(c.watchIntervalMs).toBe(3 * S)
    expect(c.escalationThresholds).toEqual(DEFAULT_THRESHOLDS)
  })

  it('treats null/undefined (empty config.yml) as all defaults', () => {
    expect(parseConfig(null).port).toBe(DEFAULT_PORT)
    expect(parseConfig(undefined).escalationThresholds).toEqual(DEFAULT_THRESHOLDS)
  })
})

describe('parseConfig overrides', () => {
  it('applies human-readable overrides and converts durations to ms', () => {
    const c = parseConfig({
      role: 'hub',
      port: 50000,
      device_id: 'macmini-1',
      watch_interval: '5s',
      escalation_thresholds: {
        active: '90m',
        approval_wait: '3h',
        next_wait: '12h',
        pr_wait: '48h',
      },
    })
    expect(c).toEqual({
      role: 'hub',
      port: 50000,
      deviceId: 'macmini-1',
      watchIntervalMs: 5_000,
      escalationThresholds: {
        active: 90 * 60_000,
        approvalWait: 3 * H,
        nextWait: 12 * H,
        prWait: 48 * H,
      },
    })
  })

  it('allows a partial escalation_thresholds override, keeping defaults for the rest', () => {
    const c = parseConfig({ escalation_thresholds: { active: '30m' } })
    expect(c.escalationThresholds).toEqual({
      ...DEFAULT_THRESHOLDS,
      active: 30 * 60_000,
    })
  })

  it('strips unknown keys for forward compatibility', () => {
    const c = parseConfig({ hub_url: 'http://x', future_field: 1 })
    expect(c.port).toBe(DEFAULT_PORT)
    expect(c).not.toHaveProperty('hub_url')
  })

  it('parses a role: child config with hub_endpoints and bind (FR-01 AC-1)', () => {
    const c = parseConfig({
      role: 'child',
      hub_endpoints: ['http://192.168.1.100:47632', 'http://100.64.0.1:47632'],
      bind: '127.0.0.1',
    })
    expect(c.role).toBe('child')
    expect(c.hubEndpoints).toEqual(['http://192.168.1.100:47632', 'http://100.64.0.1:47632'])
    expect(c.bind).toBe('127.0.0.1')
  })

  it('leaves hub_endpoints and bind undefined when omitted', () => {
    const c = parseConfig({})
    expect(c.hubEndpoints).toBeUndefined()
    expect(c.bind).toBeUndefined()
  })

  it('rejects a non-array hub_endpoints and non-string bind', () => {
    expect(() => parseConfig({ hub_endpoints: 'http://x' })).toThrow(ZodError)
    expect(() => parseConfig({ bind: 8080 })).toThrow(ZodError)
  })
})

describe('parseConfig validation', () => {
  it('accepts role: child (FR-01 AC-1)', () => {
    const c = parseConfig({ role: 'child' })
    expect(c.role).toBe('child')
  })

  it('rejects an unknown role', () => {
    expect(() => parseConfig({ role: 'satellite' })).toThrow(ZodError)
  })

  it('rejects an out-of-range port', () => {
    expect(() => parseConfig({ port: 70000 })).toThrow(ZodError)
    expect(() => parseConfig({ port: 0 })).toThrow(ZodError)
    expect(() => parseConfig({ port: 8080.5 })).toThrow(ZodError)
  })

  it('rejects a malformed duration', () => {
    expect(() => parseConfig({ watch_interval: 'soon' })).toThrow(ZodError)
    expect(() => parseConfig({ escalation_thresholds: { active: '2 hours' } })).toThrow(ZodError)
  })

  it('rejects an empty device_id', () => {
    expect(() => parseConfig({ device_id: '' })).toThrow(ZodError)
  })
})

describe('parseConfig locale (release-9-i18n FR-01)', () => {
  it('accepts locale: ja and locale: en (AC-1)', () => {
    expect(parseConfig({ locale: 'ja' }).locale).toBe('ja')
    expect(parseConfig({ locale: 'en' }).locale).toBe('en')
  })

  it('rejects an unsupported locale (AC-3)', () => {
    expect(() => parseConfig({ locale: 'fr' })).toThrow(ZodError)
  })

  it('leaves locale undefined when omitted (default resolution belongs to i18n, AC-2/AC-6)', () => {
    expect(parseConfig({}).locale).toBeUndefined()
  })
})

describe('loadConfigFromYaml', () => {
  it('parses the documented config.yml format', () => {
    const yamlText = [
      'role: hub',
      'port: 47632',
      'device_id: macmini-1',
      'watch_interval: 3s',
      'escalation_thresholds:',
      '  active: 2h',
      '  approval_wait: 6h',
      '  next_wait: 24h',
      '  pr_wait: 72h',
    ].join('\n')
    const c = loadConfigFromYaml(yamlText)
    expect(c.deviceId).toBe('macmini-1')
    expect(c.port).toBe(47632)
    expect(c.watchIntervalMs).toBe(3 * S)
    expect(c.escalationThresholds).toEqual(DEFAULT_THRESHOLDS)
  })

  it('treats an empty yaml document as all defaults', () => {
    expect(loadConfigFromYaml('').port).toBe(DEFAULT_PORT)
  })

  it('parses locale: ja from yaml (release-9-i18n FR-01 AC-1)', () => {
    expect(loadConfigFromYaml('locale: ja').locale).toBe('ja')
  })

  it('parses a child config.yml with a hub_endpoints block sequence (FR-01 AC-1)', () => {
    const yamlText = [
      'role: child',
      'bind: 0.0.0.0',
      'hub_endpoints:',
      '  - http://192.168.1.100:47632',
      '  - http://100.64.0.1:47632',
    ].join('\n')
    const c = loadConfigFromYaml(yamlText)
    expect(c.role).toBe('child')
    expect(c.bind).toBe('0.0.0.0')
    expect(c.hubEndpoints).toEqual(['http://192.168.1.100:47632', 'http://100.64.0.1:47632'])
  })
})

describe('loadConfig', () => {
  const tmpHomes: string[] = []

  afterEach(() => {
    for (const dir of tmpHomes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function tmpPaths() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-cfg-'))
    tmpHomes.push(dir)
    return resolvePaths(dir)
  }

  it('returns defaults when config.yml is absent', () => {
    const c = loadConfig(tmpPaths())
    expect(c.port).toBe(DEFAULT_PORT)
    expect(c.escalationThresholds).toEqual(DEFAULT_THRESHOLDS)
  })

  it('reads and validates an existing config.yml', () => {
    const paths = tmpPaths()
    fs.writeFileSync(paths.configFile, 'port: 51000\ndevice_id: mac-2\n')
    const c = loadConfig(paths)
    expect(c.port).toBe(51000)
    expect(c.deviceId).toBe('mac-2')
    expect(c.watchIntervalMs).toBe(3 * S)
  })

  it('rejects a config.yml with an invalid field (e.g. an out-of-range port)', () => {
    const paths = tmpPaths()
    fs.writeFileSync(paths.configFile, 'port: 99999\n')
    expect(() => loadConfig(paths)).toThrow(ZodError)
  })
})

describe('loadLocale（release-9-i18n review-changes 修正）', () => {
  const tmpHomes: string[] = []

  afterEach(() => {
    for (const dir of tmpHomes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function tmpPaths() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-cfg-'))
    tmpHomes.push(dir)
    return resolvePaths(dir)
  }

  it('returns undefined when config.yml is absent', () => {
    expect(loadLocale(tmpPaths())).toBeUndefined()
  })

  it('returns undefined when config.yml exists but locale is omitted', () => {
    const paths = tmpPaths()
    fs.writeFileSync(paths.configFile, 'port: 51000\n')
    expect(loadLocale(paths)).toBeUndefined()
  })

  it('resolves locale: ja even when the file has no other fields', () => {
    const paths = tmpPaths()
    fs.writeFileSync(paths.configFile, 'locale: ja\n')
    expect(loadLocale(paths)).toBe('ja')
  })

  it('resolves a valid locale even when an unrelated field is invalid (the review-changes regression)', () => {
    // port: abc は loadConfig() 全体では ZodError になるが、loadLocale() はそれに巻き込まれない
    // （--help/--version がロケール解決だけで足りるコマンドまで落ちないようにするための分離）。
    const paths = tmpPaths()
    fs.writeFileSync(paths.configFile, 'port: abc\nlocale: ja\n')
    expect(() => loadConfig(paths)).toThrow(ZodError)
    expect(loadLocale(paths)).toBe('ja')
  })

  it('still rejects an invalid locale value itself', () => {
    const paths = tmpPaths()
    fs.writeFileSync(paths.configFile, 'locale: fr\n')
    expect(() => loadLocale(paths)).toThrow(ZodError)
  })
})
