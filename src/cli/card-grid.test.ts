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
})
