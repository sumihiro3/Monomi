import { describe, expect, it } from 'vitest'
import {
  bottomBorderWithLabel,
  displayWidth,
  FALLBACK_BOX_WIDTH,
  resolveBoxWidth,
  topBorderWithTitle,
} from './box-border.js'

describe('resolveBoxWidth', () => {
  it('TTY で columns が取れればそのまま幅を返す（FR-06）', () => {
    expect(resolveBoxWidth(120, true)).toBe(120)
  })

  it('columns が undefined のときは固定幅へフォールバックする（非TTY相当、FR-06）', () => {
    expect(resolveBoxWidth(undefined, true)).toBe(FALLBACK_BOX_WIDTH)
  })

  it('columns が 0 のときは固定幅へフォールバックする（FR-06）', () => {
    expect(resolveBoxWidth(0, true)).toBe(FALLBACK_BOX_WIDTH)
  })

  it('isTTY が false のときは columns が取れても固定幅へフォールバックする（FR-06）', () => {
    expect(resolveBoxWidth(200, false)).toBe(FALLBACK_BOX_WIDTH)
  })

  it('固定フォールバック幅は 80', () => {
    expect(FALLBACK_BOX_WIDTH).toBe(80)
  })
})

describe('displayWidth', () => {
  it('ASCII は 1 桁ずつ数える', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('1-10 of 34')).toBe(10)
  })

  it('空文字は 0', () => {
    expect(displayWidth('')).toBe(0)
  })

  it('CJK 全角タイトル 概要 は 4 桁（2文字×2）', () => {
    expect(displayWidth('概要')).toBe(4)
  })

  it('カナ+漢字 イベント履歴 は 12 桁（6文字×2）', () => {
    expect(displayWidth('イベント履歴')).toBe(12)
  })

  it('全角と半角の混在を正しく合算する', () => {
    expect(displayWidth('A概')).toBe(3)
    expect(displayWidth('概要 1-2')).toBe(4 + 1 + 3)
  })

  it('Box Drawing 罫線文字（╭╮╰╯─│）は 1 桁扱い（Ambiguous、角ズレ防止の前提）', () => {
    expect(displayWidth('╭─╮')).toBe(3)
    expect(displayWidth('╰─╯')).toBe(3)
    expect(displayWidth('│')).toBe(1)
  })

  it('サロゲートペア（絵文字）を 1 コードポイントとして 2 桁で数える', () => {
    expect(displayWidth('😀')).toBe(2)
    expect('😀'.length).toBe(2) // UTF-16 では 2 だが表示は 2 桁
  })
})

describe('topBorderWithTitle', () => {
  it('全角タイトルでも表示桁が width ちょうどになる（角ズレ防止の核、FR-06）', () => {
    expect(displayWidth(topBorderWithTitle(20, '概要'))).toBe(20)
    expect(displayWidth(topBorderWithTitle(20, 'イベント履歴'))).toBe(20)
  })

  it('左寄せ・丸角で描画する（╭─ title …─╮）', () => {
    expect(topBorderWithTitle(20, '概要')).toBe('╭─ 概要 ───────────╮')
    expect(topBorderWithTitle(20, 'イベント履歴')).toBe('╭─ イベント履歴 ───╮')
  })

  it('タイトルがちょうど収まる最小幅では フィル0 で全表示する（境界）', () => {
    // 概要(4桁) は w-5>=4 すなわち width>=9 で全表示できる
    expect(topBorderWithTitle(9, '概要')).toBe('╭─ 概要 ╮')
    expect(displayWidth(topBorderWithTitle(9, '概要'))).toBe(9)
  })

  it('幅が 1 桁足りないと全角境界で切り詰める（はみ出し境界）', () => {
    // width=8 では maxTitle=3 桁 → 概(2) のみ、要 は入らずフィルに 1 桁回る
    expect(topBorderWithTitle(8, '概要')).toBe('╭─ 概 ─╮')
    expect(displayWidth(topBorderWithTitle(8, '概要'))).toBe(8)
  })

  it('本文が 1 桁も入らない狭幅ではタイトル無しの丸角罫線にフォールバックする', () => {
    expect(topBorderWithTitle(6, '概要')).toBe('╭────╮')
    expect(topBorderWithTitle(2, '概要')).toBe('╭╮')
    expect(displayWidth(topBorderWithTitle(6, '概要'))).toBe(6)
  })

  it('MIN_BOX_WIDTH 未満の width は最小幅（2）に丸める', () => {
    expect(topBorderWithTitle(1, '概要')).toBe('╭╮')
    expect(topBorderWithTitle(0, '概要')).toBe('╭╮')
    expect(displayWidth(topBorderWithTitle(0, '概要'))).toBe(2)
  })

  it('あらゆる幅で表示桁が width（>=2）ちょうどになる（角整列の不変条件）', () => {
    for (let w = 2; w <= 40; w++) {
      expect(displayWidth(topBorderWithTitle(w, '概要'))).toBe(w)
      expect(displayWidth(topBorderWithTitle(w, 'イベント履歴'))).toBe(w)
    }
  })
})

describe('bottomBorderWithLabel', () => {
  it('ラベルは右寄せ・丸角で描画する（╰…─ label ─╯、FR-07）', () => {
    expect(bottomBorderWithLabel(20, '1-10 of 34')).toBe('╰───── 1-10 of 34 ─╯')
  })

  it('要件例（幅19）の見た目を再現する（╰──── 1-10 of 34 ─╯）', () => {
    expect(bottomBorderWithLabel(19, '1-10 of 34')).toBe('╰──── 1-10 of 34 ─╯')
  })

  it('ラベルは右端に固定され、可変フィルは左側に入る（右寄せ位置）', () => {
    const line = bottomBorderWithLabel(30, '25-34 of 34')
    expect(line.startsWith('╰─')).toBe(true)
    expect(line.endsWith(' 25-34 of 34 ─╯')).toBe(true)
    expect(displayWidth(line)).toBe(30)
  })

  it('全角ラベルでも表示桁が width ちょうどになる', () => {
    expect(displayWidth(bottomBorderWithLabel(20, '履歴'))).toBe(20)
  })

  it('本文が入らない狭幅ではラベル無しの丸角罫線にフォールバックする', () => {
    expect(bottomBorderWithLabel(2, '1 of 1')).toBe('╰╯')
    expect(bottomBorderWithLabel(5, '1 of 1')).toBe('╰───╯')
  })

  it('あらゆる幅で表示桁が width（>=2）ちょうどになる（角整列の不変条件）', () => {
    for (let w = 2; w <= 40; w++) {
      expect(displayWidth(bottomBorderWithLabel(w, '1-10 of 34'))).toBe(w)
    }
  })
})
