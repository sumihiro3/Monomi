import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstanceDetail, InstanceStatusRow } from '../../hub/dto.js'
import type { HubApiClient } from '../hub-api-client.js'
import { AppView } from './app-view.js'

/** テスト用 instance 行を作る（表示に効く最小フィールドのみ指定）。 */
function makeRow(over: {
  id: string
  projectName: string
  display: string
  priority: number
  branch?: string | null
}): InstanceStatusRow {
  return {
    instance_id: over.id,
    project: { id: `proj-${over.id}`, name: over.projectName },
    device: { id: 'macmini', name: 'Mac mini' },
    path: `/Users/sumihiro/dev/${over.projectName}`,
    branch: over.branch ?? 'main',
    status: {
      display: over.display,
      raw_state: over.display === 'stale' ? 'active' : over.display,
      elapsed_seconds: 720,
      is_stale: over.display === 'stale',
      priority: over.priority,
    },
    pr: { state: 'none' },
    session: { id: `sess-${over.id}`, last_heartbeat_at: null },
  }
}

/** テスト用の詳細（直近イベント付き）を作る。 */
function makeDetail(row: InstanceStatusRow): InstanceDetail {
  return {
    ...row,
    recent_events: [
      {
        id: 2,
        event_type: 'Notification',
        event_subtype: 'permission_prompt',
        tool_name: null,
        tool_summary: null,
        occurred_at: '2026-07-01T05:12:03.000Z',
        received_at: '2026-07-01T05:12:03.100Z',
      },
      {
        id: 1,
        event_type: 'PostToolUse',
        event_subtype: null,
        tool_name: 'Bash',
        tool_summary: 'npm install',
        occurred_at: '2026-07-01T05:11:00.000Z',
        received_at: '2026-07-01T05:11:00.100Z',
      },
    ],
  }
}

/**
 * HubApiClient の差し替え（実 HTTP を張らずに AppView を駆動する）。
 * `instances` を後から書き換えて watch モードの再取得を検証できる。
 */
class FakeHubApiClient {
  instances: InstanceStatusRow[]
  details = new Map<string, InstanceDetail>()
  listCalls = 0

  constructor(instances: InstanceStatusRow[]) {
    this.instances = instances
  }

  listInstances(): Promise<InstanceStatusRow[]> {
    this.listCalls += 1
    return Promise.resolve(this.instances)
  }

  getInstanceDetail(id: string): Promise<InstanceDetail> {
    const detail = this.details.get(id)
    return detail === undefined
      ? Promise.reject(new Error(`no detail fixture for ${id}`))
      : Promise.resolve(detail)
  }
}

/** FakeHubApiClient を HubApiClient として AppView に渡す。 */
function asClient(fake: FakeHubApiClient): HubApiClient {
  return fake as unknown as HubApiClient
}

let active: ReturnType<typeof render> | null = null

function renderApp(fake: FakeHubApiClient, pollIntervalMs = 40): ReturnType<typeof render> {
  active = render(<AppView client={asClient(fake)} pollIntervalMs={pollIntervalMs} />)
  return active
}

afterEach(() => {
  active?.unmount()
  active = null
})

describe('AppView — 一覧・フィルタ・watch・詳細（FR-05 AC-1〜AC-4）', () => {
  it('AC-1: 起動で全 instance が状態付きで一覧表示される', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ])
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('Monban')
    })
    // 導出済みの状態ラベル（日本語）が付いている。
    expect(lastFrame()).toContain('稼働中')
    expect(lastFrame()).toContain('権限待ち')
    // ヘッダのプロジェクト/デバイス数。
    expect(lastFrame()).toContain('2 projects · 1 devices')
  })

  it('AC-2: 1 キーで active フィルタに絞られ、再押下で解除される', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ])
    const { lastFrame, stdin } = renderApp(fake)
    await vi.waitFor(() => expect(lastFrame()).toContain('Monban'))

    stdin.write('1') // active のみに絞る
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).not.toContain('Monban')
    })

    stdin.write('1') // 解除して全件へ戻す
    await vi.waitFor(() => expect(lastFrame()).toContain('Monban'))
  })

  it('AC-3: watch モードは起動直後から常時 ON で、間隔ポーリングで一覧が更新される（FR-03 AC-1・AC-3）', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame } = renderApp(fake, 30)

    // 起動直後から watch ON（FR-03 AC-1/AC-3）。初回全件表示（FR-05 AC-1）も維持される。
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('watching')
    })

    // 稼働中のポーリングでサーバ側データが増えると、次のポーリングで一覧へ反映される。
    fake.instances = [
      ...fake.instances,
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ]
    await vi.waitFor(() => expect(lastFrame()).toContain('Monban'), { timeout: 2000 })

    // 手動での OFF トグルは持たない（FR-03 AC-2 撤回）。フッターにも w watch は出ない。
    expect(lastFrame()).not.toContain('w watch')
  })

  it('AC-4: Enter で選択 instance の直近イベントタイムラインを表示する', async () => {
    const target = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
      branch: 'feature/ai-sidecar',
    })
    const fake = new FakeHubApiClient([target])
    fake.details.set(target.instance_id, makeDetail(target))

    const { lastFrame, stdin } = renderApp(fake)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('\r') // Enter → 詳細
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('recent events')
      expect(frame).toContain('PostToolUse')
      expect(frame).toContain('Bash')
      expect(frame).toContain('npm install')
    })
    // 詳細ヘッダにブランチと戻り方が出る。
    expect(lastFrame()).toContain('feature/ai-sidecar')
    expect(lastFrame()).toContain('[esc] back')
  })
})

describe('AppView — 詳細ビュー中のショートカットヒント切替と無効化（FR-04）', () => {
  it('一覧表示中と詳細表示中でフッターのヒントが切り替わる', async () => {
    const target = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([target])
    fake.details.set(target.instance_id, makeDetail(target))

    const { lastFrame, stdin } = renderApp(fake)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    // 一覧表示中: フィルタ・移動・detail・watch(廃止済み)を含む一覧向けヒント。
    expect(lastFrame()).toContain('1-5 filter')
    expect(lastFrame()).toContain('j/k')
    expect(lastFrame()).not.toContain('w watch')

    stdin.write('\r') // Enter → 詳細
    await vi.waitFor(() => expect(lastFrame()).toContain('recent events'))

    // 詳細表示中: esc/help/quit のみのヒントに切り替わり、一覧向けヒントは出ない。
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).not.toContain('1-5 filter')
      expect(frame).not.toContain('j/k')
      expect(frame).toContain('esc back')
      expect(frame).toContain('? help')
      expect(frame).toContain('q quit')
    })
  })

  it('詳細表示中はフィルタ・カーソル移動キーが無視される（誤操作防止）', async () => {
    const rowA = makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 })
    const rowB = makeRow({
      id: '2',
      projectName: 'Monban',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([rowA, rowB])
    fake.details.set(rowA.instance_id, makeDetail(rowA))

    const { lastFrame, stdin } = renderApp(fake)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('\r') // Enter → rowA（先頭選択）の詳細を開く
    await vi.waitFor(() => expect(lastFrame()).toContain('recent events'))

    // 詳細表示中に 1（フィルタ）・j（カーソル移動）を押しても無視される。
    // 何も視覚的に変化しない操作なので vi.waitFor では待てず、実際に処理される時間を空ける。
    stdin.write('1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    stdin.write('j')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lastFrame()).toContain('recent events') // 詳細表示のままで変化なし

    stdin.write(String.fromCharCode(27)) // esc で一覧へ戻る
    // 'ProjectLens' は詳細ビューの見出しにも出るため判定に使わない（一覧固有の 'recent events'
    // 不在で判定する）。
    await vi.waitFor(() => expect(lastFrame()).not.toContain('recent events'))

    // フィルタが適用されていれば approval_wait の Monban は消えているはず。無視されたので両方残る。
    expect(lastFrame()).toContain('Monban')
  })
})
