import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type MonomiPaths, resolvePaths } from '../config/paths.js'
import { type HubHandle, serve } from './serve.js'

/**
 * `serve()` の hub.pid 書き込み/削除の往復テスト（FR-02。詳細な bootstrap/HTTP 往復の検証は
 * `http-server.test.ts` が既に担っているため、ここでは pid ファイルのライフサイクルのみに絞る）。
 */

let tmpDir: string
let paths: MonomiPaths
let hub: HubHandle | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-serve-lifecycle-'))
  paths = resolvePaths(tmpDir)
})

afterEach(async () => {
  if (hub !== undefined) {
    await hub.close()
    hub = undefined
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('serve() hub.pid lifecycle (FR-02)', () => {
  it('writes its own pid to hub.pid after a successful listen', async () => {
    hub = await serve({ paths, port: 0, hostname: 'macmini.local', logger: () => {} })
    expect(fs.existsSync(paths.hubPidFile)).toBe(true)
    expect(fs.readFileSync(paths.hubPidFile, 'utf8').trim()).toBe(String(process.pid))
  })

  it('removes hub.pid on close() (the SIGINT/SIGTERM graceful-shutdown path)', async () => {
    hub = await serve({ paths, port: 0, hostname: 'macmini.local', logger: () => {} })
    expect(fs.existsSync(paths.hubPidFile)).toBe(true)

    await hub.close()
    hub = undefined // already closed here; avoid a second close() in afterEach

    expect(fs.existsSync(paths.hubPidFile)).toBe(false)
  })

  it('overwrites a stale pre-existing hub.pid unconditionally (self-recovery, known-issue U10)', async () => {
    fs.mkdirSync(paths.home, { recursive: true })
    fs.writeFileSync(paths.hubPidFile, '999999')

    hub = await serve({ paths, port: 0, hostname: 'macmini.local', logger: () => {} })

    expect(fs.readFileSync(paths.hubPidFile, 'utf8').trim()).toBe(String(process.pid))
  })
})
