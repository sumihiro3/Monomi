import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeChildPairingConfig } from './config-writer.js'
import { loadConfig } from './config.js'
import { resolvePaths, type MonomiPaths } from './paths.js'

let tmpDir: string
let paths: MonomiPaths

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-cfgwriter-'))
  paths = resolvePaths(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('writeChildPairingConfig', () => {
  it('writes role, hub_endpoints (block sequence) and device_id, and reloads consistently', () => {
    writeChildPairingConfig(paths.configFile, {
      role: 'child',
      hubEndpoints: ['http://100.64.1.2:47632', 'http://192.168.1.100:47632'],
      deviceId: 'macbook',
    })

    const text = fs.readFileSync(paths.configFile, 'utf8')
    expect(text).toContain('role: child')
    expect(text).toContain('device_id: macbook')
    // ブロックシーケンス（`- item`）であってフロー記法 [a, b] ではないこと。
    expect(text).toContain('- http://100.64.1.2:47632')
    expect(text).not.toContain('[http')

    const config = loadConfig(paths)
    expect(config.role).toBe('child')
    expect(config.deviceId).toBe('macbook')
    expect(config.hubEndpoints).toEqual(['http://100.64.1.2:47632', 'http://192.168.1.100:47632'])
  })

  it('preserves hand-written comments and unrelated keys (partial write)', () => {
    fs.writeFileSync(
      paths.configFile,
      '# hand-written config\nport: 51000\nwatch_interval: 5s\n',
      'utf8'
    )

    writeChildPairingConfig(paths.configFile, {
      role: 'child',
      hubEndpoints: ['http://192.168.1.100:47632'],
      deviceId: 'macbook',
    })

    const text = fs.readFileSync(paths.configFile, 'utf8')
    expect(text).toContain('# hand-written config')
    expect(text).toContain('port: 51000')
    expect(text).toContain('watch_interval: 5s')

    const config = loadConfig(paths)
    expect(config.port).toBe(51000)
    expect(config.role).toBe('child')
    expect(config.deviceId).toBe('macbook')
  })

  it('chmods the config file to 600', () => {
    writeChildPairingConfig(paths.configFile, {
      role: 'child',
      hubEndpoints: ['http://192.168.1.100:47632'],
      deviceId: 'macbook',
    })
    const mode = fs.statSync(paths.configFile).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('overwrites an existing role and device_id on re-pair', () => {
    fs.writeFileSync(paths.configFile, 'role: hub\ndevice_id: old-id\n', 'utf8')
    writeChildPairingConfig(paths.configFile, {
      role: 'child',
      hubEndpoints: ['http://192.168.1.100:47632'],
      deviceId: 'new-id',
    })
    const config = loadConfig(paths)
    expect(config.role).toBe('child')
    expect(config.deviceId).toBe('new-id')
  })
})
