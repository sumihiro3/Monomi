import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstanceDetail, InstanceStatusRow, RecentEventDto, StatusDto } from '../../hub/dto.js'
import { setActiveLocale } from '../../i18n/index.js'
import { displayWidth } from '../box-border.js'
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
    running_work: null,
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
  setActiveLocale('en')
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
      // FR-06: イベント履歴 BOX の上辺罫線にタイトルが埋め込まれる（旧「recent events」見出しは廃止）。
      // 既定ロケール（en, release-9-i18n FR-01 AC-2）では英語訳語 "Event History" になる。
      expect(frame).toContain('Event History')
      expect(frame).toContain('PostToolUse')
      expect(frame).toContain('Bash')
      expect(frame).toContain('npm install')
    })
    // ヘッダ・メタ情報も表示される。
    expect(lastFrame()).toContain('ProjectLens')
    expect(lastFrame()).toContain('feature/ai-sidecar')
    // FR-06: 概要 BOX の上辺罫線にもタイトルが埋め込まれる（旧「[esc] back」ヒントは廃止）。
    // 既定ロケール（en）では英語訳語 "Overview"。
    expect(lastFrame()).toContain('Overview')
  })

  it('AC-1: 既定ロケール（en）で pollIntervalMs 間隔で再取得し status・recent events が自動更新される（release-9-i18n FR-01 AC-2）', async () => {
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

    // 初期状態: Awaiting approval + npm install。
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('npm install')
      expect(frame).toContain('Awaiting approval')
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
        expect(frame).toContain('Active') // status が Awaiting approval→Active へ更新
        expect(frame).toContain('Notification') // recent events も更新
      },
      { timeout: 2000 }
    )
  })

  it('AC-1: locale: ja では状態ラベルが日本語で描画される（release-9-i18n FR-02 AC-2・AC-5）', async () => {
    setActiveLocale('ja')
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

    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('npm install')
      expect(frame).toContain('権限待ち')
    })
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
    // 既定ロケール（en）の訳語（'Failed to fetch details' / 'Loading'）で不在を確認する。
    const frame = lastFrame() ?? ''
    expect(frame).toContain('npm install')
    expect(frame).toContain('PostToolUse')
    expect(frame).not.toContain('Failed to fetch details')
    expect(frame).not.toContain('Loading')
  })

  it('初回ロード失敗時のみエラーを前面に出す（detail 未取得）', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() => {
      throw new Error('boom')
    })
    const { lastFrame } = renderDetail(fake, row, 20)

    // detail が一度も取得できていないので、エラーを前面表示する（既定ロケール en）。
    await vi.waitFor(() => expect(lastFrame()).toContain('Failed to fetch details'))
    // ヘッダ・メタ情報は選択行から描かれ、レイアウトは維持される。
    expect(lastFrame()).toContain('ProjectLens')
    expect(lastFrame()).toContain('feature/ai-sidecar')
  })
})

describe('DetailView — locale: ja での文言描画（release-9-i18n FR-02 AC-2・AC-5）', () => {
  it('概要/イベント履歴のタイトル・経過時間サフィックス・(イベントがありません) が日本語で描画される', async () => {
    setActiveLocale('ja')
    const row = makeRow()
    // recent_events を空にして detail.noEvents（(イベントがありません)）の分岐を通す。
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row, 30)

    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('概要')
      expect(frame).toContain('イベント履歴')
      expect(frame).toContain('(イベントがありません)')
      // detail.elapsedSuffix（'{age}経過'）。formatAge(720) === '12m'。
      expect(frame).toContain('(12m経過)')
    })
  })

  it('初回ロード中は「読み込み中…」が前面に出る', async () => {
    // getInstanceDetail が永遠に解決しない client を渡し、detail===null・error===null の
    // ローディング分岐（detail.loading）を確定的に検証する。
    setActiveLocale('ja')
    const row = makeRow()
    const neverResolvingClient = {
      getInstanceDetail: () => new Promise<InstanceDetail>(() => {}),
    } as unknown as HubApiClient
    active = render(<DetailView client={neverResolvingClient} row={row} pollIntervalMs={30} />)
    const { lastFrame } = active

    // マウント直後の即時取得（start()）が走った後も detail は届かないため、ローディング表示が残る。
    await new Promise((resolve) => setTimeout(resolve, 20))
    const frame = lastFrame() ?? ''
    expect(frame).toContain('読み込み中…')
    expect(frame).toContain('ProjectLens') // 選択行からヘッダ・メタ情報は表示される
  })

  it('初回ロード失敗時のエラーが「詳細の取得に失敗しました」で描画される', async () => {
    setActiveLocale('ja')
    const row = makeRow()
    const fake = new FakeDetailClient(() => {
      throw new Error('boom')
    })
    const { lastFrame } = renderDetail(fake, row, 20)

    // error は String(err) で保持されるため "Error: boom" になる（onError 実装参照）。
    await vi.waitFor(() => expect(lastFrame()).toContain('詳細の取得に失敗しました: Error: boom'))
  })
})

/** hub 契約（新しい順）で count 件のイベントを作る。id が大きいほど新しい。 */
function makeManyEvents(count: number): RecentEventDto[] {
  const out: RecentEventDto[] = []
  for (let id = count; id >= 1; id -= 1) {
    out.push(
      makeEvent({ id, event_type: 'PostToolUse', tool_name: 'Bash', tool_summary: `cmd-${id}` })
    )
  }
  return out
}

describe('DetailView — 上下BOX・スクロール（release-6 FR-01/FR-02）', () => {
  it('FR-01 AC-1 / FR-02 / FR-06 / FR-07: 上下2つの round BOX（╭）とタイトル・下辺範囲ラベルを描画する', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyEvents(3)))
    const { lastFrame } = renderDetail(fake, row, 30)

    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('cmd-3'))
    const frame = lastFrame() ?? ''
    // 概要BOX + イベントBOX の上辺罫線とも自前の丸角（╭）で描かれる。
    expect((frame.match(/╭/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // FR-01 AC-1: instance_id を概要BOXに表示する。
    expect(frame).toContain('inst-1')
    // FR-06: 上辺罫線にタイトルを埋め込む（旧「recent events」見出しは廃止）。既定ロケール（en）。
    expect(frame).toContain('Overview')
    expect(frame).toContain('Event History')
    // FR-07: 範囲ラベル "X-Y of Z" はイベント履歴 BOX の下辺罫線（╰ … ╯）に埋め込まれる。
    expect(frame).toMatch(/╰.*1-3 of 3.*╯/)
  })

  it('FR-02 AC-1: イベントをCLI表示側で反転し古い順（最新が末尾）で描く', async () => {
    const row = makeRow()
    // hub は新しい順で返す: [newest, middle, oldest]。表示は反転して oldest→newest。
    const fake = new FakeDetailClient(() =>
      makeDetail(row, [
        makeEvent({ id: 3, event_type: 'PostToolUse', tool_summary: 'zzz-newest' }),
        makeEvent({ id: 2, event_type: 'PostToolUse', tool_summary: 'mmm-middle' }),
        makeEvent({ id: 1, event_type: 'PostToolUse', tool_summary: 'aaa-oldest' }),
      ])
    )
    const { lastFrame } = renderDetail(fake, row, 30)

    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('aaa-oldest'))
    const frame = lastFrame() ?? ''
    // 古い順に反転: oldest が上（先）、newest が下（後）に来る。
    expect(frame.indexOf('aaa-oldest')).toBeLessThan(frame.indexOf('mmm-middle'))
    expect(frame.indexOf('mmm-middle')).toBeLessThan(frame.indexOf('zzz-newest'))
    // 全件（3 < 表示行）なので範囲ラベルは 1-3 of 3（FR-02 AC-4）。
    expect(frame).toContain('1-3 of 3')
  })

  it('FR-02 AC-3/AC-4/AC-6: 初期は最下部、j/k・↑/↓ で 1 行スクロールし X-Y of Z が動く', async () => {
    const row = makeRow()
    // 15 件 > 固定表示 10 行（ink-testing は rows 未取得のため FALLBACK_VISIBLE_ROWS=10）。
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyEvents(15)))
    const { lastFrame, stdin } = renderDetail(fake, row, 30)

    // FR-02 AC-6: 初期スクロール位置は最下部（最新 10 件 = 6-15 of 15）。
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('6-15 of 15'))

    // k（上）で 1 行ずつ古い側へ。
    stdin.write('k')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('5-14 of 15'))
    stdin.write('k')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('4-13 of 15'))
    // j（下）で 1 行ずつ新しい側へ戻る。
    stdin.write('j')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('5-14 of 15'))

    // ↑（上矢印）でも同様に古い側へスクロールする。
    stdin.write('[A')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('4-13 of 15'))
    // ↓（下矢印）で新しい側へ戻る。
    stdin.write('[B')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('5-14 of 15'))
  })

  it('FR-02 AC-7: 途中スクロール中は新着で位置を維持し、最下部にいる間は追従する', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyEvents(15)))
    const { lastFrame, stdin } = renderDetail(fake, row, 20)

    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('6-15 of 15'))
    // 途中まで上へスクロール（最下部ではない位置）。
    stdin.write('k')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('5-14 of 15'))

    // 新着 1 件で total 15→16。途中位置なので勝手にジャンプせず位置維持（5-14 のまま）。
    fake.setResponder(() => makeDetail(row, makeManyEvents(16)))
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('5-14 of 16'))

    // 最下部まで戻す（16 件・10 表示 → 7-16 of 16）。過剰押下は最下部で頭打ちになる。
    for (let i = 0; i < 12; i += 1) stdin.write('j')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('7-16 of 16'))
    // 最下部にいる間はさらに新着 17 件目に追従する。
    fake.setResponder(() => makeDetail(row, makeManyEvents(17)))
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('8-17 of 17'))
  })
})

/**
 * 切り詰め（`wrap="truncate-end"`）では BOX 幅で見切れるが折り返しでは全文が出る、末尾 marker 付きの
 * 長い `tool_summary` を持つイベント 1 件を作る（FR-08 検証用）。ink-testing の BOX 幅は
 * `resolveBoxWidth`（isTTY 未提供 → 固定 80、内側 ≒ 76 桁）に落ちる。実際の tool_summary と同様に
 * スペース区切りの語を並べて自然に折り返させ（1 語が桁幅超の非現実な入力は Ink が描画しないため避ける）、
 * 末尾 marker を必ず 1 行目より後方（切り詰め位置より後ろ）に置く。
 */
function makeLongEvent(marker: string): RecentEventDto {
  const filler = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ')
  return makeEvent({
    id: 1,
    event_type: 'PostToolUse',
    tool_summary: `${filler} ${marker}`,
  })
}

describe('DetailView — イベント行の折り返し/切り詰めトグル（release-6 FR-08）', () => {
  it('AC-1/AC-4: 既定は切り詰めで長い tool_summary が見切れ、w で折り返すと全文が出て再度 w で戻る', async () => {
    const row = makeRow()
    const fake = new FakeDetailClient(() => makeDetail(row, [makeLongEvent('ENDMARKERZ')]))
    const { lastFrame, stdin } = renderDetail(fake, row, 30)

    // FR-08 AC-4: 初期モードは切り詰め（wrap="truncate-end"）。長い summary の末尾 marker は
    // BOX 幅で見切れて frame に出ない。
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('PostToolUse'))
    expect(lastFrame() ?? '').not.toContain('ENDMARKERZ')

    // FR-08 AC-1: w で折り返し ON → 1 件が複数行に跨り、末尾 marker まで全文が表示される。
    stdin.write('w')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('ENDMARKERZ'))

    // 再度 w で切り詰めへ戻り、marker は再び見切れる（トグル）。
    stdin.write('w')
    await vi.waitFor(() => expect(lastFrame() ?? '').not.toContain('ENDMARKERZ'))
  })

  it('AC-5: wrap モードは隣接プロジェクト移動（instance 変化）をまたいで保持される', async () => {
    const rowA = makeRow()
    const rowB: InstanceStatusRow = {
      ...makeRow(),
      instance_id: 'inst-2',
      project: { id: 'proj-2', name: 'Monban' },
    }
    // 現在の対象に応じた長い summary を返す（responder 差し替えで instance 変化を再現）。
    const fake = new FakeDetailClient(() => makeDetail(rowA, [makeLongEvent('MARKER-A')]))
    const { lastFrame, stdin, rerender } = renderDetail(fake, rowA, 20)

    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('PostToolUse'))
    // 既定は切り詰め → marker は見切れる。
    expect(lastFrame() ?? '').not.toContain('MARKER-A')
    // w で折り返し ON → marker が出る。
    stdin.write('w')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('MARKER-A'))

    // 隣接プロジェクトへ移動: responder を row B に差し替え、instance の異なる DetailView を rerender。
    // instance 変化 effect は offset/detail をリセットするが wrapMode はリセットしない設計のため、
    // 切替キーを押さずに B の marker も全文表示される（FR-08 AC-5 の永続方針）。
    fake.setResponder(() => makeDetail(rowB, [makeLongEvent('MARKER-B')]))
    rerender(<DetailView client={asClient(fake)} row={rowB} pollIntervalMs={20} />)
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('MARKER-B'))
  })
})

describe('DetailView — 非TTY（rows 未取得）の固定行フォールバック（FR-02 AC-5）', () => {
  it('stdout.rows が undefined の実非TTY相当でも BOX・イベント・範囲ラベルを描く', async () => {
    // ink-testing-library の Stdout は columns=100 固定で rows/isTTY を持たない。release-4 の
    // 幅フォールバック不具合（instance-table.test の MinimalNonTtyStdout パターン）と同種の
    // 見落としを避けるため、rows:undefined を明示した実 stdout を注入し固定行フォールバック
    // （FALLBACK_VISIBLE_ROWS=10）を確定的に検証する。DetailView は useInput を持つため、raw mode
    // 要件（stdin.isTTY）を満たす stdin を渡す（本テストは入力を送らない）。
    class MinimalNonTtyStdout extends EventEmitter {
      columns: number | undefined = undefined
      rows: number | undefined = undefined
      isTTY: boolean | undefined = undefined
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyEvents(3)))
    const stdout = new MinimalNonTtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    // 非TTY stdout では ink は非インタラクティブになり、フレームは unmount 時にまとめて
    // 書き出される（instance-table.test の非TTY検証と同じ挙動）。初回ポーリング（start の即時
    // refresh）が解決してレンダリングが確定するのを待ってから unmount → 最終フレームを取り出す。
    await new Promise((resolve) => setTimeout(resolve, 120))
    unmount()
    const frame = stdout.frames[stdout.frames.length - 1] ?? ''

    // resolveBoxWidth のフォールバック幅（columns=undefined → 80）で罫線・タイトルが描かれ、
    // instance_id・全 3 件（固定 10 行に収まる）・下辺の範囲ラベルまで出る（FR-06/FR-07）。
    // 既定ロケール（en）の訳語で確認する。
    expect(frame).toContain('╭')
    expect(frame).toContain('Overview')
    expect(frame).toContain('Event History')
    expect(frame).toContain('inst-1')
    expect(frame).toContain('cmd-3')
    expect(frame).toContain('cmd-1')
    expect(frame).toContain('1-3 of 3')
  })
})

describe('DetailView — 実TTY経路（isTTY=true・columns/rows 取得可）でのBOX罫線と可変表示行数（FR-02 AC-5 / FR-06 / FR-07）', () => {
  it('rows 由来の可変表示行数・自前タイトル/範囲ラベル罫線・角整列（borderTop=false）を実TTY相当で確定させる', async () => {
    // ink-testing-library は isTTY を落とすため resolveBoxWidth / visibleRowsForHeight のフォールバック
    // （幅 80・固定 10 行）しか通らず、実TTY経路（columns/rows/isTTY が取れる本番の描画）が
    // どのユニットテストでも実行されない。ここでは columns=100・rows=30・isTTY=true の stdout を注入して
    // その経路を直接踏み、(1) 表示行数が rows から算出される（visible = 30 − DETAIL_RESERVED_ROWS(17) = 13
    // → 15 件の最下部は 3-15 of 15。固定フォールバック 10 行なら 6-15 になるので値の差で経路を判別できる）、
    // (2) borderTop=false の自前タイトル罫線／下辺範囲ラベル罫線が描かれる、(3) その各行が端末幅(100)で
    // 角文字（╭╮╰╯）と側辺 │ が桁ずれしない、ことを回帰ガードとして固定する。
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 100
      rows: number | undefined = 30
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyEvents(15)))
    const stdout = new TtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    // 実TTY経路はインクリメンタル描画（erase + 全画面書き込み）＋アンマウント時の制御シーケンスを
    // 個別に write する。合成画面は「罫線 ╭ を含む最後のフレーム」なので、それを取り出す。
    await new Promise((resolve) => setTimeout(resolve, 150))
    unmount()
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const screen =
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''

    // FR-06: 両 BOX の上辺罫線にタイトルが埋め込まれる（既定ロケール en の訳語）。
    expect(screen).toContain('Overview')
    expect(screen).toContain('Event History')
    // FR-02 AC-5: 表示行数は rows(30) から算出（visible=13）。固定フォールバック 10 行なら 6-15 になる。
    expect(screen).toContain('3-15 of 15')
    expect(screen).not.toContain('6-15 of 15')
    // FR-07: 範囲ラベルはイベント履歴 BOX の下辺罫線（╰ … ╯）へ右寄せで埋め込まれる。
    expect(screen).toMatch(/╰.*3-15 of 15.*╯/)

    // borderTop=false の自前罫線と Ink 側辺の角整列: 罫線で始まる各行は、右端の罫線グリフまでの
    // 表示桁が端末幅(100) ちょうど（右角が cell-col 99）になる。タイトル（ASCII "Overview"/
    // "Event History" だが、全角文字を含む場合も同様）の displayWidth 計算がずれると、
    // この不変条件が崩れる。
    const leftGlyphs = ['╭', '│', '╰']
    const rightGlyphs = ['╮', '│', '╯']
    let borderLineCount = 0
    for (const line of screen.split('\n')) {
      const chars = [...line]
      if (!leftGlyphs.includes(chars[0] ?? '')) continue
      let rightIdx = -1
      for (let c = chars.length - 1; c >= 0; c -= 1) {
        if (rightGlyphs.includes(chars[c])) {
          rightIdx = c
          break
        }
      }
      if (rightIdx < 0) continue
      borderLineCount += 1
      // 左角は cell-col 0、右角までの前置き表示桁は 99（= columns − 1）。
      expect(displayWidth(chars.slice(0, rightIdx).join(''))).toBe(99)
    }
    // 上辺 + 側辺 + 下辺の罫線行が十分に検出できていること（検査が空振りしていないことの担保）。
    expect(borderLineCount).toBeGreaterThanOrEqual(4)
  })

  it('review-changes 修正: extraReservedRows を渡すと、その分だけ表示行数（visible）が減る（AppView がヘルプ表示中に配線する）', async () => {
    // 実機で確認した再現ケース: detail ビュー表示中に `?` でヘルプを開くと、AppView は
    // DetailView の下に HelpOverlay（HELP_OVERLAY_ROWS + marginTop 1 行）を追加で積むが、
    // DetailView 自身はそれを知らずに「ヘルプ非表示」前提で表示行数を計算していたため、
    // 合計描画行数が端末行数を超えてヘッダー・概要BOXがスクロールして見えなくなっていた。
    // extraReservedRows を DETAIL_RESERVED_ROWS に上乗せすることで表示行数を正しく減らす。
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 100
      rows: number | undefined = 30
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyEvents(15)))
    const stdout = new TtyStdout()
    // rows=30 → 通常は visible=13（DETAIL_RESERVED_ROWS=17）で 15 件の最下部は "3-15 of 15"。
    // extraReservedRows=12 を渡すと理論値は 30-17-12=1 だが MIN_VISIBLE_ROWS(3) で下限に丸められ、
    // visible=3 になり最下部は "13-15 of 15"。
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} extraReservedRows={12} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    unmount()
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const screen =
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''

    // "3-15 of 15"（extraReservedRows 無視時の範囲）は "13-15 of 15" の部分文字列になるため、
    // 単語境界を保つ形（先頭が数字で始まらない）で否定する。
    expect(screen).toContain('13-15 of 15')
    expect(screen).not.toMatch(/[^0-9]3-15 of 15/)
  })
})

describe('DetailView — 端末リサイズ時の tail-follow 再ピン留め（review-changes 修正）', () => {
  it('最下部表示中に rows が縮小しても、新しい最下部へ追従し直す（新着追従が止まらない）', async () => {
    // 修正前は total 不変時に早期 return しており、visible だけが変わる端末リサイズでは offset が
    // 再ピン留めされず、縮小後に最新イベントが画面外へ隠れたまま新着追従も止まっていた。
    class ResizableTtyStdout extends EventEmitter {
      columns: number | undefined = 100
      rows: number | undefined = 30
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    // rows=30 → visible=13（DETAIL_RESERVED_ROWS=17）。34 件で最下部は "22-34 of 34"。
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyEvents(34)))
    const stdout = new ResizableTtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const lastScreen = (): string =>
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''

    // 初回ロード後、最下部（22-34 of 34）で安定するのを待つ。
    await vi.waitFor(() => expect(lastScreen()).toContain('22-34 of 34'))

    // 端末を縮小（rows 30→20 → visible=3）。ポーリングの次回 tick（setDetail が新オブジェクトを積む
    // ため必ず再レンダーが走る）で offset が新しい最下部（32-34 of 34）へ再ピン留めされるはず。
    stdout.rows = 20
    await vi.waitFor(
      () => {
        const screen = lastScreen()
        expect(screen).toContain('32-34 of 34')
        expect(screen).not.toContain('22-24 of 34')
      },
      { timeout: 2000 }
    )

    // リサイズ後も新着追従が生きていること（cmd-35 追加で最下部が動く）を確認する。
    fake.setResponder(() => makeDetail(row, makeManyEvents(35)))
    await vi.waitFor(() => expect(lastScreen()).toContain('33-35 of 35'), { timeout: 2000 })

    unmount()
  })
})

/**
 * 折り返すと複数行になる長い `tool_summary` を持つイベントを `count` 件作る（FR-10 検証用）。
 * 各イベントの本文は同じ長さ（多数の短い単語の連結）にし、折り返しモードで安定して
 * 複数行を消費させる。
 */
function makeManyLongEvents(count: number): RecentEventDto[] {
  const filler = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
  const out: RecentEventDto[] = []
  for (let id = count; id >= 1; id -= 1) {
    out.push(
      makeEvent({ id, event_type: 'PostToolUse', tool_name: 'Bash', tool_summary: `${filler}` })
    )
  }
  return out
}

describe('DetailView — 折り返しモードでの表示件数の動的な絞り込み（release-6 FR-10）', () => {
  it('AC-1/AC-2: 折り返しモードでは各イベントが複数行に跨る分、表示件数が切り詰めモードより減り、範囲ラベルが実表示件数を反映する', async () => {
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 100
      rows: number | undefined = 27
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      data: string | null = null
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): string | null {
        const { data } = this
        this.data = null
        return data
      }
      // ink-testing-library の Stdin.write と同じ挙動（'readable'/'data' 双方を発火する）。
      write(value: string): void {
        this.data = value
        this.emit('readable')
        this.emit('data', value)
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    // rows=27 → visible=10（DETAIL_RESERVED_ROWS=17）。15件あり、切り詰めモードなら最下部は
    // "6-15 of 15"（10件）になる。折り返しモードでは各イベントの長い tool_summary が複数行に
    // 跨るため、10件は収まりきらず表示件数が減るはず。
    const fake = new FakeDetailClient(() => makeDetail(row, makeManyLongEvents(15)))
    const stdout = new TtyStdout()
    const stdin = new TtyStdin()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const lastScreen = (): string =>
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''

    // 切り詰めモード（既定）: FR-02 の従来どおり最下部 "6-15 of 15"（10件）を表示する。
    await vi.waitFor(() => expect(lastScreen()).toContain('6-15 of 15'))

    // FR-08: w で折り返し ON。FR-10: 各イベントが複数行に跨るため、10件は visible(10) に
    // 収まりきらず、表示件数が減った範囲ラベルになる（"6-15 of 15" ではなくなる）。Z(=15) は不変。
    stdin.write('w')
    await vi.waitFor(() => {
      const screen = lastScreen()
      expect(screen).toMatch(/\d+-15 of 15/)
      expect(screen).not.toContain('6-15 of 15')
    })
    const wrappedScreen = lastScreen()
    const wrappedMatch = wrappedScreen.match(/(\d+)-15 of 15/)
    const wrappedStart = wrappedMatch ? Number(wrappedMatch[1]) : Number.NaN
    // 10件（6-15）より狭い範囲（開始 index が 6 より大きい = 表示件数が減っている）になっているはず。
    expect(wrappedStart).toBeGreaterThan(6)

    // FR-10 AC-6: 折り返しモードでもヘッダー・概要BOXは固定表示のままスクロールして消えない
    // （画面があふれていない = イベント履歴BOXの内容が visible(10) 行に収まっている証跡として、
    // 概要BOXのタイトル（既定ロケール en の訳語 "Overview"）が最終フレームに残っていることを確認する）。
    expect(wrappedScreen).toContain('Overview')
    expect(wrappedScreen).toContain('inst-1')

    unmount()
  })
})

describe('DetailView — 埋め込み改行を含むイベントでの表示件数絞り込み（review-changes 修正）', () => {
  it('切り詰めモード（既定）でも、埋め込み改行を含む1件で画面があふれず概要BOXが常に見える', async () => {
    // 実機で確認した再現ケース: tool_summary に改行が多数含まれるイベント（OGP プレビュー等）が
    // あると、切り詰め（truncate-end）モードでも Ink は改行区切りの各区間を独立した行として描画する
    // ため、「1件=1行」の前提が崩れて画面があふれ、固定表示のはずの概要BOXが画面外へ押し出されていた。
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 90
      rows: number | undefined = 25
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    const multiLineSummary = Array.from({ length: 12 }, (_, i) => `paragraph line ${i + 1}`).join(
      '\n'
    )
    // hub 契約は新しい順（id が大きいほど新しい）。id=6 の巨大イベントを先頭（=最新）に置き、
    // tail-follow で最新側から表示したときにこの巨大イベントが含まれる状況を再現する。
    const events = [
      makeEvent({
        id: 6,
        event_type: 'PostToolUse',
        tool_name: 'Bash',
        tool_summary: multiLineSummary,
      }),
      ...makeManyEvents(5),
    ]
    const fake = new FakeDetailClient(() => makeDetail(row, events))
    const stdout = new TtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    unmount()
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const screen =
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''

    // rows=25 → visible=8（DETAIL_RESERVED_ROWS=17）。改行を含む最新イベント（id=6、12行相当）
    // だけで既に visible を超えるため、hardLineAwareWindowForTexts はそれ以外の5件を切り捨て
    // 「6-6 of 6」になるはず。修正前（windowForOffset のみ、1件=1行前提）だと6件とも1行として
    // 数えられ、素通しで「1-6 of 6」（全件表示）になり画面があふれる。
    expect(screen).toContain('6-6 of 6')
    expect(screen).not.toContain('1-6 of 6')
    // 概要BOX（タイトル・instance_id）自体は正しくレンダリングされている
    // （このアサーションは stdout モックが実端末のスクロール境界を再現しないため、
    // 画面外へ押し出されたかどうかまでは検証できない。押し出されていないことの根拠は
    // 上の範囲ラベルの絞り込みそのもの＝表示行数が visible に収まっていること）。
    // 既定ロケール（en）の訳語 "Overview" で確認する。
    expect(screen).toContain('Overview')
    expect(screen).toContain('inst-1')
  })

  it('review-changes 修正（ユーザー指摘）: 境界イベントが丸ごとは収まらない場合、末尾側（より新しい部分）だけ部分採用してBOXを埋め切る', async () => {
    // 「スクロールできる＝BOX内の全行が埋まっているはず」というユーザー指摘に基づく修正。
    // 丸ごと除外していた旧実装と異なり、境界イベントの末尾（より新しい）ハード改行区間だけを
    // 残して visible をちょうど埋め切ることを検証する。
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 90
      rows: number | undefined = 25
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    // 12行の段落（各行は幅に十分収まる短さ）を持つ最新イベント1件のみ。visible=8 のため
    // 丸ごとは収まらず、末尾8行（paragraph line 5〜12）だけが残るはず。
    const multiLineSummary = Array.from({ length: 12 }, (_, i) => `paragraph line ${i + 1}`).join(
      '\n'
    )
    const events = [
      makeEvent({
        id: 1,
        event_type: 'PostToolUse',
        tool_name: 'Bash',
        tool_summary: multiLineSummary,
      }),
    ]
    const fake = new FakeDetailClient(() => makeDetail(row, events))
    const stdout = new TtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    unmount()
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const screen =
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''

    // 末尾（より新しい）8行だけが残り、BOX がちょうど埋まる。先頭4行（プレフィックス込みの
    // 1行目〜4行目）は間引かれて表示されない。
    // "line 1" は "line 10/11/12" の前方一致になるため、直後が数字でないことを正規表現で確認する。
    expect(screen).toContain('paragraph line 5')
    expect(screen).toContain('paragraph line 12')
    expect(screen).not.toMatch(/paragraph line 1\D/)
    expect(screen).not.toContain('paragraph line 4')
    expect(screen).toContain('1-1 of 1')
  })

  it('review-changes 修正（重大な見落とし）: 1行目が表示幅を超える長さでも、2行目以降の埋め込み改行が消えずに表示される', async () => {
    // 実機で確認した再現ケース: `tool_summary` の1行目が表示幅を超える長いコマンド文字列
    // （例: 長いファイルパスを含む codex exec）で、2行目以降に有用な埋め込み改行テキスト
    // （OGPプレビュー本文等）が続く場合、Ink の wrap="truncate-end" は1つの <Text> に結合された
    // 複数のハード改行区間のうち「1区間目が表示幅を超えた」時点で以降の区間ごと描画を打ち切って
    // しまい、2行目以降が完全に不可視になっていた（countHardLines の見積もりとも矛盾し、
    // BOX に余白が残る形で表示件数が過小に絞られる副作用もあった）。
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 90
      rows: number | undefined = 25
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    // 1行目は90桁の BOX 幅を優に超える長さ（表示幅を超えることが再現の条件）。
    const longFirstLine =
      'codex exec "$(cat skills/social-media/oss-lab-post-review-board/references/2026-06-20-codex-opening-lens.md)'
    const multiLineSummary = [
      longFirstLine,
      '--- SECOND LINE ---',
      '--- THIRD LINE ---',
      '--- FOURTH LINE ---',
    ].join('\n')
    const events = [
      makeEvent({
        id: 1,
        event_type: 'PreToolUse',
        tool_name: 'Bash',
        tool_summary: multiLineSummary,
      }),
    ]
    const fake = new FakeDetailClient(() => makeDetail(row, events))
    const stdout = new TtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    unmount()
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const screen =
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''

    // 1行目が長くて表示幅を超えて切り詰められても、2〜4行目は独立した行として表示される。
    expect(screen).toContain('codex exec')
    expect(screen).toContain('SECOND LINE')
    expect(screen).toContain('THIRD LINE')
    expect(screen).toContain('FOURTH LINE')
    // 1行目のプレフィックス（timestamp・event_type・tool_name）が二重に表示されない
    // （結合済みテキストの1区間目をそのまま描画すると、フィールド別描画と重複していた）。
    const prefixOccurrences = (screen.match(/PreToolUse/g) ?? []).length
    expect(prefixOccurrences).toBe(1)
  })

  it('review-changes 修正（重大な見落とし）: 連続改行の間の空行が高さを潰さず独立した1行として表示される', async () => {
    // 実機で確認した再現ケース: 空行（連続する埋め込み改行の間の空区間）を空文字列のまま
    // 独立した <Text> として描画すると、Ink はその要素の高さを 0 に潰す。
    // countHardLines/estimateWrappedLineCount の見積もり（空行も1行として数える）と
    // 実描画がズレて、BOX の下端に1行分の余白が残る形で表示件数が過小に絞られていた。
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 90
      rows: number | undefined = 25
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    const multiLineSummary = ['LINE1', 'LINE2', '', 'LINE4', 'LINE5'].join('\n')
    const events = [
      makeEvent({
        id: 1,
        event_type: 'PreToolUse',
        tool_name: 'Bash',
        tool_summary: multiLineSummary,
      }),
    ]
    const fake = new FakeDetailClient(() => makeDetail(row, events))
    const stdout = new TtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    unmount()
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const screen =
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''
    const lines = screen.split('\n')
    const line2Index = lines.findIndex((l) => l.includes('LINE2'))
    const line4Index = lines.findIndex((l) => l.includes('LINE4'))

    expect(line2Index).toBeGreaterThan(-1)
    expect(line4Index).toBeGreaterThan(-1)
    // LINE2 と LINE4 の間に空行が1行分挟まるはず（高さが潰れていれば差は1になる）。
    expect(line4Index - line2Index).toBe(2)
  })
})

describe('DetailView — イベント履歴BOXの高さ固定（review-changes 修正）', () => {
  /** TtyStdout/TtyStdin/NullStderr の組を作り、指定イベント列で DetailView を実TTY相当に描画する。 */
  async function renderTtyAndGetScreen(events: RecentEventDto[], rows: number): Promise<string> {
    class TtyStdout extends EventEmitter {
      columns: number | undefined = 90
      rows: number | undefined = rows
      isTTY: boolean | undefined = true
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class TtyStdin extends EventEmitter {
      isTTY = true
      setEncoding(): void {}
      setRawMode(): void {}
      resume(): void {}
      pause(): void {}
      ref(): void {}
      unref(): void {}
      read(): null {
        return null
      }
    }
    class NullStderr extends EventEmitter {
      write(): void {}
    }

    const row = makeRow()
    const fake = new FakeDetailClient(() => makeDetail(row, events))
    const stdout = new TtyStdout()
    const { unmount } = inkRender(
      <DetailView client={asClient(fake)} row={row} pollIntervalMs={30} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: new NullStderr() as unknown as NodeJS.WriteStream,
        stdin: new TtyStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    unmount()
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    return (
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭')) ?? ''
    )
  }

  it('実際に表示される件数・行数が visible に満たない場合でも、イベント履歴BOXの高さ（罫線の行位置）は変わらない', async () => {
    // rows=25 → visible=8（DETAIL_RESERVED_ROWS=17）。
    // ケースA: 8件の1行イベント → ちょうど visible いっぱいに埋まる。
    // ケースB: 3件の1行イベントのみ → 表示行数は3行だが、BOX自体の高さは A と同じでなければならない
    // （hardLineAwareWindowForTexts が「収まる件数」を選ぶため、実際の合計行数は visible 未満になりうる）。
    const screenA = await renderTtyAndGetScreen(makeManyEvents(8), 25)
    const screenB = await renderTtyAndGetScreen(makeManyEvents(3), 25)

    // 概要BOXの下辺（╰...╯、範囲ラベルを含まない）も同じ正規表現にマッチするため、
    // イベント履歴BOX固有の範囲ラベル（"X of Y"）を含む行に絞って特定する。
    const bottomBorderLineIndex = (screen: string): number =>
      screen.split('\n').findIndex((line) => /^╰.*\d+-?\d* of \d+.*╯$/.test(line))
    // 既定ロケール（en）の訳語 "Event History" で上辺罫線の行を特定する。
    const topBorderLineIndex = (screen: string): number =>
      screen.split('\n').findIndex((line) => line.startsWith('╭─ Event History'))

    const indexA = bottomBorderLineIndex(screenA) - topBorderLineIndex(screenA)
    const indexB = bottomBorderLineIndex(screenB) - topBorderLineIndex(screenB)
    expect(indexA).toBeGreaterThan(0)
    // 実際の表示行数（3行 vs 8行）が異なっても、BOXの高さ（上辺から下辺までの行数）は同じ。
    expect(indexB).toBe(indexA)
  })
})

describe('DetailView — hub取得上限（total頭打ち）到達後もtail-followが機能し続ける（review-changes 修正）', () => {
  /** hub 契約（新しい順、id が大きいほど新しい）で、idOffset を先頭にスライドさせた固定件数の窓を作る。 */
  function makeSlidingWindow(idOffset: number, count: number): RecentEventDto[] {
    const out: RecentEventDto[] = []
    for (let i = 0; i < count; i += 1) {
      const id = idOffset + count - i
      out.push(
        makeEvent({ id, event_type: 'PostToolUse', tool_name: 'Bash', tool_summary: `cmd-${id}` })
      )
    }
    return out
  }

  it('件数が取得上限で頭打ちのまま新着が積み重なっても、最新イベントに追従し続ける', async () => {
    // 実機で確認した再現ケース: hub の RECENT_EVENTS_LIMIT により recent_events は常に
    // ちょうど count 件（例: 100）が返るが、内容（どの id の窓か）は新着に応じてスライドする。
    // 以前の実装は「total か visible が変化したら再ピン留めする」useEffect に依存しており、
    // total が一定のまま推移するこの状況では再ピン留めの契機自体が失われ、tail-follow が
    // 途中の位置に固定されたまま新着に追従しなくなっていた。
    const row = makeRow()
    const count = 20
    let idOffset = 0
    const fake = new FakeDetailClient(() => makeDetail(row, makeSlidingWindow(idOffset, count)))
    const { lastFrame } = renderDetail(fake, row, 20)

    // 初回: 最下部（最新 = cmd-20）が見える。
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain(`of ${count}`)
      expect(frame).toContain('cmd-20')
    })

    // total は変わらず（常に20件）、窓だけを繰り返しスライドさせる（新着が積み重なる状況を再現）。
    for (let step = 1; step <= 6; step += 1) {
      idOffset = step * 10
      const newestId = idOffset + count
      fake.setResponder(() => makeDetail(row, makeSlidingWindow(idOffset, count)))
      await vi.waitFor(
        () => {
          const frame = lastFrame() ?? ''
          expect(frame).toContain(`cmd-${newestId}`)
        },
        { timeout: 2000 }
      )
    }
  })
})

describe('DetailView — device.name の ANSI エスケープ除染（release-10-dashboard-polish レビュー修正: CWE-150）', () => {
  it('device.name に含まれる制御シーケンスを除染して描画する', async () => {
    const ESC = String.fromCharCode(27)
    const row = { ...makeRow(), device: { id: 'macmini', name: `Mac mini${ESC}[2J` } }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('Mac mini')
      // ESC 自体は Ink の正当な SGR カラーコードにも出現するため、注入した画面消去
      // シーケンスのみが除去されていることを確認する。
      expect(frame).not.toContain(`${ESC}[2J`)
    })
  })
})

describe('DetailView — project.name の ANSI エスケープ除染（release-21-known-issues-cleanup FR-02: CWE-150）', () => {
  it('project.name に含まれる制御シーケンスを除染して描画する', async () => {
    const ESC = String.fromCharCode(27)
    const row = {
      ...makeRow(),
      project: { id: 'proj-1', name: `ProjectLens${ESC}]0;PWNED${String.fromCharCode(7)}` },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('ProjectLens')
      expect(frame).not.toContain('PWNED')
    })
  })
})

describe('DetailView — 概要 BOX の running フィールド（release-16-running-work-display FR-03 AC-2/AC-3/AC-4）', () => {
  /**
   * running フィールドの行だけを取り出し、ANSI エスケープ（dimColor 等）と罫線（│）・
   * paddingX の空白を取り除いた「ラベル+値」部分だけに整形する（他フィールドの "-"／
   * 同名文字列と混同しないための専用抽出）。
   */
  function findRunningLine(frame: string): string {
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const line =
      frame
        .replace(ansi, '')
        .split('\n')
        .find((l) => l.includes('Running') || l.includes('実行中')) ?? ''
    return line.replace(/^│\s*/, '').replace(/\s*│$/, '')
  }

  it.each<['workflow' | 'agent' | 'skill', string]>([
    ['workflow', 'workflow'],
    ['agent', 'agent'],
    ['skill', 'skill'],
  ])('AC-3: running_work.kind=%s → running フィールドに "<name> (%s)" 形式で表示される', async (kind, kindLabel) => {
    const row: InstanceStatusRow = {
      ...makeRow(),
      running_work: { kind, name: 'run-release', started_at: null },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      expect(findRunningLine(lastFrame() ?? '')).toBe(`Running     run-release (${kindLabel})`)
    })
  })

  it('AC-2: running_work が null → running フィールドは "-" 表示になる（行数は変わらない）', async () => {
    const row = makeRow() // makeRow() の running_work は null
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      // Overview BOX の他フィールドと同様に描画され、running だけ "-" になる。
      expect(frame).toContain('ProjectLens')
      expect(findRunningLine(frame)).toBe('Running     -')
    })
  })

  it('AC-4: running_work.name に含まれる制御シーケンスを除染して描画する（CWE-150）', async () => {
    const ESC = String.fromCharCode(27)
    const row: InstanceStatusRow = {
      ...makeRow(),
      running_work: { kind: 'agent', name: `deploy${ESC}[2J`, started_at: null },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('deploy (agent)')
      expect(frame).not.toContain(`${ESC}[2J`)
    })
  })

  it('locale: ja では running ラベル・kind が日本語で描画される（release-9-i18n FR-02 と同じ i18n 経路）', async () => {
    setActiveLocale('ja')
    const row: InstanceStatusRow = {
      ...makeRow(),
      running_work: { kind: 'workflow', name: 'run-release', started_at: null },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      expect(findRunningLine(lastFrame() ?? '')).toBe('実行中         run-release (ワークフロー)')
    })
  })

  it('ポーリングで running_work が更新される（次ターンで null に戻る、AC-5 相当）', async () => {
    const row: InstanceStatusRow = {
      ...makeRow(),
      running_work: { kind: 'workflow', name: 'run-release', started_at: null },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row, 20)

    await vi.waitFor(() => {
      expect(findRunningLine(lastFrame() ?? '')).toBe('Running     run-release (workflow)')
    })

    // Stop 後は hub が running_work を null にする（FR-02 の関心事）。detail 側は
    // ポーリング更新に追随して表示を "-" に戻すだけでよい（source = detail ?? row）。
    fake.setResponder(() => makeDetail({ ...row, running_work: null }, []))
    await vi.waitFor(() => {
      expect(findRunningLine(lastFrame() ?? '')).toBe('Running     -')
    })
  })

  it('FR-06 AC-1: 未知の kind（ANSI エスケープを含む）がサニタイズされて描画される（CWE-150）', async () => {
    const ESC = String.fromCharCode(27)
    const row: InstanceStatusRow = {
      ...makeRow(),
      running_work: { kind: `unknown${ESC}[2J`, name: 'some-work', started_at: null },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      // kind の未知値（エスケープシーケンス含む）がサニタイズされて "unknown" だけが表示される。
      expect(frame).toContain('some-work (unknown)')
      // インジェクションされたシーケンス自体は削除されている。
      expect(frame).not.toContain(`${ESC}[2J`)
    })
  })
})

describe('DetailView — running フィールドの経過時間表示（release-18 FR-05 AC-1）', () => {
  /**
   * running フィールドの行だけを取り出し、ANSI エスケープ（dimColor 等）と罫線（│）・
   * paddingX の空白を取り除いた「ラベル+値」部分だけに整形する（他フィールドの "-"／
   * 同名文字列と混同しないための専用抽出）。
   */
  function findRunningLine(frame: string): string {
    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    const line =
      frame
        .replace(ansi, '')
        .split('\n')
        .find((l) => l.includes('Running') || l.includes('実行中')) ?? ''
    return line.replace(/^│\s*/, '').replace(/\s*│$/, '')
  }

  it('running_work.started_at があるとき "<name> (<kind>) <経過時間>" 形式で表示される', async () => {
    // 12分5秒前（60秒バケットの境界から離した安全マージン）。
    const startedAt = new Date(Date.now() - (12 * 60 + 5) * 1000).toISOString()
    const row: InstanceStatusRow = {
      ...makeRow(),
      running_work: { kind: 'workflow', name: 'run-release', started_at: startedAt },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      expect(findRunningLine(lastFrame() ?? '')).toBe('Running     run-release (workflow) 12m')
    })
  })

  it('running_work.started_at が null（旧 hub との混在）のときは経過時間を省き従来表示にフォールバックする', async () => {
    const row: InstanceStatusRow = {
      ...makeRow(),
      running_work: { kind: 'workflow', name: 'run-release', started_at: null },
    }
    const fake = new FakeDetailClient(() => makeDetail(row, []))
    const { lastFrame } = renderDetail(fake, row)

    await vi.waitFor(() => {
      expect(findRunningLine(lastFrame() ?? '')).toBe('Running     run-release (workflow)')
    })
  })
})
