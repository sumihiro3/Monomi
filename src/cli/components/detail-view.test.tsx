import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstanceDetail, InstanceStatusRow, RecentEventDto, StatusDto } from '../../hub/dto.js'
import type { HubApiClient } from '../hub-api-client.js'
import { DetailView } from './detail-view.js'

/** テスト用に一覧から選択された 1 行を作る（表示に効く最小フィールドのみ）。 */
function makeRow(): InstanceStatusRow {
  return {
    instance_id: 'inst-1',
    project: { id: 'proj-1', name: 'ProjectLens' },
    device: { id: 'macmini', name: 'Mac mini' },
    path: '/Users/sumihiro/dev/ProjectLens',
    branch: 'feature/ai-sidecar',
    status: {
      display: 'approval_wait',
      raw_state: 'approval_wait',
      elapsed_seconds: 720,
      is_stale: false,
      priority: 4,
    },
    pr: { state: 'none' },
    session: { id: 'sess-1', last_heartbeat_at: null },
  }
}

/** 直近イベント 1 件を作る（フィード表示の検証用）。 */
function makeEvent(over: {
  id: number
  event_type: string
  event_subtype?: string | null
  tool_name?: string | null
  tool_summary?: string | null
}): RecentEventDto {
  return {
    id: over.id,
    event_type: over.event_type,
    event_subtype: over.event_subtype ?? null,
    tool_name: over.tool_name ?? null,
    tool_summary: over.tool_summary ?? null,
    occurred_at: '2026-07-01T05:11:00.000Z',
    received_at: '2026-07-01T05:11:00.100Z',
  }
}

/** 一覧 1 行に直近イベント列（と任意の status 上書き）を足して詳細を作る。 */
function makeDetail(
  row: InstanceStatusRow,
  events: RecentEventDto[],
  statusOver?: Partial<StatusDto>
): InstanceDetail {
  return { ...row, status: { ...row.status, ...statusOver }, recent_events: events }
}

/**
 * getInstanceDetail だけを差し替えた HubApiClient のスタブ。
 * `responder` を後から差し替えて「サーバ側データの変化」や「取得失敗」を再現できる。
 */
class FakeDetailClient {
  detailCalls = 0
  private responder: () => InstanceDetail

  constructor(responder: () => InstanceDetail) {
    this.responder = responder
  }

  setResponder(responder: () => InstanceDetail): void {
    this.responder = responder
  }

  getInstanceDetail(_id: string): Promise<InstanceDetail> {
    this.detailCalls += 1
    try {
      return Promise.resolve(this.responder())
    } catch (err) {
      return Promise.reject(err)
    }
  }
}

/** FakeDetailClient を HubApiClient として DetailView に渡す。 */
function asClient(fake: FakeDetailClient): HubApiClient {
  return fake as unknown as HubApiClient
}

let active: ReturnType<typeof render> | null = null

function renderDetail(
  fake: FakeDetailClient,
  row: InstanceStatusRow,
  pollIntervalMs = 30
): ReturnType<typeof render> {
  active = render(<DetailView client={asClient(fake)} row={row} pollIntervalMs={pollIntervalMs} />)
  return active
}

afterEach(() => {
  active?.unmount()
  active = null
})

describe('DetailView — 自動更新（FR-05 AC-1〜AC-4）', () => {
  it('AC-2: マウント直後（打鍵不要）に初回の詳細が表示される', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() =>
      makeDetail(row, [
        makeEvent({
          id: 1,
          event_type: 'PostToolUse',
          tool_name: 'Bash',
          tool_summary: 'npm install',
        }),
      ])
    )
    const { lastFrame } = renderDetail(fake, row, 30)

    // start() の即時取得により、キー入力なしで初回のイベントが出る。
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('recent events')
      expect(frame).toContain('PostToolUse')
      expect(frame).toContain('Bash')
      expect(frame).toContain('npm install')
    })
    // ヘッダ・メタ情報も表示される。
    expect(lastFrame()).toContain('ProjectLens')
    expect(lastFrame()).toContain('feature/ai-sidecar')
    expect(lastFrame()).toContain('[esc] back')
  })

  it('AC-1: pollIntervalMs 間隔で再取得し status・recent events が自動更新される', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() =>
      makeDetail(row, [
        makeEvent({
          id: 1,
          event_type: 'PostToolUse',
          tool_name: 'Bash',
          tool_summary: 'npm install',
        }),
      ])
    )
    const { lastFrame } = renderDetail(fake, row, 30)

    // 初期状態: 権限待ち + npm install。
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('npm install')
      expect(frame).toContain('権限待ち')
    })

    // サーバ側データを差し替える → 次のポーリングで status とイベントが自動反映される。
    fake.setResponder(() =>
      makeDetail(
        row,
        [makeEvent({ id: 2, event_type: 'Notification', event_subtype: 'permission_prompt' })],
        { display: 'active', raw_state: 'active' }
      )
    )
    await vi.waitFor(
      () => {
        const frame = lastFrame() ?? ''
        expect(frame).toContain('稼働中') // status が権限待ち→稼働中へ更新
        expect(frame).toContain('Notification') // recent events も更新
      },
      { timeout: 2000 }
    )
  })

  it('AC-3: アンマウントするとポーリングが止まり getInstanceDetail が増えない', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() =>
      makeDetail(row, [makeEvent({ id: 1, event_type: 'PostToolUse' })])
    )
    const { lastFrame, unmount } = renderDetail(fake, row, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('PostToolUse'))

    unmount()
    active = null // afterEach の二重 unmount を避ける
    const callsAtUnmount = fake.detailCalls

    // 数インターバル分待っても取得回数は増えない（stop() で interval を止めている）。
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(fake.detailCalls).toBe(callsAtUnmount)
  })

  it('AC-4: バックグラウンド取得失敗でも直前の detail を保持し続ける', async () => {
    const row = makeRow()
    let ok = true
    const fake = new FakeDetailClient(() => {
      if (!ok) throw new Error('temporary hub outage')
      return makeDetail(row, [
        makeEvent({
          id: 1,
          event_type: 'PostToolUse',
          tool_name: 'Bash',
          tool_summary: 'npm install',
        }),
      ])
    })
    const { lastFrame } = renderDetail(fake, row, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('npm install'))
    const callsBefore = fake.detailCalls

    // 以降のポーリングを失敗させ、複数回失敗するまで待つ。
    ok = false
    await vi.waitFor(() => expect(fake.detailCalls).toBeGreaterThan(callsBefore + 1), {
      timeout: 2000,
    })

    // 直前の detail（events）は保持され、エラーもローディングも前面に出ない。
    const frame = lastFrame() ?? ''
    expect(frame).toContain('npm install')
    expect(frame).toContain('PostToolUse')
    expect(frame).not.toContain('詳細の取得に失敗しました')
    expect(frame).not.toContain('読み込み中')
  })

  it('初回ロード失敗時のみエラーを前面に出す（detail 未取得）', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() => {
      throw new Error('boom')
    })
    const { lastFrame } = renderDetail(fake, row, 20)

    // detail が一度も取得できていないので、エラーを前面表示する。
    await vi.waitFor(() => expect(lastFrame()).toContain('詳細の取得に失敗しました'))
    // ヘッダ・メタ情報は選択行から描かれ、レイアウトは維持される。
    expect(lastFrame()).toContain('ProjectLens')
    expect(lastFrame()).toContain('feature/ai-sidecar')
  })
})
