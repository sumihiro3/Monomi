import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstanceDetail, InstanceStatusRow, TerminalDto } from '../../hub/dto.js'
import { setActiveLocale, t, type TranslationKey } from '../../i18n/index.js'
import { MONOMI_VERSION } from '../../index.js'
import { ClientRollup } from '../client-rollup.js'
import type { FocusResult } from '../focus/types.js'
import type { HubApiClient } from '../hub-api-client.js'
import { InstanceListStore } from '../instance-list-store.js'
import { DEFAULT_BACKPRESSURE_THRESHOLD_BYTES } from '../memory-watchdog.js'
import { PollingLoop } from '../polling-loop.js'
import { AppView, type FocusRunner } from './app-view.js'

/** テスト用 instance 行を作る（表示に効く最小フィールドのみ指定）。 */
function makeRow(over: {
  id: string
  projectName: string
  display: string
  priority: number
  branch?: string | null
  /** release-23-terminal-focus FR-05c: device_id 照合テスト用（省略時 'macmini'）。 */
  deviceId?: string
  /** release-23-terminal-focus FR-05c: terminal 情報の有無/内容を差し替える（省略時 null）。 */
  terminal?: TerminalDto | null
}): InstanceStatusRow {
  return {
    instance_id: over.id,
    project: { id: `proj-${over.id}`, name: over.projectName },
    device: { id: over.deviceId ?? 'macmini', name: 'Mac mini' },
    path: `/Users/sumihiro/dev/${over.projectName}`,
    branch: over.branch ?? 'main',
    status: {
      display: over.display,
      raw_state: over.display === 'stale' ? 'active' : over.display,
      elapsed_seconds: 720,
      is_stale: over.display === 'stale',
      priority: over.priority,
    },
    pr: { state: 'none', number: null, url: null, is_draft: false },
    session: {
      id: `sess-${over.id}`,
      last_heartbeat_at: null,
      terminal: over.terminal ?? null,
    },
    running_work: null,
  }
}

/** 検証を通る最小の {@link TerminalDto}（release-23-terminal-focus FR-05c）。 */
function validTerminal(over: Partial<TerminalDto> = {}): TerminalDto {
  return {
    tty: '/dev/ttys003',
    term_program: null,
    tmux_pane: null,
    tmux_socket: null,
    wsl_distro: null,
    wt_session: null,
    ...over,
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
  /** 設定すると次回以降の listInstances() がこのエラーで reject する（app.errorPrefix 検証用）。 */
  listError: Error | null = null
  /**
   * `getLastHubVersion()` が返す値（release-25-auto-update FR-04）。実 `HubApiClient` の
   * 「直近の GET 応答ヘッダから読み取った版」を模す。`undefined` はヘッダ欠落（版不明）を表す。
   */
  hubVersion: string | undefined = undefined

  constructor(instances: InstanceStatusRow[]) {
    this.instances = instances
  }

  listInstances(): Promise<InstanceStatusRow[]> {
    this.listCalls += 1
    return this.listError !== null
      ? Promise.reject(this.listError)
      : Promise.resolve(this.instances)
  }

  getInstanceDetail(id: string): Promise<InstanceDetail> {
    const detail = this.details.get(id)
    return detail === undefined
      ? Promise.reject(new Error(`no detail fixture for ${id}`))
      : Promise.resolve(detail)
  }

  getLastHubVersion(): string | undefined {
    return this.hubVersion
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

/**
 * `localDeviceId`/`focusRunner` を注入して描画する（release-23-terminal-focus FR-05c）。
 *
 * 既定では選択行（`makeRow` の既定 device.id 'macmini'）と一致する `localDeviceId: 'macmini'`
 * を注入する（otherDevice 縮退を狙うテストは明示的に別値を渡す）。
 */
function renderAppFocus(
  fake: FakeHubApiClient,
  options: {
    localDeviceId?: string
    focusRunner?: FocusRunner
    pollIntervalMs?: number
  } = {}
): ReturnType<typeof render> {
  active = render(
    <AppView
      client={asClient(fake)}
      pollIntervalMs={options.pollIntervalMs ?? 40}
      localDeviceId={options.localDeviceId ?? 'macmini'}
      focusRunner={options.focusRunner ?? (() => Promise.resolve('ok' satisfies FocusResult))}
    />
  )
  return active
}

/**
 * `startupNotices`（永続 notice 領域、release-25-auto-update）を注入して描画する。
 * `focusRunner` も併せて差し替えられるようにし、時限式 notice との独立性を検証するテストで使う。
 */
function renderAppNotices(
  fake: FakeHubApiClient,
  options: {
    startupNotices?: string[]
    focusRunner?: FocusRunner
    localDeviceId?: string
    pollIntervalMs?: number
  } = {}
): ReturnType<typeof render> {
  active = render(
    <AppView
      client={asClient(fake)}
      pollIntervalMs={options.pollIntervalMs ?? 40}
      localDeviceId={options.localDeviceId ?? 'macmini'}
      focusRunner={options.focusRunner ?? (() => Promise.resolve('ok' satisfies FocusResult))}
      startupNotices={options.startupNotices ?? []}
    />
  )
  return active
}

/**
 * `t(key)` の先頭文（最初の `.` まで）だけを取り出す（release-23-terminal-focus FR-05c）。
 *
 * `focus.notFound`/`focus.failed` は Ghostty 向けの案内を続けて含む長文で、ink-testing-library
 * の既定 100 列では折り返されるため `lastFrame()` 中の連続部分文字列として全文一致は取れない
 * （`renderAppWide` を使う既存テストと同じ理由）。notice の判別には先頭文だけで十分なので、
 * 折り返しの影響を受けない短い部分文字列で比較する。
 */
function firstSentence(key: TranslationKey): string {
  const full = t(key)
  const period = full.indexOf('.')
  return period === -1 ? full : full.slice(0, period + 1)
}

/**
 * ink-testing-library の `render` は端末幅を 100 列に固定するため、英語ロケールの長いラベル
 * （例 "Awaiting next instruction"）を含むフィルタバーが折り返されアサーションが不安定になる。
 * フィルタバーの文言・件数だけを検証するテスト専用に、ink-testing-library 自身の Stdout 実装
 * （`debug: true` で毎レンダー即時に `write` される。非 debug だと非interactive判定になり
 * unmount 時までフラッシュされない）を踏襲しつつ `columns` だけ広げて描画するヘルパー。
 */
function renderAppWide(
  fake: FakeHubApiClient,
  pollIntervalMs = 40
): {
  lastFrame: () => string
  unmount: () => void
  frames: string[]
  setWritableLength: (value: number) => void
} {
  class WideStdout extends EventEmitter {
    columns = 200
    frames: string[] = []
    // release-20-dashboard-heap-guard FR-02 AC-2/AC-5: バックプレッシャー判定
    // （`isStdoutBackpressured`）が読む `writableLength` をテストから差し替えられるようにする。
    // 既定 0（非バックプレッシャー）は既存テストの挙動を変えない。
    writableLength = 0
    write(frame: string): void {
      this.frames.push(frame)
    }
  }
  class WideStdin extends EventEmitter {
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
  class WideStderr extends EventEmitter {
    write(): void {}
  }

  const stdout = new WideStdout()
  const { unmount } = inkRender(
    <AppView client={asClient(fake)} pollIntervalMs={pollIntervalMs} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: new WideStderr() as unknown as NodeJS.WriteStream,
      stdin: new WideStdin() as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    }
  )
  return {
    lastFrame: () => stdout.frames[stdout.frames.length - 1] ?? '',
    unmount,
    frames: stdout.frames,
    setWritableLength: (value: number) => {
      stdout.writableLength = value
    },
  }
}

afterEach(() => {
  active?.unmount()
  active = null
  setActiveLocale('en')
})

describe('AppView — closed 既定非表示とキー6フィルタ（FR-01 AC-1・AC-3・AC-7）', () => {
  it('AC-1: フィルタ未設定時、closed 行は自動的に隠される（既定非表示）', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'closed', priority: 0 }),
    ])
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).not.toContain('Monban')
    })
  })

  it('AC-4: 既定ロケール（en）でフィルタバーに6番目の項目として [6]Closed が closed 件数付きで自動表示される（FILTER_ORDER 駆動、release-9-i18n FR-01 AC-2）', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'closed', priority: 0 }),
      makeRow({ id: '3', projectName: 'Sunset', display: 'closed', priority: 0 }),
    ])
    // 英語ラベルは 100 列だと折り返すため、専用の広い端末幅ヘルパーで描画する。
    const { lastFrame, unmount } = renderAppWide(fake)

    try {
      await vi.waitFor(() => {
        expect(lastFrame()).toContain('ProjectLens')
        // closed 行は既定非表示だが、フィルタバーの件数は store.instances（全件）から
        // 集計するため、非表示中でも [6]Closed の件数には 2 件がそのまま表示される。
        expect(lastFrame()).toContain('[6]Closed 2')
      })
    } finally {
      unmount()
    }
  })

  it('AC-4: locale: ja でフィルタバーの [6]終了 が日本語で表示される（release-9-i18n FR-02 AC-2・AC-5）', async () => {
    setActiveLocale('ja')
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'closed', priority: 0 }),
      makeRow({ id: '3', projectName: 'Sunset', display: 'closed', priority: 0 }),
    ])
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('[6]終了 2')
    })
  })

  it('AC-3: キー6で closed フィルタをトグルし、closed 行を表示／非表示に切り替える', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'closed', priority: 0 }),
    ])
    const { lastFrame, stdin } = renderApp(fake)

    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    // 初期状態: closed は隠れている
    expect(lastFrame()).not.toContain('Monban')

    // キー6でclosedフィルタを有効に
    stdin.write('6')
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Monban')
    })

    // キー6で再度トグルすると非表示に戻す
    stdin.write('6')
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('Monban')
    })
  })

  it('AC-7: active フィルタと closed フィルタを複数選択で併用できる', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
      makeRow({ id: '3', projectName: 'Archived', display: 'closed', priority: 0 }),
    ])
    const { lastFrame, stdin } = renderApp(fake)

    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    // キー1でactiveフィルタを有効
    stdin.write('1')
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).not.toContain('Monban')
      expect(lastFrame()).not.toContain('Archived')
    })

    // キー6でclosedフィルタも追加（複数選択）
    stdin.write('6')
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).not.toContain('Monban')
      expect(lastFrame()).toContain('Archived')
    })
  })
})

describe('AppView — 一覧・フィルタ・watch・詳細（FR-05 AC-1〜AC-4）', () => {
  it('AC-1: 既定ロケール（en）で起動すると全 instance が英語の状態ラベル付きで一覧表示される（release-9-i18n FR-01 AC-2）', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ])
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('Monban')
    })
    // 導出済みの状態ラベル（既定ロケール en）が付いている。
    expect(lastFrame()).toContain('Active')
    expect(lastFrame()).toContain('Awaiting approval')
    // ヘッダのプロジェクト/デバイス数。
    expect(lastFrame()).toContain('2 projects · 1 devices')
  })

  it('AC-1: locale: ja で起動すると状態ラベルが日本語で付く（release-9-i18n FR-02 AC-2・AC-5）', async () => {
    setActiveLocale('ja')
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ])
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('Monban')
    })
    expect(lastFrame()).toContain('稼働中')
    expect(lastFrame()).toContain('権限待ち')
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
    // 表示文言は i18n 化・大文字化された WATCHING（release-10-dashboard-polish FR-02/FR-03）。
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('WATCHING')
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
      // 既定ロケール（en, release-9-i18n FR-01 AC-2）では DetailView のタイトルは英語訳語になる。
      expect(frame).toContain('Event History')
      expect(frame).toContain('PostToolUse')
      expect(frame).toContain('Bash')
      expect(frame).toContain('npm install')
    })
    // 詳細ヘッダにブランチが出て、概要 BOX の上辺罫線にタイトルが埋め込まれる（FR-06）。
    expect(lastFrame()).toContain('feature/ai-sidecar')
    expect(lastFrame()).toContain('Overview')
  })
})

describe('AppView — ヘッダータイトルの Monomi バッジ化（release-10-dashboard-polish FR-01 AC-1・AC-4）', () => {
  it('AC-4: ヘッダー行に Monomi が含まれ、旧文言 Claude Code Status は含まれない', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    expect(lastFrame()).toContain('Monomi')
    expect(lastFrame()).not.toContain('Claude Code Status')
    // AC-3: 同一行で projects/devices・watching インジケータが崩れず連結される。
    expect(lastFrame()).toContain('1 projects · 1 devices')
  })
})

describe('AppView — ヘッダーへのバージョン常時表示（release-11-version-automation FR-03 AC-1〜AC-3）', () => {
  it('AC-1・AC-3: ヘッダー行に Monomi バッジ直後の v{MONOMI_VERSION} が含まれる', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    const frame = lastFrame() ?? ''
    // 期待値はハードコードでなく MONOMI_VERSION 自身を参照する（bump 時のテスト手動更新を避ける、FR-01 AC-4 と同じ方針）。
    // v{MONOMI_VERSION} は Monomi バッジと同一 <Text> ではないため、素の文字列比較では両者の間に
    // Ink が挿む ANSI リセットコードが挟まり `toContain('Monomi v0.0.1')` は一致しない
    // （AC-1 のバッジ「直後」は視覚上の位置関係であり、生の ANSI 混在文字列の連続性ではない）。
    // そのため各断片の有無と出現順序（indexOf）で位置関係を検証する。
    expect(frame).toContain(`v${MONOMI_VERSION}`)
    const monomiIndex = frame.indexOf('Monomi')
    const versionIndex = frame.indexOf(`v${MONOMI_VERSION}`)
    const countsIndex = frame.indexOf('1 projects · 1 devices')
    expect(monomiIndex).toBeGreaterThanOrEqual(0)
    // AC-1: バージョンは Monomi バッジの直後（間に他の可視テキストを挟まない）。
    expect(versionIndex).toBeGreaterThan(monomiIndex)
    // AC-2: 既存の projects/devices 表示との位置関係を維持する（バージョンが手前）。
    expect(countsIndex).toBeGreaterThan(versionIndex)
  })
})

describe('AppView — watching インジケータの点滅が AppView 本体を再レンダーしない（release-10-dashboard-polish FR-02 AC-2）', () => {
  it('AC-2: WatchingIndicator が複数 tick にわたり点滅する間、親専用の集計（store.projectRows）は再計算されない', async () => {
    // FR-02 AC-2 の「点滅が AppView 本体の再レンダーを誘発しない」という性質は、点滅用の
    // setInterval/visible state を WatchingIndicator（子）に閉じ込めたことで構造的に保証される
    // （React は子コンポーネントの setState だけでは親を再レンダーしない）。このテストはその構造を
    // 作る「機構」ではなく、実際に親側の再計算回数が増えないことを実測で裏づける「証明」に過ぎない。
    //
    // 交絡回避: 既定のポーリング間隔（数十 ms）のまま待つと、ポーリングによる再取得 bump が
    // 1000ms 周期の点滅シグナルを埋もれさせてしまう（親の再レンダー要因が2つ混ざる）。
    // pollIntervalMs を十分長く取り、観測ウィンドウ内では初回マウント時の 1 回しかポーリングが
    // 走らないようにすることで、点滅由来の再レンダーの有無だけを切り分けて検証する。
    const projectRowsSpy = vi.spyOn(InstanceListStore.prototype, 'projectRows')
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame } = renderApp(fake, 100_000)

    // 初回マウント（即時 refresh 1 回）が完了し、watch 表示（"● WATCHING"）が出るまで待つ。
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('WATCHING')
    })

    // ここまでの呼び出し回数を基準値として固定する（初回マウント分の再計算を含む）。
    const baseline = projectRowsSpy.mock.calls.length
    expect(baseline).toBeGreaterThan(0)

    // 点滅は 1000ms 周期のトグル。非表示→表示と 2 tick 分待ち、複数回のトグルを跨がせる。
    await vi.waitFor(() => expect(lastFrame()).not.toContain('WATCHING'), { timeout: 3000 })
    await vi.waitFor(() => expect(lastFrame()).toContain('WATCHING'), { timeout: 3000 })

    // 点滅の tick を複数回跨いでも、親専用計算（store.projectRows）の呼び出し回数は増えない
    // （= AppView 本体は再レンダーされていない）。
    expect(projectRowsSpy.mock.calls.length).toBe(baseline)

    projectRowsSpy.mockRestore()
  })
})

describe('AppView — filteredRows/projectRows の単一計算化（release-20-dashboard-heap-guard FR-03 AC-1・AC-2）', () => {
  it('store データに影響しないキー操作（ヘルプ開閉）をまたいでも filtered/projectRows（rollupByProject 経由）は再計算されず、実際にフィルタが変わるキー操作では再計算される', async () => {
    // filteredRows・projectRows/deviceCount が useMemo 化された結果、store.instances /
    // store.activeFilters の参照が変わらない限り InstanceListStore#filtered・#projectRows
    // （内部で ClientRollup#rollupByProject を呼ぶ）は再実行されないはず（AC-1・AC-2）。
    const filteredSpy = vi.spyOn(InstanceListStore.prototype, 'filtered')
    const projectRowsSpy = vi.spyOn(InstanceListStore.prototype, 'projectRows')
    const rollupSpy = vi.spyOn(ClientRollup.prototype, 'rollupByProject')

    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ])
    // pollIntervalMs を十分長く取り、観測ウィンドウ内でポーリングによる再取得（データ由来の
    // bump）が紛れ込まないようにする（「点滅」テストと同じ理由）。
    const { lastFrame, stdin } = renderApp(fake, 100_000)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('Monban')
    })

    // 初回マウント（＋初回データ到着による1回の再計算）を基準値として固定する。
    const baselineFiltered = filteredSpy.mock.calls.length
    const baselineProjectRows = projectRowsSpy.mock.calls.length
    const baselineRollup = rollupSpy.mock.calls.length
    expect(baselineFiltered).toBeGreaterThan(0)
    expect(baselineProjectRows).toBeGreaterThan(0)
    expect(baselineRollup).toBeGreaterThan(0)

    // '?' はヘルプの開閉のみを行い、store のフィルタ・instances は一切変更しない。
    // '?' はハンドル済みキー（toggleHelp）なので handleKey が true を返し useInput は bump() を
    // 呼ぶ（FR-03 AC-3）ため AppView 自体の再レンダーは実際に発生するが、filteredRows/projectRows
    // の useMemo 依存（store.instances/store.activeFilters）は参照が変わらないため再計算は起きないはず。
    stdin.write('?')
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Key Bindings')
    })

    expect(filteredSpy.mock.calls.length).toBe(baselineFiltered)
    expect(projectRowsSpy.mock.calls.length).toBe(baselineProjectRows)
    expect(rollupSpy.mock.calls.length).toBe(baselineRollup)

    // 対照実験: 実際に store.activeFilters が変わるキー操作（'1'）では再計算が発生することを
    // 確認し、このテストが「常に再計算されない」壊れた検証になっていないことを保証する。
    stdin.write('1')
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('Monban')
    })
    expect(filteredSpy.mock.calls.length).toBeGreaterThan(baselineFiltered)
    expect(projectRowsSpy.mock.calls.length).toBeGreaterThan(baselineProjectRows)
    expect(rollupSpy.mock.calls.length).toBeGreaterThan(baselineRollup)

    filteredSpy.mockRestore()
    projectRowsSpy.mockRestore()
    rollupSpy.mockRestore()
  })
})

describe('AppView — 無効キー入力は再描画（bump）を誘発しない（release-20-dashboard-heap-guard FR-03 AC-3）', () => {
  it('未割当キーでは AppView が再レンダーされず、割当済みキーでは従来どおり再レンダー・表示反映される', async () => {
    // AppView が実際に再レンダーされたかどうかは、JSX 中で毎レンダー無条件に呼ばれる
    // `polling.isRunning()`（WatchingIndicator へ渡す prop、useMemo でメモ化されない）の
    // 呼び出し回数で観測する。WatchingIndicator 自身の点滅 setState は親を再レンダーしない
    // （release-10-dashboard-polish FR-02 AC-2 のコメント参照）ため、この呼び出し回数は
    // 「AppView 本体が再レンダーされた回数」の代理指標として使える。
    const isRunningSpy = vi.spyOn(PollingLoop.prototype, 'isRunning')

    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ])
    // pollIntervalMs を十分長く取り、観測ウィンドウ内でポーリングによる再取得（データ由来の
    // bump）が紛れ込まないようにする（他の FR-03 テストと同じ理由）。
    const { lastFrame, stdin } = renderApp(fake, 100_000)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('ProjectLens')
      expect(lastFrame()).toContain('Monban')
    })

    const baseline = isRunningSpy.mock.calls.length
    expect(baseline).toBeGreaterThan(0)

    // 'x' はフィルタ（1-6）・j/k・矢印・Enter・esc・?・q のいずれにも該当しない無効キー。
    // handleKey が false を返すため useInput は bump() を呼ばず、AppView は再レンダーされない。
    stdin.write('x')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(isRunningSpy.mock.calls.length).toBe(baseline)

    // 対照実験: 割当済みキー（'1' フィルタトグル）は store を直接ミューテートするだけで
    // React state を持たないため、handleKey が true を返し bump() が呼ばれて初めて再描画される。
    // 従来どおり表示に反映されることも合わせて確認する。
    stdin.write('1')
    await vi.waitFor(() => {
      expect(lastFrame()).not.toContain('Monban')
    })
    expect(isRunningSpy.mock.calls.length).toBeGreaterThan(baseline)

    isRunningSpy.mockRestore()
  })
})

describe('AppView — stdout バックプレッシャー時は再描画をスキップする（release-20-dashboard-heap-guard FR-02 AC-2/AC-5）', () => {
  it('バックプレッシャー相当（writableLength >= 閾値）の間、ポーリング更新が来ても再描画（bump）が発生しない', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    // pollIntervalMs を短く（20ms）し、観測ウィンドウ内で確実に複数回ポーリングさせる。
    const { lastFrame, frames, setWritableLength, unmount } = renderAppWide(fake, 20)

    try {
      // 初回マウント（非バックプレッシャー）で一覧が表示されるまで待つ。
      await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

      // バックプレッシャー状態へ切り替え、次のポーリングでサーバ側データが増えたことにする。
      setWritableLength(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES)
      fake.instances = [
        ...fake.instances,
        makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
      ]

      // 切替直後は「非バックプレッシャー最後の tick」由来の保留中コミットがまだ flush されて
      // いないことがある（React のタイマー駆動 setState は MessageChannel 経由で非同期にコミット
      // される、`watching-indicator.test.tsx` と同じ理由）。この遷移的な揺れが収まるだけの猶予を
      // 空けてから baseline を取ることで、以降は「定常状態（バックプレッシャー継続中）でも
      // 再描画回数が増えない」ことだけを比較できるようにする。
      await new Promise((resolve) => setTimeout(resolve, 100))
      const projectRowsSpy = vi.spyOn(InstanceListStore.prototype, 'projectRows')
      const baselineCalls = projectRowsSpy.mock.calls.length
      const baselineFrameCount = frames.length
      const listCallsAtBaseline = fake.listCalls

      // さらに複数回のポーリング tick を跨がせる。
      await new Promise((resolve) => setTimeout(resolve, 120))

      // ポーリング自体（listInstances 呼び出し = データ更新）は継続しているが、bump が
      // スキップされているため再描画（projectRows の再計算・stdout.write）は増えない。
      expect(fake.listCalls).toBeGreaterThan(listCallsAtBaseline)
      expect(lastFrame()).not.toContain('Monban')
      expect(frames.length).toBe(baselineFrameCount)
      expect(projectRowsSpy.mock.calls.length).toBe(baselineCalls)

      projectRowsSpy.mockRestore()
    } finally {
      unmount()
    }
  })

  it('バックプレッシャーが解消（writableLength < 閾値）すると、次のポーリングで最新状態が描画される', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame, setWritableLength, unmount } = renderAppWide(fake, 20)

    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

      // バックプレッシャー中にデータだけ先に増やしておく（描画には反映されない）。
      setWritableLength(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES)
      fake.instances = [
        ...fake.instances,
        makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
      ]
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(lastFrame()).not.toContain('Monban')

      // ドレインされた（閾値未満に戻った）ら、次のポーリング tick の bump で最新状態が描画される。
      setWritableLength(0)
      await vi.waitFor(() => expect(lastFrame()).toContain('Monban'), { timeout: 2000 })
    } finally {
      unmount()
    }
  })

  it('非バックプレッシャー時（既定 writableLength=0）は従来どおりポーリング更新のたびに再描画される', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame, unmount } = renderAppWide(fake, 20)

    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

      fake.instances = [
        ...fake.instances,
        makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
      ]
      await vi.waitFor(() => expect(lastFrame()).toContain('Monban'), { timeout: 2000 })
    } finally {
      unmount()
    }
  })

  it('取得失敗時（onError 経路）もバックプレッシャー中は同一エラーの繰り返しによる再描画をスキップする', async () => {
    // setError(String(err)) 自体は React state のため、null→文字列という最初の遷移は
    // （bump を経由せずとも）React 自身の差分検知で再描画される。AC-2 が効くのはそこから先、
    // 「同一エラーが tick ごとに来続ける」場面（setError に同一値を渡しても React は
    // Object.is で bail-out するため、bump がスキップされていれば追加の再描画は発生しない）。
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame, frames, setWritableLength, unmount } = renderAppWide(fake, 20)

    try {
      await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

      // 非バックプレッシャー下でまずエラーを発生させ、エラー表示が一度出ることを確認する。
      fake.listError = new Error('network down')
      await vi.waitFor(() => expect(lastFrame()).toContain('Error:'))

      // ここからバックプレッシャーへ切り替える。以後は同一エラーが来続ける。
      setWritableLength(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES)

      // 切替直後の保留中コミットが flush される猶予（他テストと同じ理由）。
      await new Promise((resolve) => setTimeout(resolve, 100))
      const projectRowsSpy = vi.spyOn(InstanceListStore.prototype, 'projectRows')
      const baselineCalls = projectRowsSpy.mock.calls.length
      const baselineFrameCount = frames.length
      const listCallsAtBaseline = fake.listCalls

      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(fake.listCalls).toBeGreaterThan(listCallsAtBaseline)
      expect(frames.length).toBe(baselineFrameCount)
      expect(projectRowsSpy.mock.calls.length).toBe(baselineCalls)

      projectRowsSpy.mockRestore()
    } finally {
      unmount()
    }
  })
})

describe('AppView — 取得失敗時のエラー表示（release-9-i18n FR-02 AC-1, app.errorPrefix）', () => {
  it('既定ロケール（en）で取得失敗時に "Error: " 接頭辞付きでエラーメッセージを表示する', async () => {
    const fake = new FakeHubApiClient([])
    fake.listError = new Error('network down')
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Error: Error: network down')
    })
  })

  it('locale: ja で取得失敗時に "エラー: " 接頭辞付きでエラーメッセージを表示する（release-9-i18n FR-02 AC-2・AC-5）', async () => {
    setActiveLocale('ja')
    const fake = new FakeHubApiClient([])
    fake.listError = new Error('network down')
    const { lastFrame } = renderApp(fake)

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('エラー: Error: network down')
    })
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
    expect(lastFrame()).toContain('1-6 filter')
    expect(lastFrame()).toContain('j/k')
    expect(lastFrame()).not.toContain('w watch')

    stdin.write('\r') // Enter → 詳細
    await vi.waitFor(() => expect(lastFrame()).toContain('Event History'))

    // 詳細表示中: 詳細固有ヒント（j/k scroll・←/→ project・w wrap）へ切り替わる（release-6 FR-03 AC-1）。
    // 一覧向けの 1-6 filter・↵ detail は出ない。j/k は本リリースでイベントスクロールへ再割当てされた
    // ため、フッターにも 'j/k scroll' として現れる（release-4 の「詳細では j/k を出さない」から変更）。
    // w wrap はイベント行の折り返し/切り詰めトグル（release-6 FR-08 / FR-03 AC-1）。
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).not.toContain('1-6 filter')
      expect(frame).not.toContain('↵ detail')
      expect(frame).toContain('j/k scroll')
      expect(frame).toContain('←/→ project')
      expect(frame).toContain('w wrap')
      expect(frame).toContain('esc back')
      expect(frame).toContain('? help')
      expect(frame).toContain('q quit')
    })
  })

  it('詳細表示中もフィルタ（1-6）は無視され、j/k は一覧状態に影響しない（イベントスクロールへ再割当て）', async () => {
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
    await vi.waitFor(() => expect(lastFrame()).toContain('Event History'))

    // release-6: 詳細中の 1（フィルタ）は引き続き controller が無視する（誤ってフィルタが掛からない）。
    // j は release-4 では無視だったが、本リリースで DetailView 自身のイベントスクロールへ再割当てされた。
    // ただしそのスクロールは一覧の selectedIndex/フィルタには一切影響しない無害な副作用に留まる。
    // どちらも視覚的な即時変化が無いので vi.waitFor では待てず、処理時間を空ける。
    stdin.write('1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    stdin.write('j')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lastFrame()).toContain('Event History') // 詳細表示のまま（j は詳細内スクロール、遷移しない）

    stdin.write(String.fromCharCode(27)) // esc で一覧へ戻る
    // 'ProjectLens' は詳細ビューにも出るため判定に使わない。詳細固有の BOX タイトル 'Event History'
    // の不在で「一覧へ戻った」ことを判定する。
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Event History'))

    // フィルタが適用されていれば approval_wait の Monban は消えているはず。1 は無視されたので両方残る。
    expect(lastFrame()).toContain('Monban')
  })
})

describe('AppView — 詳細ビューから隣接プロジェクトへの移動（release-6 FR-04）', () => {
  const ESC = String.fromCharCode(27)
  const RIGHT = `${ESC}[C`
  const LEFT = `${ESC}[D`

  /** 2 instance（ProjectLens→Monban 順）＋両者の詳細を持つ fake を用意する。 */
  function twoProjectFake(): FakeHubApiClient {
    const rowA = makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 })
    const rowB = makeRow({
      id: '2',
      projectName: 'Monban',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([rowA, rowB])
    fake.details.set(rowA.instance_id, makeDetail(rowA))
    fake.details.set(rowB.instance_id, makeDetail(rowB))
    return fake
  }

  it('AC-1/AC-2: ←/→ で一覧の並び順の前後 instance の詳細へ移動し、端で反対側へ循環する', async () => {
    const { lastFrame, stdin } = renderApp(twoProjectFake())
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    // 先頭（index 0 = ProjectLens）の詳細を開く。詳細中は一覧を描かないので概要 BOX の
    // project 名だけで表示中 instance を判定できる（他 project 名は画面に出ない）。
    stdin.write('\r')
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('Event History')
      expect(frame).toContain('ProjectLens')
    })

    // → で次（index 1 = Monban）へ。
    stdin.write(RIGHT)
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('Monban')
      expect(frame).not.toContain('ProjectLens')
    })

    // 末尾でさらに → すると先頭（ProjectLens）へ循環する（wrap）。
    stdin.write(RIGHT)
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('ProjectLens')
      expect(frame).not.toContain('Monban')
    })

    // 先頭で ← すると末尾（Monban）へ循環する（逆方向 wrap）。
    stdin.write(LEFT)
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('Monban')
      expect(frame).not.toContain('ProjectLens')
    })
  })

  it('AC-3: 隣接移動後に esc で戻ると一覧カーソルが移動先 instance に一致する（selectedIndex 一本化）', async () => {
    const { lastFrame, stdin } = renderApp(twoProjectFake())
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('\r') // index 0（ProjectLens）の詳細を開く
    await vi.waitFor(() => expect(lastFrame()).toContain('Event History'))

    stdin.write(RIGHT) // → で index 1（Monban）へ移動
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('Monban')
      expect(frame).not.toContain('ProjectLens')
    })

    stdin.write(ESC) // 一覧へ戻る（詳細固有の BOX タイトル 'Event History' の不在で判定）
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Event History'))

    // selectedIndex は一覧・詳細で共有される単一状態のため移動先（index 1）を保持する。
    // 再度 Enter で詳細を開くと Monban になる（detailRow スナップショット時代は index 0 のままで
    // ProjectLens が開いていた）。これがカーソルの「移動先への自然一致」を裏づける。
    stdin.write('\r')
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('Event History')
      expect(frame).toContain('Monban')
      expect(frame).not.toContain('ProjectLens')
    })
  })
})

describe('AppView — 詳細ビュー中は一覧側ポーリングを停止し、一覧復帰で再開する（release-20-dashboard-heap-guard FR-04 AC-1〜AC-4）', () => {
  const ESC = String.fromCharCode(27)

  it('AC-1/AC-3: 詳細ビュー表示中は一覧側 listInstances() の呼び出しが増えず、store.setInstances() も発生しない', async () => {
    const target = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([target])
    fake.details.set(target.instance_id, makeDetail(target))
    const setInstancesSpy = vi.spyOn(InstanceListStore.prototype, 'setInstances')

    // pollIntervalMs を短く（20ms）し、観測ウィンドウ内で「停止していなければ複数回呼ばれるはず」
    // の tick 数を確保する。
    const { lastFrame, stdin } = renderApp(fake, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('\r') // Enter → 詳細
    await vi.waitFor(() => expect(lastFrame()).toContain('Event History'))

    // viewMode 切替 effect（stop()）が反映されるまでの猶予を空けてから基準値を取る。
    await new Promise((resolve) => setTimeout(resolve, 30))
    const listCallsAtDetail = fake.listCalls
    const setInstancesCallsAtDetail = setInstancesSpy.mock.calls.length

    // ポーリング間隔の複数 tick 分待っても、停止していれば増えないはず。
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fake.listCalls).toBe(listCallsAtDetail)
    expect(setInstancesSpy.mock.calls.length).toBe(setInstancesCallsAtDetail)

    setInstancesSpy.mockRestore()
  })

  it('AC-2/AC-4: 一覧へ戻ると一覧側ポーリングが再開し、start() の即時 refresh で最新データが反映される', async () => {
    const rowA = makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 })
    const fake = new FakeHubApiClient([rowA])
    fake.details.set(rowA.instance_id, makeDetail(rowA))

    // 十分長い pollIntervalMs にし、観測ウィンドウ内で自然な interval tick が紛れ込まないように
    // する（一覧復帰時の「即時 refresh」由来の再取得だけを切り分けて検証する）。
    const { lastFrame, stdin } = renderApp(fake, 100_000)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('\r') // Enter → 詳細
    await vi.waitFor(() => expect(lastFrame()).toContain('Event History'))

    // 詳細表示中にサーバ側データが増える（一覧側ポーリングは停止しているため、まだ反映されない）。
    fake.instances = [
      rowA,
      makeRow({ id: '2', projectName: 'Monban', display: 'approval_wait', priority: 4 }),
    ]
    const listCallsBeforeBack = fake.listCalls

    stdin.write(ESC) // 一覧へ戻る
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Event History'))

    // start() の内部即時 refresh() により、一覧復帰直後に最新データが反映される（AC-4）。
    await vi.waitFor(() => expect(lastFrame()).toContain('Monban'))
    expect(fake.listCalls).toBeGreaterThan(listCallsBeforeBack)
  })
})

describe('AppView — 閲覧中 instance が一覧から消えたときの復帰（review-changes 修正、release-20-dashboard-heap-guard FR-04 で挙動変更）', () => {
  it('詳細ビュー中は一覧側ポーリングが停止しているため自動では戻らないが、esc で一覧へ戻ると最新データで消失が反映される（隣へ無言で切り替わらない）', async () => {
    // review-changes 修正当時は一覧側ポーリングが詳細表示中も止まらず、その onUpdate が
    // continuous に store を更新し続けていたため「閲覧対象が裏で消えたら詳細中でも自動的に
    // 一覧へ戻る」挙動が成立していた。release-20-dashboard-heap-guard FR-04（B5 対応）で
    // 詳細表示中は一覧側 PollingLoop を stop() するようになったため、この自動検知はもう起きない
    // （store.setInstances 自体が呼ばれなくなる, FR-04 AC-1・AC-3）。
    // 「隣へ無言で切り替わらない」という review-changes の本質的な懸念自体は、esc で一覧へ戻った
    // ときに start() の即時 refresh で最新データへ更新され、消えた instance が一覧から正しく
    // 消えることで引き続き満たされる。この観点にあわせてこのテストを更新した。
    const rowA = makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 })
    const rowB = makeRow({
      id: '2',
      projectName: 'Monban',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([rowA, rowB])
    fake.details.set(rowA.instance_id, makeDetail(rowA))
    fake.details.set(rowB.instance_id, makeDetail(rowB))

    const { lastFrame, stdin } = renderApp(fake, 30)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    // 先頭（index 0 = ProjectLens）の詳細を開く。
    stdin.write('\r')
    await vi.waitFor(() => {
      const frame = lastFrame() ?? ''
      expect(frame).toContain('Event History')
      expect(frame).toContain('ProjectLens')
    })

    // サーバ側で ProjectLens が消え、Monban だけが残る。一覧側ポーリングは停止中のため、
    // 複数 tick 分待っても詳細表示のまま変化しない（FR-04 AC-1・AC-3）。
    fake.instances = [rowB]
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(lastFrame()).toContain('Event History')

    // esc で一覧へ戻ると、start() の即時 refresh（FR-04 AC-4）で最新データが反映され、
    // 消えた ProjectLens は一覧に出ない。隣（Monban）の詳細へ無言で切り替わってもいない
    // （一覧に戻り Monban がカードとして見える）。
    const ESC = String.fromCharCode(27)
    stdin.write(ESC)
    await vi.waitFor(
      () => {
        const frame = lastFrame() ?? ''
        expect(frame).not.toContain('Event History')
        expect(frame).not.toContain('ProjectLens')
        expect(frame).toContain('Monban')
      },
      { timeout: 2000 }
    )
  })
})

describe('AppView — ターミナルタイトルバー（release-6 FR-09）', () => {
  const ESC = String.fromCharCode(27)
  const BEL = String.fromCharCode(7)
  const RIGHT = `${ESC}[C`

  /** OSC 0 タイトル設定シーケンス（`setTerminalTitle` と同じ形）。 */
  function titleSequence(title: string): string {
    return `${ESC}]0;${title}${BEL}`
  }

  /** isTTY を明示した stdout（`stdout.write` に来た全チャンクを記録する）。 */
  class TtyStdout extends EventEmitter {
    columns: number | undefined = 100
    rows: number | undefined = 30
    isTTY: boolean | undefined = true
    chunks: string[] = []
    write(chunk: string): void {
      this.chunks.push(chunk)
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
    write(value: string): void {
      this.data = value
      this.emit('readable')
      this.emit('data', value)
    }
  }
  class NullStderr extends EventEmitter {
    write(): void {}
  }

  it('AC-1/AC-2/AC-4: マウント直後は既定値、詳細表示中は project@device、一覧へ戻ると既定値に戻す', async () => {
    const target = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([target])
    fake.details.set(target.instance_id, makeDetail(target))
    const stdout = new TtyStdout()
    const stdin = new TtyStdin()
    const { unmount } = inkRender(<AppView client={asClient(fake)} pollIntervalMs={30} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: new NullStderr() as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    // AC-4: マウント直後（一覧表示中）は既定値 Monomi が書き込まれる。
    await vi.waitFor(() => expect(stdout.chunks).toContain(titleSequence('Monomi')))
    // 一覧データの初回取得（非同期）が終わるのを待ってから Enter を送る。データ到着前に送ると
    // 一覧が空のまま（`openDetail` は空一覧では no-op）で詳細が開かず、後続の期待が失敗しうる。
    await vi.waitFor(() => expect(stdout.chunks.some((c) => c.includes('ProjectLens'))).toBe(true))

    // AC-1: Enter で詳細を開くと `project名 @ device名` に切り替わる。
    stdin.write('\r')
    await vi.waitFor(() => expect(stdout.chunks).toContain(titleSequence('ProjectLens @ Mac mini')))

    // AC-2: esc で一覧へ戻ると既定値へリセットされる（Monomi の書き込みがこの時点で追加されている）。
    const chunksBeforeEsc = stdout.chunks.length
    stdin.write(ESC)
    await vi.waitFor(() => {
      expect(stdout.chunks.length).toBeGreaterThan(chunksBeforeEsc)
      expect(stdout.chunks.at(-1)).toBe(titleSequence('Monomi'))
    })

    unmount()
  })

  it('AC-3: 隣接プロジェクトへ移動するとタイトルが追従する', async () => {
    const rowA = makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 })
    const rowB = makeRow({
      id: '2',
      projectName: 'Monban',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([rowA, rowB])
    fake.details.set(rowA.instance_id, makeDetail(rowA))
    fake.details.set(rowB.instance_id, makeDetail(rowB))
    const stdout = new TtyStdout()
    const stdin = new TtyStdin()
    const { unmount } = inkRender(<AppView client={asClient(fake)} pollIntervalMs={30} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: new NullStderr() as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    // 一覧データの初回取得（非同期）が終わるのを待ってから Enter を送る（上のテストと同じ理由）。
    await vi.waitFor(() => expect(stdout.chunks.some((c) => c.includes('ProjectLens'))).toBe(true))

    stdin.write('\r') // ProjectLens の詳細を開く
    await vi.waitFor(() => expect(stdout.chunks).toContain(titleSequence('ProjectLens @ Mac mini')))

    stdin.write(RIGHT) // 隣（Monban）へ移動
    await vi.waitFor(() => expect(stdout.chunks).toContain(titleSequence('Monban @ Mac mini')))

    unmount()
  })

  it('非TTY環境（ink-testing-library の既定 stdout）では OSC タイトルシーケンスを一切書き込まない', async () => {
    // review-changes 修正: 非TTY相当では Ink 自身が「非 interactive」として通常フレームと本 OSC
    // 書き込みを無調整で同じストリームへ素通しし、区別できない下流の消費者（lastFrame 実装含む）
    // からは実フレームが上書きされて見えてしまう。isTTY を問わず書き込む素朴な実装（AC-5 の文面）
    // をそのまま採用すると、この既存 UI テストの安定性そのものを壊すため、`stdout.isTTY` の
    // ときのみ書き込むよう変更した（該当コメントは app-view.tsx / terminal-title.ts 参照）。
    const target = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
    })
    const fake = new FakeHubApiClient([target])
    fake.details.set(target.instance_id, makeDetail(target))

    const { lastFrame, stdin, frames } = renderApp(fake, 30)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Event History'))

    // Ink 自身の通常描画（カーソル制御・同期更新マーカー等）も ESC(0x1b) を含むため、単純な ESC の
    // 有無ではなく OSC 0 タイトル設定シーケンスに固有のパターン（`]0;`）の不在を確認する。
    expect(frames.some((f) => f.includes(']0;'))).toBe(false)
  })
})

describe('AppView — 詳細ビュー表示中にヘルプを開いても画面があふれない（review-changes 修正）', () => {
  /** isTTY を明示した stdout（合成フレームを蓄積する）。 */
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
    write(value: string): void {
      this.data = value
      this.emit('readable')
      this.emit('data', value)
    }
  }
  class NullStderr extends EventEmitter {
    write(): void {}
  }

  it('review-changes 修正: detail 表示中に ? でヘルプを開くと、DetailView の表示件数（visible）がヘルプ分だけ正しく減る', async () => {
    // 修正前は DetailView が「ヘルプ非表示」前提で表示行数（visible）を計算しており、
    // ヘルプ表示分（HelpOverlay + その marginTop、計 HELP_OVERLAY_ROWS+1 行）を考慮していなかった。
    // stdout モックは実端末のスクロール境界を再現しない（画面外へ押し出されたかどうかまでは
    // 検証できない）ため、その代わりに「ヘルプを開くと DetailView の visible が実際に縮む」ことを
    // 範囲ラベル（"X-Y of Z"）の変化として検証する。visible が正しく縮んでいなければ、
    // AppView が extraReservedRows を配線していない（= 修正前の状態）ことを意味する。
    const target = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
    })
    const detail = makeDetail(target)
    // rows=30 → DETAIL_RESERVED_ROWS(18) を引いた visible=12。30 件あれば範囲ラベルの変化を
    // 確実に観測できる（12件未満だとヘルプなしで既に全件表示になり、差が出ない）。
    const manyEvents = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      event_type: 'PostToolUse',
      event_subtype: null,
      tool_name: 'Bash',
      tool_summary: `cmd-${i + 1}`,
      occurred_at: '2026-07-01T05:11:00.000Z',
      received_at: '2026-07-01T05:11:00.100Z',
    }))
    const fake = new FakeHubApiClient([target])
    fake.details.set(target.instance_id, { ...detail, recent_events: manyEvents })
    const stdout = new TtyStdout()
    const stdin = new TtyStdin()
    const { unmount } = inkRender(<AppView client={asClient(fake)} pollIntervalMs={30} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: new NullStderr() as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    const esc = String.fromCharCode(27)
    const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
    // ボーダー付きの枠が描かれたフレームを探す目印。selected な InstanceCard は
    // release-10-dashboard-polish FR-04 で borderStyle="double"（'╔'）になったため、
    // 従来の round 罫線（'╭'）のみでは見つからない場合がある。両方を許容する。
    const composedFrame = (): string =>
      [...stdout.frames]
        .reverse()
        .map((f) => f.replace(ansi, ''))
        .find((f) => f.includes('╭') || f.includes('╔')) ?? ''

    await vi.waitFor(() => expect(composedFrame()).toContain('ProjectLens'))
    stdin.write('\r')
    // ヘルプなし: visible=12 → 最下部は "19-30 of 30"。
    await vi.waitFor(() => expect(composedFrame()).toContain('19-30 of 30'))

    stdin.write('?')
    // release-9-i18n FR-02: このテストは setActiveLocale を呼ばないため既定ロケール（en）で走る。
    // HelpOverlay のタイトルは t('help.title') = 'Key Bindings'（EN、help-overlay.tsx 参照）。
    await vi.waitFor(() => expect(composedFrame()).toContain('Key Bindings'))
    // ヘルプあり: extraReservedRows が配線されていれば visible が縮み、
    // 範囲ラベルが "19-30 of 30" とは異なる（より狭い）ものへ変わるはず。
    await vi.waitFor(() => {
      const frame = composedFrame()
      expect(frame).toContain('Key Bindings')
      expect(frame).not.toMatch(/19-30 of 30/)
    })

    unmount()
  })
})

describe('AppView — f キーでのフォーカス実行・device_id ゲート・notice（release-23-terminal-focus FR-05c）', () => {
  it('AC-1/AC-4: 同一デバイス・有効な terminal 情報を持つ行で f を押すと focusRunner が検証済み FocusTarget で呼ばれ、成功時（ok）は notice を表示しない', async () => {
    const row = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'active',
      priority: 1,
      terminal: validTerminal({ tty: '/dev/ttys003' }),
    })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => 'ok')
    const { lastFrame, stdin } = renderAppFocus(fake, { focusRunner })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('f')
    await vi.waitFor(() => expect(focusRunner).toHaveBeenCalledTimes(1))
    expect(focusRunner).toHaveBeenCalledWith(
      expect.objectContaining({ tty: '/dev/ttys003', tmuxPane: null })
    )

    // 成功時は notice を表示しない（focus.* のいずれの文言も出ない）ことを確認する。
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(lastFrame()).not.toContain(t('focus.otherDevice'))
    expect(lastFrame()).not.toContain(t('focus.noTerminalInfo'))
    expect(lastFrame()).not.toContain(firstSentence('focus.failed'))
  })

  it('AC-2: 選択行が別デバイスなら focusRunner を呼ばず otherDevice notice を表示し、フッターにも f focus ヒントを出さない', async () => {
    const row = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'active',
      priority: 1,
      deviceId: 'other-mac',
      terminal: validTerminal(),
    })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => 'ok')
    const { lastFrame, stdin } = renderAppFocus(fake, { localDeviceId: 'macmini', focusRunner })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    expect(lastFrame()).not.toContain('f focus')

    stdin.write('f')
    await vi.waitFor(() => expect(lastFrame()).toContain(t('focus.otherDevice')))
    expect(focusRunner).not.toHaveBeenCalled()
  })

  it('AC-3: closed 行では focusRunner を呼ばず sessionClosed notice を表示する（stale TTY 誤爆防止）', async () => {
    const row = makeRow({
      id: '1',
      projectName: 'Archived',
      display: 'closed',
      priority: 0,
      terminal: validTerminal(),
    })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => 'ok')
    const { lastFrame, stdin } = renderAppFocus(fake, { focusRunner })
    // closed は既定非表示（FR-01 AC-1）なので、6 キーで表示させてから選択する。
    stdin.write('6')
    await vi.waitFor(() => expect(lastFrame()).toContain('Archived'))

    stdin.write('f')
    await vi.waitFor(() => expect(lastFrame()).toContain(t('focus.sessionClosed')))
    expect(focusRunner).not.toHaveBeenCalled()
  })

  it('AC-3: terminal 情報が無い（session.terminal === null）行では focusRunner を呼ばず noTerminalInfo notice を表示する', async () => {
    const row = makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => 'ok')
    const { lastFrame, stdin } = renderAppFocus(fake, { focusRunner })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('f')
    await vi.waitFor(() => expect(lastFrame()).toContain(t('focus.noTerminalInfo')))
    expect(focusRunner).not.toHaveBeenCalled()
  })

  it('FR-04 AC-1 連携: tty/tmux_pane がいずれも検証不合格な terminal 情報は「情報なし」へ縮退し、noTerminalInfo notice を表示する', async () => {
    const row = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'active',
      priority: 1,
      // tty はインジェクション文字列で検証不合格、tmux_pane も形式不正 → 両方 null へ縮退する。
      terminal: validTerminal({ tty: '`rm -rf /`', tmux_pane: 'not-a-pane' }),
    })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => 'ok')
    const { lastFrame, stdin } = renderAppFocus(fake, { focusRunner })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('f')
    await vi.waitFor(() => expect(lastFrame()).toContain(t('focus.noTerminalInfo')))
    expect(focusRunner).not.toHaveBeenCalled()
  })

  it.each([
    ['tmux_detached', 'focus.tmuxDetached'],
    ['not_found', 'focus.notFound'],
    ['unsupported_platform', 'focus.unsupported'],
    ['error', 'focus.failed'],
  ] as const)('AC-4: focusRunner が %s を返すと理由別 notice（%s）を表示する', async (result, key) => {
    const row = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'active',
      priority: 1,
      terminal: validTerminal(),
    })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => result as FocusResult)
    const { lastFrame, stdin } = renderAppFocus(fake, { focusRunner })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('f')
    // notFound/failed は Ghostty 向け案内を続けて含む長文で 100 列だと折り返されるため、
    // 先頭文（firstSentence）だけで判別する（他2つは短文なので全文と一致する）。
    await vi.waitFor(() => expect(lastFrame()).toContain(firstSentence(key)))
  })

  it('AC-4: notice は約4秒後に自動的に消える', async () => {
    const row = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'active',
      priority: 1,
      terminal: validTerminal(),
    })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => 'not_found')
    const { lastFrame, stdin } = renderAppFocus(fake, { focusRunner })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('f')
    await vi.waitFor(() => expect(lastFrame()).toContain(firstSentence('focus.notFound')))

    // 実タイマー + vi.waitFor を使う（watching-indicator.test.tsx と同じ理由: Ink の
    // MessageChannel 経由コミットは vi.useFakeTimers() の対象外であることを実機で確認済み）。
    await vi.waitFor(() => expect(lastFrame()).not.toContain(firstSentence('focus.notFound')), {
      timeout: 6000,
    })
  }, 10000)

  it('AC-5: フッターヒントは選択行が同一デバイスのときのみ f focus を表示する（一覧・詳細）', async () => {
    const sameDevice = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
      terminal: validTerminal(),
    })
    const otherDevice = makeRow({
      id: '2',
      projectName: 'Monban',
      display: 'active',
      priority: 1,
      deviceId: 'other-mac',
    })
    const fake = new FakeHubApiClient([sameDevice, otherDevice])
    fake.details.set(sameDevice.instance_id, makeDetail(sameDevice))
    fake.details.set(otherDevice.instance_id, makeDetail(otherDevice))
    const { lastFrame, stdin } = renderAppFocus(fake, { localDeviceId: 'macmini' })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    // 一覧: 先頭（同一デバイス）選択中は f focus が出る。
    expect(lastFrame()).toContain('f focus')

    // 詳細を開いても同一デバイスのままなら f focus が出続ける。
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Event History'))
    expect(lastFrame()).toContain('f focus')

    // 一覧へ戻り、次（別デバイス）へ移動すると f focus が消える。
    stdin.write(String.fromCharCode(27))
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Event History'))
    stdin.write('j')
    await vi.waitFor(() => expect(lastFrame()).not.toContain('f focus'))
  })

  it('AC-1: detail 表示中でも f が動作する（list/detail 両ビューで有効にディスパッチされる）', async () => {
    const row = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'approval_wait',
      priority: 4,
      terminal: validTerminal(),
    })
    const fake = new FakeHubApiClient([row])
    fake.details.set(row.instance_id, makeDetail(row))
    const focusRunner = vi.fn<FocusRunner>(async () => 'ok')
    const { lastFrame, stdin } = renderAppFocus(fake, { focusRunner })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Event History'))

    stdin.write('f')
    await vi.waitFor(() => expect(focusRunner).toHaveBeenCalledTimes(1))
  })
})

describe('AppView — startupNotices（起動時 notice チャネル、永続 notice 領域、release-25-auto-update）', () => {
  it('startupNotices の各文字列をヘッダー直下に表示する', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame } = renderAppNotices(fake, {
      startupNotices: ['hub updated: 0.1.0 -> 0.2.0', 'reporter updated'],
    })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    expect(lastFrame()).toContain('hub updated: 0.1.0 -> 0.2.0')
    expect(lastFrame()).toContain('reporter updated')
  })

  it('startupNotices 省略時（既定の空配列）は notice 領域を表示しない', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    const { lastFrame } = renderApp(fake)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    expect(lastFrame()).not.toContain('hub updated')
  })

  it('startupNotices は f キーの時限式 notice（約4秒で自動消去）とは独立し、自動消去されずに残り続ける', async () => {
    const row = makeRow({
      id: '1',
      projectName: 'ProjectLens',
      display: 'active',
      priority: 1,
      terminal: validTerminal(),
    })
    const fake = new FakeHubApiClient([row])
    const focusRunner = vi.fn<FocusRunner>(async () => 'not_found')
    const { lastFrame, stdin } = renderAppNotices(fake, {
      focusRunner,
      startupNotices: ['hub updated: 0.1.0 -> 0.2.0'],
    })
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    expect(lastFrame()).toContain('hub updated: 0.1.0 -> 0.2.0')

    stdin.write('f')
    await vi.waitFor(() => expect(lastFrame()).toContain(firstSentence('focus.notFound')))

    // 実タイマー + vi.waitFor を使う（既存の「AC-4: notice は約4秒後に自動的に消える」テストと
    // 同じ理由: Ink の MessageChannel 経由コミットは vi.useFakeTimers() の対象外であることを
    // 実機で確認済み）。
    await vi.waitFor(() => expect(lastFrame()).not.toContain(firstSentence('focus.notFound')), {
      timeout: 6000,
    })
    // 時限式 notice が消えた後も、永続 notice（startupNotices）は残り続ける。
    expect(lastFrame()).toContain('hub updated: 0.1.0 -> 0.2.0')
  }, 10000)
})

/**
 * `autoUpdate.remoteHubOutdated`（英語で139文字前後）は ink-testing-library の固定100列幅では
 * 折り返され、折り返み位置に Ink の ANSI リセット/再設定コード（`color="yellow"` 由来）が
 * 挿入される。`lastFrame()` の改行・ANSI エスケープ双方を取り除いてから検証することで、
 * 折り返み位置に依存しない安定した部分一致検証にする（1322行目の `ansi` 正規表現と同一パターン。
 * `renderApp` の Text は単独の Box 行として描画されるため、隣接する他要素との混線は起きない）。
 */
function flattenFrame(frame: string | undefined): string {
  const esc = String.fromCharCode(27)
  const ansi = new RegExp(`${esc}\\[[0-9;?]*[a-zA-Z]`, 'g')
  // 折り返み直前の行末には元の単語間スペースがそのまま残るため、改行を単純にスペースへ
  // 置換すると二重スペースになる。連続空白を1個へ畳んでから比較する。
  return (frame ?? '').replace(ansi, '').replace(/\s+/g, ' ').trim()
}

describe('AppView — リモート hub 版ずれ可視化（release-25-auto-update FR-04）', () => {
  it('AC-1: 接続中 hub の版が自版より古いとき「hub が旧版」notice を永続 notice 領域に表示する', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    fake.hubVersion = '0.1.0'
    const { lastFrame } = renderApp(fake)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    await vi.waitFor(() => {
      expect(flattenFrame(lastFrame())).toContain(
        t('autoUpdate.remoteHubOutdated', { hubVersion: '0.1.0', selfVersion: MONOMI_VERSION })
      )
    })
  })

  it('AC-1: 応答に X-Monomi-Hub-Version が無い（版不明）ときも「hub が旧版」notice を表示する（版不明=旧版扱い）', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    fake.hubVersion = undefined
    const { lastFrame } = renderApp(fake)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))

    await vi.waitFor(() => {
      expect(flattenFrame(lastFrame())).toContain(
        t('autoUpdate.remoteHubOutdated', {
          hubVersion: t('cli.hubStatus.versionUnknown'),
          selfVersion: MONOMI_VERSION,
        })
      )
    })
  })

  it('AC-2: 接続中 hub の版が自版と同一のときは notice を表示しない', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    fake.hubVersion = MONOMI_VERSION
    const { lastFrame } = renderApp(fake, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    await vi.waitFor(() => expect(fake.listCalls).toBeGreaterThanOrEqual(2))

    expect(flattenFrame(lastFrame())).not.toContain('cannot restart a remote hub')
  })

  it('AC-2: 接続中 hub の版が自版より新しいときは notice を表示しない（hub 放置、CLI 側は更新案内のみ）', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    fake.hubVersion = '99.0.0'
    const { lastFrame } = renderApp(fake, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    await vi.waitFor(() => expect(fake.listCalls).toBeGreaterThanOrEqual(2))

    expect(flattenFrame(lastFrame())).not.toContain('cannot restart a remote hub')
  })

  it('hub が自版へ追いつく（旧版→同一）と、次回ポーリングで notice が消える', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    fake.hubVersion = '0.1.0'
    const { lastFrame } = renderApp(fake, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    await vi.waitFor(() =>
      expect(flattenFrame(lastFrame())).toContain('cannot restart a remote hub')
    )

    fake.hubVersion = MONOMI_VERSION
    await vi.waitFor(() =>
      expect(flattenFrame(lastFrame())).not.toContain('cannot restart a remote hub')
    )
  })

  it('AC-4: hub 版が旧版のまま連続ポーリングしても notice は増殖せず常に1件のまま', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    fake.hubVersion = '0.1.0'
    const { lastFrame } = renderApp(fake, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    await vi.waitFor(() => expect(fake.listCalls).toBeGreaterThanOrEqual(4))

    const marker = 'cannot restart a remote hub'
    const flattened = flattenFrame(lastFrame())
    const occurrences = flattened.split(marker).length - 1
    expect(occurrences).toBe(1)
  })

  it('追加リクエストを発生させない — listInstances() 以外の GET は呼ばれない', async () => {
    const fake = new FakeHubApiClient([
      makeRow({ id: '1', projectName: 'ProjectLens', display: 'active', priority: 1 }),
    ])
    fake.hubVersion = '0.1.0'
    const getLastHubVersionSpy = vi.spyOn(fake, 'getLastHubVersion')
    const { lastFrame } = renderApp(fake, 20)
    await vi.waitFor(() => expect(lastFrame()).toContain('ProjectLens'))
    await vi.waitFor(() => expect(fake.listCalls).toBeGreaterThanOrEqual(2))

    // getLastHubVersion() は listInstances() と同数回呼ばれる（追加の GET は発生しない）。
    expect(getLastHubVersionSpy.mock.calls.length).toBe(fake.listCalls)
  })
})
