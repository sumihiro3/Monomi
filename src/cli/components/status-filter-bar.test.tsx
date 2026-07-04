import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { setActiveLocale } from '../../i18n/index.js'
import { StatusFilterBar } from './status-filter-bar.js'

/** ANSI 青（背景色）のエスケープ。ink が `backgroundColor="blue"` に対して出力する。 */
const BG_BLUE = '[44m'

afterEach(() => {
  setActiveLocale('en')
})

const COUNTS = { active: 2, approval_wait: 1, next_wait: 2, pr_wait: 1, stale: 2, closed: 3 }

describe('StatusFilterBar（release-9-i18n レイアウト回帰）', () => {
  it('100桁端末・既定ロケール(en)でも、各フィルタ項目のラベルと件数が同じ行にまとまる（flexWrap回帰）', () => {
    // 既定ロケール(en)のラベルは日本語より長く("Awaiting next instruction"等)、
    // flexWrap 未指定だと Yoga が項目内部で文言と件数を千切って折り返してしまう
    // (release-9-i18n 実装時に発見した回帰)。項目単位でまとまって折り返されることを確認する。
    // ink-testing-library の Stdout は列数を 100 固定で返す（オプション指定不可）。
    const { lastFrame } = render(<StatusFilterBar counts={COUNTS} activeFilters={[]} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[1]Active 2')
    expect(frame).toContain('[2]Awaiting approval 1')
    expect(frame).toContain('[3]Awaiting next instruction 2')
    expect(frame).toContain('[4]Awaiting PR review 1')
    expect(frame).toContain('[5]Stale 2')
    expect(frame).toContain('[6]Closed 3')
  })
})

describe('StatusFilterBar（release-10-dashboard-polish FR-05）', () => {
  it('AC-1/AC-2: activeFilters に含まれるフィルタのみ backgroundColor で強調される（inverse→backgroundColor 置換）', () => {
    const { lastFrame } = render(<StatusFilterBar counts={COUNTS} activeFilters={['active']} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain(BG_BLUE)
  })

  it('AC-2: activeFilters が空のときは、どのバッジにも backgroundColor 強調が付かない', () => {
    const { lastFrame } = render(<StatusFilterBar counts={COUNTS} activeFilters={[]} />)
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain(BG_BLUE)
  })
})
