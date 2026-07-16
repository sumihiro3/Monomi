import { describe, expect, it } from 'vitest'
import type {
  Device,
  DeviceToken,
  Event,
  Instance,
  Project,
  ProjectKey,
  PrStatus,
  Session,
} from './entities.js'
import { toEpochMs } from './time.js'

/**
 * これらのエンティティはロジックを持たない純粋な型定義なので、テストは
 * 「§7.3 DDL に対応する形の object literal が型検査を通り、後続レイヤーが
 * import して使える」ことを確認するスモークテストに留める。
 */
describe('domain entities', () => {
  it('accepts a full object graph matching §7.3', () => {
    const projectKey: ProjectKey = { value: 'github.com/sumihiro/monomi', kind: 'GIT_REMOTE' }

    const device: Device = {
      id: 'macmini-1',
      name: 'Mac mini',
      role: 'HUB',
      firstSeenAt: toEpochMs(1),
      lastSeenAt: toEpochMs(2),
    }

    const project: Project = {
      id: 'proj_01',
      projectKey,
      displayName: null,
      createdAt: toEpochMs(1),
    }

    const instance: Instance = {
      id: 'inst_01',
      projectId: project.id,
      deviceId: device.id,
      path: '/Users/sumihiro/dev/monomi',
      branch: null,
      createdAt: toEpochMs(1),
      removedAt: null,
    }

    const session: Session = {
      id: 'a1b2c3d4',
      instanceId: instance.id,
      agentType: 'claude_code',
      pid: null,
      startedAt: toEpochMs(1),
      endedAt: null,
      endReason: null,
      lastHeartbeatAt: null,
      terminal: null,
    }

    const event: Event = {
      id: 1,
      sessionId: session.id,
      instanceId: instance.id,
      eventType: 'Notification',
      eventSubtype: 'permission_prompt',
      toolName: 'Bash',
      toolSummary: 'npm install',
      occurredAt: toEpochMs(100),
      receivedAt: toEpochMs(105),
    }

    const token: DeviceToken = {
      id: 1,
      deviceId: device.id,
      tokenHash: 'deadbeef',
      createdAt: toEpochMs(1),
      revokedAt: null,
    }

    const pr: PrStatus = {
      id: 1,
      projectId: project.id,
      branch: 'main',
      prNumber: null,
      state: 'none',
      url: null,
      checkedAt: toEpochMs(1),
    }

    // receivedAt is the hub-authoritative time and must never precede occurredAt in this fixture.
    expect(event.receivedAt).toBeGreaterThanOrEqual(event.occurredAt)
    expect([device, project, instance, session, event, token, pr]).toHaveLength(7)
  })
})
