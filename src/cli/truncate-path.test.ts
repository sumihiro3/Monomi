import { describe, expect, it } from 'vitest'
import { collapseHomeDir, truncateMiddle } from './truncate-path.js'

describe('truncateMiddle', () => {
  it('表示幅が maxWidth 以下の通常パスはそのまま返す（要省略なし）', () => {
    expect(truncateMiddle('/opt/dev/Monomi/src', 30)).toBe('/opt/dev/Monomi/src')
  })

  it('表示幅が maxWidth ちょうどのパスは省略せずそのまま返す（境界）', () => {
    const path = '/opt/dev/Monomi/src'
    expect(path.length).toBe(19)
    expect(truncateMiddle(path, 19)).toBe(path)
  })

  it('長い ASCII パスを 先頭…末尾 形式で中間省略し、表示幅が maxWidth ちょうどになる', () => {
    const path = '/opt/dev/Monomi/release-23/src'
    const result = truncateMiddle(path, 15)
    expect(result).toBe('/opt/de…-23/src')
    expect(result.length).toBe(15) // ASCII のみなので表示幅=文字数
  })

  it('末尾優先で配分する（残り幅が奇数のとき余り1桁は末尾に回る）', () => {
    // maxWidth=8 → ellipsis(1) を引いた contentWidth=7 → tailWidth=ceil(7/2)=4, headWidth=3
    const path = '/opt/dev/Monomi/release-23/src'
    const result = truncateMiddle(path, 8)
    expect(result).toBe('/op…/src')
    expect(result.length).toBe(8)
  })

  it('全角混じりパスでも displayWidth ベースで正しく中間省略する', () => {
    // 'あいうえお'(全角5文字=幅10) + '/' + '1234567890'(10) = 幅21
    const path = 'あいうえお/1234567890'
    const result = truncateMiddle(path, 10)
    expect(result).toBe('あい…67890')
    // あ(2)+い(2) + …(1) + 67890(5) = 10
  })

  it('全角文字が半端に収まらない境界では、表示幅が maxWidth を超えずに1桁分の余りを許容する', () => {
    // headWidth=5 だが 'あ'+'い'=4 で打ち止め('う'は+2で5を超える) → 表示幅は maxWidth-1 になる
    const path = 'あいうえお/1234567890'
    const result = truncateMiddle(path, 11)
    expect(result).toBe('あい…67890')
  })

  it('中間省略が成立する最小幅（maxWidth=3）では 先頭1桁…末尾1桁 を返す（境界）', () => {
    const path = '/opt/dev/Monomi/release-23/src'
    const result = truncateMiddle(path, 3)
    expect(result).toBe('/…c')
    expect(result.length).toBe(3)
  })

  it('maxWidth が中間省略の成立最小値未満（2）のときは末尾省略へフォールバックする', () => {
    const path = '/opt/dev/Monomi/release-23/src'
    // truncateToWidth 相当（先頭を残し末尾を切り捨てる）で '…' を含まない
    expect(truncateMiddle(path, 2)).toBe('/o')
  })

  it('maxWidth=0 のフォールバックは空文字を返す（極小幅境界）', () => {
    expect(truncateMiddle('/opt/dev/Monomi/src', 0)).toBe('')
  })

  it('maxWidth=1 のフォールバックは先頭1文字のみ返す（極小幅境界）', () => {
    expect(truncateMiddle('/opt/dev/Monomi/src', 1)).toBe('/')
  })
})

describe('collapseHomeDir', () => {
  it('/Users/<name>/... を ~/... に置換する', () => {
    expect(collapseHomeDir('/Users/alice/proj/src')).toBe('~/proj/src')
  })

  it('ホームディレクトリそのもの（末尾スラッシュ無し）は ~ に置換する', () => {
    expect(collapseHomeDir('/Users/alice')).toBe('~')
  })

  it('ホームディレクトリそのもの（末尾スラッシュ有り）は ~/ に置換する', () => {
    expect(collapseHomeDir('/Users/alice/')).toBe('~/')
  })

  it('ユーザー名にハイフン・ドットを含んでいても1セグメントとして置換する', () => {
    expect(collapseHomeDir('/Users/alice-bob.baz/repo')).toBe('~/repo')
  })

  it('/Users/ 配下でないパスはそのまま返す', () => {
    expect(collapseHomeDir('/opt/dev/Monomi')).toBe('/opt/dev/Monomi')
  })

  it('先頭が /Users だが区切りが一致しない場合は置換しない（誤マッチ防止）', () => {
    expect(collapseHomeDir('/UsersFoo/bar')).toBe('/UsersFoo/bar')
  })

  it('/home/<name>/... を ~/... に置換する（Linux/WSL2、FR-04 AC-5）', () => {
    expect(collapseHomeDir('/home/alice/proj/src')).toBe('~/proj/src')
  })

  it('/home/<name> のホームディレクトリそのもの（末尾スラッシュ無し）は ~ に置換する', () => {
    expect(collapseHomeDir('/home/alice')).toBe('~')
  })

  it('/home/<name>/ のホームディレクトリそのもの（末尾スラッシュ有り）は ~/ に置換する', () => {
    expect(collapseHomeDir('/home/alice/')).toBe('~/')
  })

  it('先頭が /home だが区切りが一致しない場合は置換しない（誤マッチ防止）', () => {
    expect(collapseHomeDir('/homeFoo/bar')).toBe('/homeFoo/bar')
  })

  it('collapseHomeDir → truncateMiddle の順で適用した合成結果が maxWidth ちょうどになる', () => {
    const collapsed = collapseHomeDir('/Users/alice/projects/very-long-repo-name/src/index.ts')
    expect(collapsed).toBe('~/projects/very-long-repo-name/src/index.ts')
    const result = truncateMiddle(collapsed, 19)
    expect(result).toBe('~/project…/index.ts')
    expect(result.length).toBe(19)
  })
})
