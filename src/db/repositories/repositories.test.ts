import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Device } from '../../domain/entities.js'
import { ProjectKeyNormalizer } from '../../domain/project-key-normalizer.js'
import { projectKeyEquals } from '../../domain/project-key.js'
import { toEpochMs } from '../../domain/time.js'
import { openDatabase, type Database } from '../database.js'
import { DeviceRepository } from './device-repository.js'
import { EventRepository, type NewEvent } from './event-repository.js'
import { InstanceRepository } from './instance-repository.js'
import { PrStatusRepository } from './pr-status-repository.js'
import { ProjectRepository } from './project-repository.js'
import { SessionRepository } from './session-repository.js'
import { TokenRepository } from './token-repository.js'

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
  return { device, project, instance, devices, projects, instances }
}

describe('openDatabase (FR-03 AC-6)', () => {
  it('sets WAL journal mode, NORMAL synchronous and enables foreign keys on a file DB', () => {
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    const sync = db.prepare('PRAGMA synchronous').get() as { synchronous: number }
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }

    expect(journal.journal_mode).toBe('wal')
    expect(sync.synchronous).toBe(1) // NORMAL
    expect(fk.foreign_keys).toBe(1)
  })

  it('creates every §7.3 table (+ tokens, + events.received_at)', () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    for (const t of [
      'devices',
      'projects',
      'instances',
      'sessions',
      'events',
      'pr_status',
      'tokens',
    ]) {
      expect(tables).toContain(t)
    }
    const eventCols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(eventCols).toContain('received_at')
  })

  it('is idempotent: re-opening the same file keeps a single set of tables', () => {
    db.close()
    db = openDatabase(dbFile) // reopen; DDL uses IF NOT EXISTS
    const count = db
      .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='projects'")
      .get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('enforces foreign keys (session referencing a missing instance is rejected)', () => {
    const sessions = new SessionRepository(db)
    expect(() => sessions.upsertStarted('ghost-instance', 'sess-x', toEpochMs(1))).toThrow()
  })
})

describe('DeviceRepository', () => {
  it('upserts idempotently, preserving first_seen_at and lowercasing role in storage', () => {
    const repo = new DeviceRepository(db)
    const base: Device = {
      id: 'macmini-1',
      name: 'Mac mini',
      role: 'HUB',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    }
    repo.upsert(base)
    const updated = repo.upsert({
      ...base,
      name: 'Mac mini renamed',
      firstSeenAt: toEpochMs(9999), // must be ignored on conflict
      lastSeenAt: toEpochMs(2000),
    })

    expect(repo.list()).toHaveLength(1)
    expect(updated.firstSeenAt).toBe(1000) // preserved
    expect(updated.lastSeenAt).toBe(2000) // updated
    expect(updated.name).toBe('Mac mini renamed')
    expect(updated.role).toBe('HUB') // read back uppercased

    const rawRole = db.prepare('SELECT role FROM devices WHERE id = ?').get('macmini-1') as {
      role: string
    }
    expect(rawRole.role).toBe('hub') // stored lowercased for the CHECK constraint
  })

  it('findById returns null for unknown id', () => {
    expect(new DeviceRepository(db).findById('nope')).toBeNull()
  })
})

describe('ProjectRepository.findOrCreateByKey (FR-03 AC-2)', () => {
  it('collapses SSH and HTTPS forms of the same repo into one row', () => {
    const normalizer = new ProjectKeyNormalizer()
    const ctx = {
      deviceId: 'macmini-1',
      cwd: '/Users/sumihiro/dev/monomi',
      isGitRepo: true,
    }
    const sshKey = normalizer.normalize('git@github.com:sumihiro/monomi.git', ctx)
    const httpsKey = normalizer.normalize('https://github.com/sumihiro/monomi.git', ctx)
    expect(projectKeyEquals(sshKey, httpsKey)).toBe(true)

    const repo = new ProjectRepository(db)
    const first = repo.findOrCreateByKey(sshKey)
    const second = repo.findOrCreateByKey(httpsKey)

    expect(second.id).toBe(first.id)
    const count = db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('keeps a single row across 10 textual variants that normalize identically', () => {
    const normalizer = new ProjectKeyNormalizer()
    const ctx = { deviceId: 'd1', cwd: '/x', isGitRepo: true }
    const variants = [
      'git@github.com:sumihiro/monomi.git',
      'git@github.com:sumihiro/monomi',
      'https://github.com/sumihiro/monomi.git',
      'https://github.com/sumihiro/monomi',
      'https://github.com/sumihiro/monomi/',
      'ssh://git@github.com/sumihiro/monomi.git',
      'https://user:token@github.com/sumihiro/monomi.git',
      'https://GitHub.com/sumihiro/monomi.git',
      'ssh://git@github.com:22/sumihiro/monomi.git',
      'git://github.com/sumihiro/monomi.git',
    ]
    const repo = new ProjectRepository(db)
    const ids = variants.map((v) => repo.findOrCreateByKey(normalizer.normalize(v, ctx)).id)

    expect(new Set(ids).size).toBe(1)
    const count = db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('reconstructs kind from the stored value prefix on read', () => {
    const repo = new ProjectRepository(db)
    const remote = repo.findOrCreateByKey({ value: 'github.com/a/b', kind: 'GIT_REMOTE' })
    const local = repo.findOrCreateByKey({ value: 'local:d1:/repo', kind: 'LOCAL_NO_REMOTE' })
    const nogit = repo.findOrCreateByKey({ value: 'nogit:d1:/tmp/x', kind: 'NO_GIT' })

    expect(repo.findById(remote.id)?.projectKey.kind).toBe('GIT_REMOTE')
    expect(repo.findById(local.id)?.projectKey.kind).toBe('LOCAL_NO_REMOTE')
    expect(repo.findById(nogit.id)?.projectKey.kind).toBe('NO_GIT')
  })
})

describe('InstanceRepository (UNIQUE(device_id, path))', () => {
  it('upserts idempotently on the same device+path and updates branch', () => {
    const { project, device, instances } = seedInstance()
    const again = instances.upsert(project.id, device.id, '/Users/sumihiro/dev/monomi', 'feature')

    expect(instances.listActive()).toHaveLength(1)
    expect(again.branch).toBe('feature')
    const count = db.prepare('SELECT COUNT(*) c FROM instances').get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('re-activates a removed instance on the next upsert (removed_at reset to null)', () => {
    const { project, device, instance, instances } = seedInstance()
    instances.markRemoved(instance.id)
    expect(instances.listActive()).toHaveLength(0)

    const reactivated = instances.upsert(project.id, device.id, instance.path, 'main')
    expect(reactivated.id).toBe(instance.id)
    expect(reactivated.removedAt).toBeNull()
    expect(instances.listActive()).toHaveLength(1)
  })
})

describe('SessionRepository', () => {
  it('upsertStarted is idempotent (keeps the original started_at)', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    const again = repo.upsertStarted(instance.id, 'sess1', toEpochMs(5000))

    expect(again.startedAt).toBe(1000)
    expect(again.agentType).toBe('claude_code')
    const count = db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('markEnded records ended_at and reason', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    repo.markEnded('sess1', 'clear', toEpochMs(2000))

    const s = repo.findById('sess1')
    expect(s?.endedAt).toBe(2000)
    expect(s?.endReason).toBe('clear')
  })

  it('listByInstance enumerates sessions newest-first', () => {
    const { instance } = seedInstance()
    const repo = new SessionRepository(db)
    repo.upsertStarted(instance.id, 'old', toEpochMs(1000))
    repo.upsertStarted(instance.id, 'new', toEpochMs(3000))

    const ids = repo.listByInstance(instance.id).map((s) => s.id)
    expect(ids).toEqual(['new', 'old'])
  })
})

describe('EventRepository (received_at authority, §0.5)', () => {
  function newEvent(over: Partial<NewEvent>, sessionId: string, instanceId: string): NewEvent {
    return {
      sessionId,
      instanceId,
      eventType: 'PostToolUse',
      eventSubtype: null,
      toolName: null,
      toolSummary: null,
      occurredAt: toEpochMs(0),
      receivedAt: toEpochMs(0),
      ...over,
    }
  }

  it('appends events and assigns autoincrement ids', () => {
    const { instance } = seedInstance()
    new SessionRepository(db).upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    const repo = new EventRepository(db)
    const e1 = repo.append(newEvent({ receivedAt: toEpochMs(100) }, 'sess1', instance.id))
    const e2 = repo.append(newEvent({ receivedAt: toEpochMs(200) }, 'sess1', instance.id))

    expect(e1.id).toBeGreaterThan(0)
    expect(e2.id).toBe(e1.id + 1)
  })

  it('allForSession orders by received_at then id (not occurred_at)', () => {
    const { instance } = seedInstance()
    new SessionRepository(db).upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    const repo = new EventRepository(db)
    // Insert out of received_at order, with occurred_at deliberately inverted.
    repo.append(
      newEvent({ occurredAt: toEpochMs(999), receivedAt: toEpochMs(300) }, 'sess1', instance.id)
    )
    repo.append(
      newEvent({ occurredAt: toEpochMs(1), receivedAt: toEpochMs(100) }, 'sess1', instance.id)
    )
    repo.append(
      newEvent({ occurredAt: toEpochMs(500), receivedAt: toEpochMs(200) }, 'sess1', instance.id)
    )

    const received = repo.allForSession('sess1').map((e) => e.receivedAt)
    expect(received).toEqual([100, 200, 300])
  })

  it('recentForInstance returns newest-by-occurred_at first and respects the limit', () => {
    const { instance } = seedInstance()
    new SessionRepository(db).upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    const repo = new EventRepository(db)
    repo.append(newEvent({ occurredAt: toEpochMs(10) }, 'sess1', instance.id))
    repo.append(newEvent({ occurredAt: toEpochMs(30) }, 'sess1', instance.id))
    repo.append(newEvent({ occurredAt: toEpochMs(20) }, 'sess1', instance.id))

    const occurred = repo.recentForInstance(instance.id, 2).map((e) => e.occurredAt)
    expect(occurred).toEqual([30, 20])
  })

  it('recentPageForSession returns newest-first pages and cursor excludes already-seen rows (perf review #high)', () => {
    const { instance } = seedInstance()
    new SessionRepository(db).upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    const repo = new EventRepository(db)
    for (let i = 0; i < 5; i++) {
      repo.append(newEvent({ receivedAt: toEpochMs(i * 10) }, 'sess1', instance.id))
    }

    const firstPage = repo.recentPageForSession('sess1', 2)
    expect(firstPage.map((e) => e.receivedAt)).toEqual([40, 30])

    const last = firstPage[firstPage.length - 1]
    const secondPage = repo.recentPageForSession('sess1', 2, {
      receivedAt: last.receivedAt,
      id: last.id,
    })
    expect(secondPage.map((e) => e.receivedAt)).toEqual([20, 10])

    const thirdPage = repo.recentPageForSession('sess1', 2, {
      receivedAt: secondPage[1].receivedAt,
      id: secondPage[1].id,
    })
    expect(thirdPage.map((e) => e.receivedAt)).toEqual([0])

    const fourthPage = repo.recentPageForSession('sess1', 2, {
      receivedAt: thirdPage[0].receivedAt,
      id: thirdPage[0].id,
    })
    expect(fourthPage).toEqual([])
  })

  it('recentPageForSession ties on received_at are broken by id descending (matches allForSession tiebreak)', () => {
    const { instance } = seedInstance()
    new SessionRepository(db).upsertStarted(instance.id, 'sess1', toEpochMs(1000))
    const repo = new EventRepository(db)
    const a = repo.append(newEvent({ receivedAt: toEpochMs(100) }, 'sess1', instance.id))
    const b = repo.append(newEvent({ receivedAt: toEpochMs(100) }, 'sess1', instance.id))

    const page = repo.recentPageForSession('sess1', 10)
    expect(page.map((e) => e.id)).toEqual([b.id, a.id])
  })
})

describe('TokenRepository (§0.3)', () => {
  it('creates, finds by hash and enforces token_hash uniqueness', () => {
    const { device } = seedInstance()
    const repo = new TokenRepository(db)
    const created = repo.create(device.id, 'sha256-hash-1')

    expect(created.id).toBeGreaterThan(0)
    expect(created.revokedAt).toBeNull()
    expect(repo.findByHash('sha256-hash-1')?.id).toBe(created.id)
    expect(repo.findByHash('missing')).toBeNull()
    expect(() => repo.create(device.id, 'sha256-hash-1')).toThrow() // UNIQUE(token_hash)
  })

  it('revoke sets revoked_at', () => {
    const { device } = seedInstance()
    const repo = new TokenRepository(db)
    const created = repo.create(device.id, 'sha256-hash-2')
    repo.revoke(created.id, toEpochMs(5000))

    expect(repo.findByHash('sha256-hash-2')?.revokedAt).toBe(5000)
  })

  it('findByDeviceId returns every token for the device (id ascending, revoked included)', () => {
    const { device, devices } = seedInstance()
    devices.upsert({
      id: 'macbook',
      name: 'macbook.local',
      role: 'CHILD',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    })
    const repo = new TokenRepository(db)
    const t1 = repo.create(device.id, 'hash-a')
    const t2 = repo.create(device.id, 'hash-b')
    repo.create('macbook', 'hash-other') // different device, must not leak in
    repo.revoke(t1.id, toEpochMs(5000))

    const tokens = repo.findByDeviceId(device.id)
    expect(tokens.map((t) => t.id)).toEqual([t1.id, t2.id])
    expect(tokens[0].revokedAt).toBe(5000)
    expect(tokens[1].revokedAt).toBeNull()
    expect(repo.findByDeviceId('unknown-device')).toEqual([])
  })

  it('revokeByDeviceId revokes only the active tokens of that device and returns the count (FR-03 AC-2)', () => {
    const { device, devices } = seedInstance()
    devices.upsert({
      id: 'macbook',
      name: 'macbook.local',
      role: 'CHILD',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    })
    const repo = new TokenRepository(db)
    const a1 = repo.create(device.id, 'hash-1')
    repo.create(device.id, 'hash-2')
    const other = repo.create('macbook', 'hash-3')
    repo.revoke(a1.id, toEpochMs(1000)) // already revoked → not counted/updated again

    const revoked = repo.revokeByDeviceId(device.id, toEpochMs(9000))
    expect(revoked).toBe(1) // only the single active token of macmini-1

    // Already-revoked token keeps its original revoked_at (not overwritten).
    expect(repo.findByHash('hash-1')?.revokedAt).toBe(1000)
    expect(repo.findByHash('hash-2')?.revokedAt).toBe(9000)
    // Other device untouched.
    expect(repo.findByHash('hash-3')?.revokedAt).toBeNull()
    expect(other.revokedAt).toBeNull()

    // Idempotent: a second sweep finds nothing active.
    expect(repo.revokeByDeviceId(device.id, toEpochMs(9999))).toBe(0)
  })

  it('listDeviceIdsWithActiveToken returns distinct device_ids with at least one active token (review #3)', () => {
    const { device, devices } = seedInstance()
    devices.upsert({
      id: 'macbook',
      name: 'macbook.local',
      role: 'CHILD',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    })
    devices.upsert({
      id: 'ipad',
      name: 'ipad.local',
      role: 'CHILD',
      firstSeenAt: toEpochMs(1000),
      lastSeenAt: toEpochMs(1000),
    })
    const repo = new TokenRepository(db)
    // macmini-1: two tokens, one revoked → still active overall.
    const a1 = repo.create(device.id, 'hash-a1')
    repo.create(device.id, 'hash-a2')
    repo.revoke(a1.id, toEpochMs(2000))
    // macbook: only token revoked → not active.
    const b1 = repo.create('macbook', 'hash-b1')
    repo.revoke(b1.id, toEpochMs(2000))
    // ipad: never had a token.

    const activeIds = repo.listDeviceIdsWithActiveToken()
    expect(new Set(activeIds)).toEqual(new Set([device.id]))
    expect(activeIds).not.toContain('macbook')
    expect(activeIds).not.toContain('ipad')
  })
})

describe('PrStatusRepository', () => {
  it('upserts idempotently on (project_id, branch)', () => {
    const { project } = seedInstance()
    const repo = new PrStatusRepository(db)
    repo.upsert({
      projectId: project.id,
      branch: 'main',
      prNumber: 1,
      state: 'awaiting_review',
      url: 'https://example/pr/1',
      checkedAt: toEpochMs(1000),
    })
    const updated = repo.upsert({
      projectId: project.id,
      branch: 'main',
      prNumber: 1,
      state: 'approved',
      url: 'https://example/pr/1',
      checkedAt: toEpochMs(2000),
    })

    expect(updated.state).toBe('approved')
    expect(repo.findByProjectBranch(project.id, 'main')?.state).toBe('approved')
    const count = db.prepare('SELECT COUNT(*) c FROM pr_status').get() as { c: number }
    expect(count.c).toBe(1)
  })
})
