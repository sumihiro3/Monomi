import { describe, expect, it } from 'vitest'
import { columnsForWidth } from './card-grid.js'

describe('columnsForWidth', () => {
  it('40列幅では1列になる（FR-02 AC-2）', () => {
    expect(columnsForWidth(40, true)).toBe(1)
  })

  it('80列幅では2列になる', () => {
    expect(columnsForWidth(80, true)).toBe(2)
  })

  it('120列幅では3列になる（FR-02 AC-2）', () => {
    expect(columnsForWidth(120, true)).toBe(3)
  })

  it('width が undefined のときは1列にフォールバックする（FR-02 AC-4）', () => {
    expect(columnsForWidth(undefined, true)).toBe(1)
  })

  it('width が 0 のときは1列にフォールバックする（FR-02 AC-4）', () => {
    expect(columnsForWidth(0, true)).toBe(1)
  })

  it('isTTY が false のときは幅が広くても1列にフォールバックする（FR-02 AC-4）', () => {
    expect(columnsForWidth(200, false)).toBe(1)
  })

  it('列数計算は幅・TTY判定のみに依存し高さを引数に取らない（回帰確認、release-24-dashboard-display-polish FR-05: instance-card.tsx の path 行追加でカードが5行→6行になっても列数計算ロジックは変更していないことをシグネチャで担保する）', () => {
    expect(columnsForWidth.length).toBe(2)
    // 同一の width/isTTY なら、カード内部の行数（高さ）に関する情報を一切渡していなくても
    // 結果は決定的（=高さに影響されない）。
    expect(columnsForWidth(120, true)).toBe(columnsForWidth(120, true))
  })
})
