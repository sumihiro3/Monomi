import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureMonomiHome, resolvePaths, type MonomiPaths } from './paths.js'

let tmpDir: string
let paths: MonomiPaths

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-paths-'))
  // resolvePaths(home) の home はディレクトリそのものを指すため、その直下に未存在の
  // 子ディレクトリを `paths.home` として使う（tmpDir 自体は mkdtempSync 済みで既存になるため）。
  paths = resolvePaths(path.join(tmpDir, '.monomi'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ensureMonomiHome', () => {
  it('creates a non-existent home directory with mode 700', () => {
    expect(fs.existsSync(paths.home)).toBe(false)

    ensureMonomiHome(paths)

    expect(fs.existsSync(paths.home)).toBe(true)
    const mode = fs.statSync(paths.home).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('tightens an existing directory with looser permissions back to 700', () => {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o755 })
    fs.chmodSync(paths.home, 0o755)
    expect(fs.statSync(paths.home).mode & 0o777).toBe(0o755)

    ensureMonomiHome(paths)

    const mode = fs.statSync(paths.home).mode & 0o777
    expect(mode).toBe(0o700)
  })
})
