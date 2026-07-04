import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { setActiveLocale } from '../../i18n/index.js'
import { InstanceCard } from './instance-card.js'

/** ANSI シアン（前景色）のエスケープ。ink がボーダー色 `cyan` に対して出力する。 */
const CYAN = '[36m'

/** テスト用 instance 行を作る（表示に効く最小フィールドのみ指定）。 */
function makeRow(over: {
  projectName?: string
  deviceName?: string
  branch?: string | null
  display?: string
  elapsedSeconds?: number
}): InstanceStatusRow {
  const display = over.display ?? 'approval_wait'
  return {
    instance_id: 'inst-1',
    project: { id: 'proj-1', name: over.projectName ?? 'ProjectLens' },
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
    session: { id: 'sess-1', last_heartbeat_at: null },
  }
}

afterEach(() => {
  setActiveLocale('en')
})

describe('InstanceCard（FR-01）', () => {
  it('AC-1: 既定ロケール（en）で project/device/branch/状態ラベル/age を描画する（release-9-i18n FR-01 AC-2）', () => {
    const { lastFrame } = render(<InstanceCard row={makeRow({})} selected={false} width={36} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('ProjectLens')
    expect(frame).toContain('Mac mini')
    expect(frame).toContain('feature/ai-sidecar')
    expect(frame).toContain('Awaiting approval') // approval_wait の en ラベル（status-display 再利用、AC-3）
    expect(frame).toContain('○') // approval_wait のグリフ
    expect(frame).toContain('12m') // 720 秒 → 12m（formatAge 再利用）
  })

  it('AC-1: locale: ja で状態ラベルが日本語で描画される（release-9-i18n FR-02 AC-2・AC-5）', () => {
    setActiveLocale('ja')
    const { lastFrame } = render(<InstanceCard row={makeRow({})} selected={false} width={36} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('権限待ち') // approval_wait のラベル（status-display 再利用、AC-3）
    expect(frame).toContain('○') // approval_wait のグリフ
    expect(frame).toContain('12m') // 720 秒 → 12m（formatAge 再利用）
  })

  it('AC-1: branch が null のとき "-" を描画する', () => {
    const { lastFrame } = render(
      <InstanceCard row={makeRow({ branch: null })} selected={false} width={36} />
    )
    expect(lastFrame() ?? '').toContain('-')
  })

  it('AC-2: selected=true でボーダー色が cyan になる（未選択では付かない）', () => {
    // 状態色が cyan でない approval_wait を使い、cyan の出所をボーダーに限定する。
    const unselected =
      render(<InstanceCard row={makeRow({})} selected={false} width={36} />).lastFrame() ?? ''
    const selected =
      render(<InstanceCard row={makeRow({})} selected width={36} />).lastFrame() ?? ''

    expect(unselected).not.toContain(CYAN)
    expect(selected).toContain(CYAN)
  })
})
