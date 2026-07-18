import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusRow } from '../hub/dto.js'
import { InstanceListStore } from './instance-list-store.js'
import type { StatusFilter } from './status-display.js'

/** 表示状態だけを差し替えたテスト用 instance 行を作る。 */
function row(instanceId: string, display: string, projectId = instanceId): InstanceStatusRow {
  return {
    instance_id: instanceId,
    project: { id: projectId, name: projectId },
    device: { id: 'dev-1', name: 'Mac mini' },
    path: `/repos/${instanceId}`,
    branch: 'main',
    status: {
      display,
      raw_state: display === 'stale' ? 'active' : display,
      elapsed_seconds: 0,
      is_stale: display === 'stale',
      priority: 0,
    },
    pr: { state: 'none', number: null, url: null, is_draft: false },
    session: { id: `sess-${instanceId}`, last_heartbeat_at: null, terminal: null },
    running_work: null,
  }
}

const sample: InstanceStatusRow[] = [
  row('a', 'active'),
  row('b', 'approval_wait'),
  row('c', 'next_wait'),
  row('d', 'active'),
  row('e', 'stale'),
  row('f', 'closed'),
]

describe('InstanceListStore — フィルタ保持と filtered()（FR-05 AC-2 / §0.5）', () => {
  it('フィルタ未設定なら closed 以外を返す（複製を返し、内部配列を露出しない、AC-1）', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    expect(store.filtered()).toHaveLength(5)
    expect(store.filtered().map((r) => r.instance_id)).not.toContain('f')
    expect(store.filtered()).not.toBe(store.instances)
  })

  it('toggleFilter で状態フィルタを付与し、該当行だけに絞る', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.toggleFilter('active')
    expect(store.filtered().map((r) => r.instance_id)).toEqual(['a', 'd'])
    expect(store.activeFilters).toEqual(['active'])
  })

  it('複数フィルタは OR で合成される（複数選択可）', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.toggleFilter('active')
    store.toggleFilter('stale')
    expect(store.filtered().map((r) => r.instance_id)).toEqual(['a', 'd', 'e'])
  })

  it('同じフィルタを再トグルすると解除される', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.toggleFilter('approval_wait')
    expect(store.filtered().map((r) => r.instance_id)).toEqual(['b'])
    store.toggleFilter('approval_wait')
    expect(store.filtered()).toHaveLength(5)
    expect(store.filtered().map((r) => r.instance_id)).not.toContain('f')
    expect(store.activeFilters).toEqual([])
  })

  it('setFilter は重複を除去して一括設定する', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.setFilter(['active', 'active', 'stale'] as StatusFilter[])
    expect(store.activeFilters).toEqual(['active', 'stale'])
  })

  it('clearFilters で全解除する', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.toggleFilter('active')
    store.clearFilters()
    expect(store.activeFilters).toEqual([])
    expect(store.filtered()).toHaveLength(5)
    expect(store.filtered().map((r) => r.instance_id)).not.toContain('f')
  })

  it('setInstances で取得結果を差し替える（ポーリング更新の反映）', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.setInstances([row('x', 'active')])
    expect(store.filtered().map((r) => r.instance_id)).toEqual(['x'])
  })

  it('projectRows はフィルタ適用後を project 単位へ畳み込む', () => {
    const store = new InstanceListStore()
    store.setInstances([
      row('a', 'active', 'proj-1'),
      row('b', 'approval_wait', 'proj-1'),
      row('c', 'active', 'proj-2'),
    ])
    expect(store.projectRows()).toHaveLength(2)
    store.toggleFilter('approval_wait')
    // proj-2 は該当なしなので畳み込み対象から外れる。
    expect(store.projectRows().map((p) => p.projectId)).toEqual(['proj-1'])
  })

  it('projectRows(rows) は渡された行をそのまま畳み込み、内部で filtered() を再計算しない（release-20-dashboard-heap-guard FR-03 AC-1）', () => {
    const store = new InstanceListStore()
    store.setInstances([
      row('a', 'active', 'proj-1'),
      row('b', 'approval_wait', 'proj-1'),
      row('c', 'active', 'proj-2'),
    ])
    const filteredSpy = vi.spyOn(store, 'filtered')

    // 呼び出し側が既に計算済みの行（例えば filter で絞った一部だけ）を渡すと、
    // それを畳み込み対象として使う（内部の filtered() 全件とは異なる結果になることで判別する）。
    const preComputed = store.filtered().filter((r) => r.instance_id !== 'b')
    filteredSpy.mockClear()

    const result = store.projectRows(preComputed)

    expect(result.map((p) => p.projectId)).toEqual(['proj-1', 'proj-2'])
    expect(result.find((p) => p.projectId === 'proj-1')?.instanceCount).toBe(1)
    // filtered() を渡された rows があるときは再呼び出ししない。
    expect(filteredSpy).not.toHaveBeenCalled()

    filteredSpy.mockRestore()
  })

  it('projectRows() を rows 省略で呼ぶと従来どおり内部で filtered() を計算する', () => {
    const store = new InstanceListStore()
    store.setInstances([
      row('a', 'active', 'proj-1'),
      row('b', 'approval_wait', 'proj-1'),
      row('c', 'active', 'proj-2'),
    ])
    expect(store.projectRows()).toHaveLength(2)
  })

  it('closed フィルタを明示的に選択すると closed 行が表示される（AC-3 複数選択対応）', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.toggleFilter('closed')
    expect(store.filtered().map((r) => r.instance_id)).toEqual(['f'])
    expect(store.activeFilters).toEqual(['closed'])
  })

  it('複数フィルタと closed を併用すると、該当行 + closed が表示される（AC-7）', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.toggleFilter('active')
    store.toggleFilter('closed')
    expect(store.filtered().map((r) => r.instance_id)).toEqual(['a', 'd', 'f'])
    expect(store.activeFilters).toContain('closed')
  })

  it('closed フィルタを再トグルすると解除され、既定の非表示に戻る（AC-3）', () => {
    const store = new InstanceListStore()
    store.setInstances(sample)
    store.toggleFilter('closed')
    expect(store.filtered().map((r) => r.instance_id)).toContain('f')
    store.toggleFilter('closed')
    expect(store.activeFilters).toEqual([])
    expect(store.filtered().map((r) => r.instance_id)).not.toContain('f')
    expect(store.filtered()).toHaveLength(5)
  })
})
