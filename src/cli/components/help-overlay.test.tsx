import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { setActiveLocale } from '../../i18n/index.js'
import { HelpOverlay } from './help-overlay.js'

afterEach(() => {
  setActiveLocale('en')
})

describe('HelpOverlay（release-9-i18n FR-02）', () => {
  it('AC-1: 既定ロケール（en）でタイトルと代表的な説明行が英語で描画される（FR-01 AC-2）', () => {
    const { lastFrame } = render(<HelpOverlay />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Key Bindings') // help.title
    expect(frame).toContain('List: toggle status filters (multi-select)') // help.filterToggle
    expect(frame).toContain('List: move cursor / Detail: scroll event history') // help.moveOrScroll
    expect(frame).toContain('Quit') // help.quit
    // キー列自体はロケール非依存でそのまま描画される。
    expect(frame).toContain('1-6')
    expect(frame).toContain('esc')
  })

  it('AC-5: locale: ja でタイトルと代表的な説明行が日本語で描画される（FR-02 AC-2・AC-5）', () => {
    setActiveLocale('ja')
    const { lastFrame } = render(<HelpOverlay />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('キーバインド') // help.title
    expect(frame).toContain('一覧: 状態フィルタのトグル（複数選択可）') // help.filterToggle
    expect(frame).toContain('終了') // help.quit
    // キー列自体はロケール非依存でそのまま描画される。
    expect(frame).toContain('1-6')
    expect(frame).toContain('esc')
  })
})
