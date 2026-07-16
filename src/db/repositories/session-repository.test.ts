import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toEpochMs } from '../../domain/time.js'
import { openDatabase, type Database } from '../database.js'
import { DeviceRepository } from './device-repository.js'
import { InstanceRepository } from './instance-repository.js'
import { ProjectRepository } from './project-repository.js'
import { SessionRepository, type SessionTerminalInput } from './session-repository.js'

let tmpDir: string
let dbFile: string
let db: Database

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomi-db-'))
  dbFile = path.join(tmpDir, 'monomi.db')
  db = openDatabase(dbFile)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** FK 制約を満たすために先に device + project + instance を用意する共通セットアップ。 */
function seedInstance() {
  const devices = new DeviceRepository(db)
  const projects = new ProjectRepository(db)
  const instances = new InstanceRepository(db)
  const device = devices.upsert({
    id: 'macmini-1',
    name: 'Mac mini',
    role: 'HUB',
    firstSeenAt: toEpochMs(1000),
    lastSeenAt: toEpochMs(1000),
  })
  const project = projects.findOrCreateByKey({
    value: 'github.com/sumihiro/monomi',
    kind: 'GIT_REMOTE',
  })
  const instance = instances.upsert(project.id, device.id, '/Users/sumihiro/dev/monomi', 'main')
  return { instance }
}

const FULL_TERMINAL: SessionTerminalInput = {
  tty: '/dev/ttys003',
  termProgram: 'Apple_Terminal',
  tmuxPane: null,
  tmuxSocket: null,
  wslDistro: null,
  wtSession: null,
}

describe('SessionRepository.updateTerminal / toSession terminal mapping (release-23 FR-02b)', () => {
  it('session.terminal is null before any terminal snapshot has been recorded', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'sess1', toEpochMs(1000))

    const session = repo.findById('sess1')
    expect(session?.terminal).toBeNull()
  })

  it('updateTerminal writes all fields and toSession reads them back with seenAt', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'sess1', toEpochMs(1000))

    repo.updateTerminal('sess1', FULL_TERMINAL, toEpochMs(2000))

    const session = repo.findById('sess1')
    expect(session?.terminal).toEqual({
      tty: '/dev/ttys003',
      termProgram: 'Apple_Terminal',
      tmuxPane: null,
      tmuxSocket: null,
      wslDistro: null,
      wtSession: null,
      seenAt: toEpochMs(2000),
    })
  })

  it('updateTerminal preserves individual null fields as an explicit "not available" snapshot', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'sess1', toEpochMs(1000))

    const tmuxOnly: SessionTerminalInput = {
      tty: null,
      termProgram: 'tmux',
      tmuxPane: '%3',
      tmuxSocket: '/tmp/tmux-501/default',
      wslDistro: null,
      wtSession: null,
    }
    repo.updateTerminal('sess1', tmuxOnly, toEpochMs(3000))

    const session = repo.findById('sess1')
    expect(session?.terminal).toEqual({ ...tmuxOnly, seenAt: toEpochMs(3000) })
  })

  it('a later updateTerminal call overwrites the previous snapshot (latest-wins)', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'sess1', toEpochMs(1000))

    repo.updateTerminal('sess1', FULL_TERMINAL, toEpochMs(2000))
    const wsl: SessionTerminalInput = {
      tty: '/dev/pts/0',
      termProgram: null,
      tmuxPane: null,
      tmuxSocket: null,
      wslDistro: 'Ubuntu',
      wtSession: 'abc-123',
    }
    repo.updateTerminal('sess1', wsl, toEpochMs(4000))

    const session = repo.findById('sess1')
    expect(session?.terminal).toEqual({ ...wsl, seenAt: toEpochMs(4000) })
  })

  it('listByInstance also maps the terminal snapshot for each row', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    repo.updateTerminal('sess1', FULL_TERMINAL, toEpochMs(2000))
    repo.upsertStarted(instance.id, 'sess2', toEpochMs(1500))

    const sessions = repo.listByInstance(instance.id)
    const sess1 = sessions.find((s) => s.id === 'sess1')
    const sess2 = sessions.find((s) => s.id === 'sess2')
    expect(sess1?.terminal?.tty).toBe('/dev/ttys003')
    expect(sess2?.terminal).toBeNull()
  })
})
