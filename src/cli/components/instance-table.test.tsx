import { EventEmitter } from 'node:events'
import { render as inkRender } from 'ink'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { setActiveLocale } from '../../i18n/index.js'
import { InstanceTable } from './instance-table.js'

/** ANSI シアン（前景色）のエスケープ。ink が選択カードのボーダー色 `cyan` に対して出力する。 */
const CYAN = '[36m'

/** テスト用 instance 行を作る（表示に効く最小フィールドのみ指定）。 */
function makeRow(over: {
  id?: string
  projectName?: string
  deviceName?: string
  branch?: string | null
  display?: string
  elapsedSeconds?: number
}): InstanceStatusRow {
  const id = over.id ?? 'inst-1'
  const display = over.display ?? 'approval_wait'
  return {
    instance_id: id,
    project: { id: `proj-${id}`, name: over.projectName ?? 'ProjectLens' },
    device: { id: 'macmini', name: over.deviceName ?? 'Mac mini' },
    path: '/Users/sumihiro/dev/ProjectLens',
    branch: over.branch === undefined ? 'feature/ai-sidecar' : over.branch,
    status: {
      display,
      raw_state: display === 'stale' ? 'active' : display,
      elapsed_seconds: over.elapsedSeconds ?? 720,
      is_stale: display === 'stale',
      priority: 4,
    },
    pr: { state: 'none' },
    session: { id: `sess-${id}`, last_heartbeat_at: null, terminal: null },
    running_work: null,
  }
}

afterEach(() => {
  setActiveLocale('en')
})

describe('InstanceTable（カードグリッド、FR-01・FR-02）', () => {
  it('FR-01 AC-4: 既定ロケール（en）で 0 件のとき英語の不在メッセージを表示する（release-9-i18n FR-02 AC-2・AC-5）', () => {
    const { lastFrame } = render(<InstanceTable rows={[]} selectedIndex={0} />)
    expect(lastFrame() ?? '').toContain('(No matching instances)')
  })

  it('FR-01 AC-4: locale: ja で 0 件のとき日本語の不在メッセージを表示する（release-9-i18n FR-02 AC-2・AC-5）', () => {
    setActiveLocale('ja')
    const { lastFrame } = render(<InstanceTable rows={[]} selectedIndex={0} />)
    expect(lastFrame() ?? '').toContain('(該当するインスタンスがありません)')
  })

  it('FR-01 AC-1/AC-3: 既定ロケール（en）でカードに project/device/branch/状態ラベル/age を描画する（release-9-i18n FR-01 AC-2）', () => {
    // selectedIndex を範囲外にして非選択のまま描画する（release-10-dashboard-polish FR-04 で
    // 選択中カードは borderStyle="double" に変わったため、本テストの関心事である「内容」の検証を
    // 選択状態のボーダー種別と切り離す）。
    const { lastFrame } = render(<InstanceTable rows={[makeRow({})]} selectedIndex={99} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('╭') // ボーダー付きボックス（round border、非選択）
    expect(frame).toContain('ProjectLens')
    expect(frame).toContain('Mac mini')
    expect(frame).toContain('feature/ai-sidecar')
    expect(frame).toContain('Awaiting approval') // approval_wait の en ラベル（status-display 再利用、AC-3）
    expect(frame).toContain('○') // approval_wait のグリフ
    expect(frame).toContain('12m') // 720 秒 → 12m（formatAge 再利用）
  })

  it('FR-01 AC-1/AC-3: locale: ja でカードの状態ラベルが日本語で描画される（release-9-i18n FR-02 AC-2・AC-5）', () => {
    setActiveLocale('ja')
    const { lastFrame } = render(<InstanceTable rows={[makeRow({})]} selectedIndex={0} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('権限待ち') // approval_wait ラベル（status-display 再利用、AC-3）
    expect(frame).toContain('○') // approval_wait のグリフ
    expect(frame).toContain('12m') // 720 秒 → 12m（formatAge 再利用）
  })

  it('FR-01 AC-2: 選択インデックスのカードだけボーダー色が cyan になる', () => {
    // 状態色が cyan でない approval_wait を使い、cyan の出所を選択カードのボーダーに限定する。
    const rows = [
      makeRow({ id: '1', projectName: 'Alpha' }),
      makeRow({ id: '2', projectName: 'Beta' }),
    ]
    // 範囲外の選択（どのカードも選択されない）では cyan は現れない。
    const none = render(<InstanceTable rows={rows} selectedIndex={99} />).lastFrame() ?? ''
    // 範囲内の選択では、その 1 枚のボーダーが cyan になる。
    const selected = render(<InstanceTable rows={rows} selectedIndex={0} />).lastFrame() ?? ''

    expect(none).not.toContain(CYAN)
    expect(selected).toContain(CYAN)
  })

  it('FR-02 AC-4: 非TTY（ink-testing は isTTY 未定義）では 1 列にフォールバックしカードが縦積みになる', () => {
    const rows = [
      makeRow({ id: '1', projectName: 'AlphaProj' }),
      makeRow({ id: '2', projectName: 'BetaProj' }),
      makeRow({ id: '3', projectName: 'GammaProj' }),
    ]
    const { lastFrame } = render(<InstanceTable rows={rows} selectedIndex={0} />)
    const lines = (lastFrame() ?? '').split('\n')
    const names = ['AlphaProj', 'BetaProj', 'GammaProj']

    // 3 枚とも描画される。
    for (const name of names) {
      expect(lines.some((line) => line.includes(name))).toBe(true)
    }
    // 1 列縮退の証左: どの行にも 2 つ以上の project 名は同居しない（横並びしていない）。
    for (const line of lines) {
      const hits = names.filter((name) => line.includes(name))
      expect(hits.length).toBeLessThanOrEqual(1)
    }
  })

  it('FR-02 AC-4（レビュー修正）: stdout.columns が undefined の実非TTY環境でも横並びしない', async () => {
    // ink-testing-library の Stdout モックは columns を 100 に固定しており、本来の
    // 非TTY（`stdout.columns === undefined`）を再現できず、cardWidth が undefined になって
    // 各カードが内容幅で横並びする不具合を検出できなかった（レビュー指摘）。ink の render() を
    // 直接使い、columns/isTTY 未定義の実環境相当の stdout を注入して確定的に再現・検証する。
    class MinimalNonTtyStdout extends EventEmitter {
      columns: number | undefined = undefined
      isTTY: boolean | undefined = undefined
      frames: string[] = []
      write(frame: string): void {
        this.frames.push(frame)
      }
    }
    class NullStdin extends EventEmitter {
      isTTY = false
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

    const rows = [
      makeRow({ id: '1', projectName: 'AlphaProj' }),
      makeRow({ id: '2', projectName: 'BetaProj' }),
      makeRow({ id: '3', projectName: 'GammaProj' }),
    ]
    const stdout = new MinimalNonTtyStdout()
    const { unmount } = inkRender(<InstanceTable rows={rows} selectedIndex={0} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: new NullStderr() as unknown as NodeJS.WriteStream,
      stdin: new NullStdin() as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    unmount()

    const lastFrame = stdout.frames[stdout.frames.length - 1] ?? ''
    const lines = lastFrame.split('\n')
    const names = ['AlphaProj', 'BetaProj', 'GammaProj']

    for (const name of names) {
      expect(lines.some((line) => line.includes(name))).toBe(true)
    }
    for (const line of lines) {
      const hits = names.filter((name) => line.includes(name))
      expect(hits.length).toBeLessThanOrEqual(1)
    }
  })
})
