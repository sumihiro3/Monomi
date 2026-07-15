import { describe, expect, it } from 'vitest'
import type { InstanceStatusRow } from '../hub/dto.js'
import { ClientRollup } from './client-rollup.js'

const rollup = new ClientRollup()

/**
 * テスト用の instance 行を組み立てる。ClientRollup が参照するのは project / status.priority /
 * status.display のみなので、それ以外は最小限のプレースホルダで埋める。
 */
function row(over: {
  instanceId: string
  projectId: string
  projectName?: string
  priority: number
  display?: string
}): InstanceStatusRow {
  return {
    instance_id: over.instanceId,
    project: { id: over.projectId, name: over.projectName ?? over.projectId },
    device: { id: 'dev-1', name: 'Mac mini' },
    path: `/repos/${over.instanceId}`,
    branch: 'main',
    status: {
      display: over.display ?? 'active',
      raw_state: 'active',
      elapsed_seconds: 0,
      is_stale: false,
      priority: over.priority,
    },
    pr: { state: 'none' },
    session: { id: `sess-${over.instanceId}`, last_heartbeat_at: null, terminal: null },
    running_work: null,
  }
}

describe('ClientRollup.rollupByProject — project 単位の priority max()（§5.3 / §0.5）', () => {
  it('同一 project の複数 instance を 1 行へ畳み込み、priority は max を採る', () => {
    const rows = rollup.rollupByProject([
      row({ instanceId: 'i1', projectId: 'p1', priority: 1, display: 'active' }),
      row({ instanceId: 'i2', projectId: 'p1', priority: 4, display: 'approval_wait' }),
      row({ instanceId: 'i3', projectId: 'p1', priority: 2, display: 'next_wait' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      projectId: 'p1',
      priority: 4,
      topDisplay: 'approval_wait',
      instanceCount: 3,
    })
  })

  it('project ごとに分けて、それぞれ独立に max を採る', () => {
    const rows = rollup.rollupByProject([
      row({ instanceId: 'i1', projectId: 'p1', priority: 1 }),
      row({ instanceId: 'i2', projectId: 'p2', priority: 5, display: 'stale' }),
      row({ instanceId: 'i3', projectId: 'p1', priority: 3, display: 'pr_wait' }),
    ])
    expect(rows).toHaveLength(2)
    const p1 = rows.find((r) => r.projectId === 'p1')
    const p2 = rows.find((r) => r.projectId === 'p2')
    expect(p1).toMatchObject({ priority: 3, topDisplay: 'pr_wait', instanceCount: 1 + 1 })
    expect(p2).toMatchObject({ priority: 5, topDisplay: 'stale', instanceCount: 1 })
  })

  it('project の初出順を保持する', () => {
    const rows = rollup.rollupByProject([
      row({ instanceId: 'i1', projectId: 'zebra', priority: 1 }),
      row({ instanceId: 'i2', projectId: 'alpha', priority: 1 }),
      row({ instanceId: 'i3', projectId: 'zebra', priority: 1 }),
    ])
    expect(rows.map((r) => r.projectId)).toEqual(['zebra', 'alpha'])
  })

  it('空入力では空配列を返す', () => {
    expect(rollup.rollupByProject([])).toEqual([])
  })

  it('表示名は配下 instance から採る', () => {
    const rows = rollup.rollupByProject([
      row({ instanceId: 'i1', projectId: 'p1', projectName: 'ProjectLens', priority: 1 }),
    ])
    expect(rows[0].projectName).toBe('ProjectLens')
  })
})
