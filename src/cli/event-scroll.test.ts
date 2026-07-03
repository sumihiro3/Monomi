import { describe, expect, it } from 'vitest'
import {
  clampOffset,
  countHardLines,
  DETAIL_RESERVED_BREAKDOWN,
  DETAIL_RESERVED_ROWS,
  estimateWrappedLineCount,
  FALLBACK_VISIBLE_ROWS,
  hardLineAwareWindowForTexts,
  isAtBottom,
  MIN_VISIBLE_ROWS,
  offsetForBottom,
  visibleRowsForHeight,
  windowForOffset,
  wrapAwareWindow,
  wrapAwareWindowForTexts,
} from './event-scroll.js'

describe('DETAIL_RESERVED_ROWS', () => {
  it('内訳の合計と一致する（余白式の集約、FR-02 AC-5）', () => {
    const sum = Object.values(DETAIL_RESERVED_BREAKDOWN).reduce((a, b) => a + b, 0)
    expect(DETAIL_RESERVED_ROWS).toBe(sum)
  })
})

describe('visibleRowsForHeight', () => {
  it('TTY で高さが取れれば rows - reserved を返す（FR-02 AC-5）', () => {
    expect(visibleRowsForHeight(40, true, 18)).toBe(22)
  })

  it('rows が undefined のときは固定行数へフォールバックする（非TTY相当、FR-02 AC-5）', () => {
    expect(visibleRowsForHeight(undefined, true, 18)).toBe(FALLBACK_VISIBLE_ROWS)
  })

  it('rows が 0 のときは固定行数へフォールバックする（FR-02 AC-5）', () => {
    expect(visibleRowsForHeight(0, true, 18)).toBe(FALLBACK_VISIBLE_ROWS)
  })

  it('isTTY が false のときは高さが取れても固定行数へフォールバックする（FR-02 AC-5）', () => {
    expect(visibleRowsForHeight(200, false, 18)).toBe(FALLBACK_VISIBLE_ROWS)
  })

  it('端末が低く rows - reserved が下限を割るときは MIN_VISIBLE_ROWS を返す', () => {
    expect(visibleRowsForHeight(18, true, 18)).toBe(MIN_VISIBLE_ROWS)
    expect(visibleRowsForHeight(10, true, 18)).toBe(MIN_VISIBLE_ROWS)
  })

  it('下限ちょうど境界: reserved + MIN_VISIBLE_ROWS では MIN を返す', () => {
    expect(visibleRowsForHeight(18 + MIN_VISIBLE_ROWS, true, 18)).toBe(MIN_VISIBLE_ROWS)
    expect(visibleRowsForHeight(18 + MIN_VISIBLE_ROWS + 1, true, 18)).toBe(MIN_VISIBLE_ROWS + 1)
  })
})

describe('offsetForBottom', () => {
  it('総数が表示行数を超えるときは total - visible を返す（FR-02 AC-6）', () => {
    expect(offsetForBottom(34, 10)).toBe(24)
  })

  it('全件が1画面に収まるときは 0 を返す', () => {
    expect(offsetForBottom(5, 10)).toBe(0)
    expect(offsetForBottom(10, 10)).toBe(0)
  })

  it('0 件では 0 を返す', () => {
    expect(offsetForBottom(0, 10)).toBe(0)
  })
})

describe('clampOffset', () => {
  it('負の offset は 0 に丸める', () => {
    expect(clampOffset(34, 10, -5)).toBe(0)
  })

  it('最下部を超える offset は offsetForBottom に丸める', () => {
    expect(clampOffset(34, 10, 999)).toBe(24)
  })

  it('有効範囲内はそのまま返す', () => {
    expect(clampOffset(34, 10, 12)).toBe(12)
  })

  it('全件が収まるときは常に 0', () => {
    expect(clampOffset(5, 10, 3)).toBe(0)
  })
})

describe('isAtBottom', () => {
  it('最下部（offset === offsetForBottom）では true（tail-follow 有効、FR-02 AC-7）', () => {
    expect(isAtBottom(34, 10, 24)).toBe(true)
  })

  it('途中までスクロール中は false（新着があっても位置維持、FR-02 AC-7）', () => {
    expect(isAtBottom(34, 10, 0)).toBe(false)
    expect(isAtBottom(34, 10, 23)).toBe(false)
  })

  it('全件が収まるときは常に最下部扱い（true）', () => {
    expect(isAtBottom(5, 10, 0)).toBe(true)
  })
})

describe('windowForOffset', () => {
  it('0 件では空スライスと "0 of 0" ラベルを返す', () => {
    expect(windowForOffset(0, 10, 0)).toEqual({
      startIndex: 0,
      endIndex: 0,
      visibleCount: 0,
      rangeLabel: '0 of 0',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })

  it('総数が表示未満なら全件を表示する（FR-02 AC-4）', () => {
    expect(windowForOffset(3, 10, 0)).toEqual({
      startIndex: 0,
      endIndex: 3,
      visibleCount: 3,
      rangeLabel: '1-3 of 3',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })

  it('総数と表示行数がちょうど一致する境界', () => {
    expect(windowForOffset(10, 10, 0)).toEqual({
      startIndex: 0,
      endIndex: 10,
      visibleCount: 10,
      rangeLabel: '1-10 of 10',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })

  it('最下部（初期位置）: 最新の visible 件を表示する（FR-02 AC-6）', () => {
    expect(windowForOffset(34, 10, 24)).toEqual({
      startIndex: 24,
      endIndex: 34,
      visibleCount: 10,
      rangeLabel: '25-34 of 34',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })

  it('途中位置: offset から visible 件を表示する（FR-02 AC-4）', () => {
    expect(windowForOffset(34, 10, 0)).toEqual({
      startIndex: 0,
      endIndex: 10,
      visibleCount: 10,
      rangeLabel: '1-10 of 34',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })

  it('最下部を超える offset は最下部に丸めてから算出する', () => {
    expect(windowForOffset(34, 10, 999)).toEqual({
      startIndex: 24,
      endIndex: 34,
      visibleCount: 10,
      rangeLabel: '25-34 of 34',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })

  it('負の offset は先頭に丸めてから算出する', () => {
    expect(windowForOffset(34, 10, -3)).toEqual({
      startIndex: 0,
      endIndex: 10,
      visibleCount: 10,
      rangeLabel: '1-10 of 34',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })
})

describe('estimateWrappedLineCount（release-6 FR-10 AC-3）', () => {
  it('空文字列は1行', () => {
    expect(estimateWrappedLineCount('', 20)).toBe(1)
  })

  it('幅に収まる短いテキストは1行', () => {
    expect(estimateWrappedLineCount('hello world', 20)).toBe(1)
  })

  it('単語境界で折り返して複数行になる', () => {
    // "aaaa bbbb cccc" は幅5だと "aaaa"/"bbbb"/"cccc" の3行に折り返る
    expect(estimateWrappedLineCount('aaaa bbbb cccc', 5)).toBe(3)
  })

  it('ちょうど幅に収まる境界では1行のまま', () => {
    expect(estimateWrappedLineCount('aaaaa', 5)).toBe(1)
  })

  it('1文字超えると2行になる境界', () => {
    expect(estimateWrappedLineCount('aaaaaa', 5)).toBe(2)
  })

  it('単語自体が幅を超える場合は安全側に倒して複数行を消費する', () => {
    // 幅5に対して10文字の単語は ceil(10/5)=2 行を消費する
    expect(estimateWrappedLineCount('aaaaaaaaaa', 5)).toBe(2)
  })

  it('巨大単語の後に別の単語が続く場合は新しい行から始める（安全側）', () => {
    // "aaaaaaaaaa"(10) は幅5で2行、続く "bb" は新しい行(3行目)に配置される
    expect(estimateWrappedLineCount('aaaaaaaaaa bb', 5)).toBe(3)
  })

  it('全角文字は displayWidth で2桁として数える', () => {
    // "概要" は表示4桁。幅3だと1文字(2桁)+1文字(2桁)で2行に折り返る
    expect(estimateWrappedLineCount('概要', 3)).toBe(2)
  })

  it('contentWidth が0以下でも最低1桁として扱いクラッシュしない', () => {
    expect(() => estimateWrappedLineCount('hello', 0)).not.toThrow()
    expect(estimateWrappedLineCount('hello', 0)).toBeGreaterThanOrEqual(1)
  })

  it('連続スペースはフィルタされ空語として扱われない', () => {
    expect(estimateWrappedLineCount('a  b', 20)).toBe(1)
  })

  describe('埋め込み改行（review-changes 修正: 実機で確認された過小評価バグ）', () => {
    it('改行1つで幅に関わらず必ず2行になる（短い各行でも合算しない）', () => {
      // 各行は幅20に十分収まる短さだが、改行があるので1行にまとめてはいけない。
      expect(estimateWrappedLineCount('line1\nline2', 20)).toBe(2)
    })

    it('連続改行の間の空行も1行分として数える', () => {
      expect(estimateWrappedLineCount('a\n\nb', 20)).toBe(3)
    })

    it('末尾の改行は末尾の空行として数える', () => {
      expect(estimateWrappedLineCount('a\n', 20)).toBe(2)
    })

    it('多数の改行を含む長文（実機で確認された再現ケース）を過小評価しない', () => {
      // OGP プレビュー等で実際に観測された、10行以上の埋め込み改行を含む tool_summary を模す。
      const lines = Array.from({ length: 12 }, (_, i) => `paragraph line ${i + 1}`)
      const text = lines.join('\n')
      // 改行が11個あるので最低でも12行（各行が幅に収まるため折り返しは発生しない）。
      expect(estimateWrappedLineCount(text, 40)).toBe(12)
    })

    it('改行を含む各行がさらに幅で折り返される場合は合算される', () => {
      // 1行目は幅5で "aaaaa"(1行)、2行目は "bbbbbbbbbb"(幅5で2行) → 合計3行。
      expect(estimateWrappedLineCount('aaaaa\nbbbbbbbbbb', 5)).toBe(3)
    })
  })
})

describe('wrapAwareWindow（release-6 FR-10 AC-1・AC-2）', () => {
  /** テスト用: 各イベントを「lineCounts[i] 行の単一ハード改行区間」として扱う（部分採用なし）。 */
  function singleSegment(lineCounts: readonly number[]): (index: number) => readonly number[] {
    return (index: number) => [lineCounts[index]]
  }

  it('0件では windowForOffset と同じ空ウィンドウを返す', () => {
    expect(wrapAwareWindow(0, 10, 0, [], singleSegment([]))).toEqual({
      startIndex: 0,
      endIndex: 0,
      visibleCount: 0,
      rangeLabel: '0 of 0',
      startSkipHardLines: 0,
      endSkipHardLines: 0,
    })
  })

  it('全イベントが1行なら windowForOffset と同じ結果になる', () => {
    const lineCounts = Array(34).fill(1)
    expect(wrapAwareWindow(34, 10, 24, lineCounts, singleSegment(lineCounts))).toEqual(
      windowForOffset(34, 10, 24)
    )
  })

  it('最下部（tail-follow）: 最新を起点に、古い方向へ収まる件数だけ選ぶ', () => {
    // 直近5件が各2行(=計10行使う)で visible=10 なら5件がちょうど収まる
    const lineCounts = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2]
    const result = wrapAwareWindow(10, 10, 9, lineCounts, singleSegment(lineCounts)) // offset=9 は最下部(offsetForBottom(10,10)=0だが念のため大きめ丸め確認)
    expect(result.endIndex).toBe(10)
    expect(result.startIndex).toBe(5)
    expect(result.rangeLabel).toBe('6-10 of 10')
    expect(result.startSkipHardLines).toBe(0)
  })

  it('最下部で1件目から visible を超える場合でも最低1件は表示する（単一区間のため丸ごと採用）', () => {
    const lineCounts = [1, 1, 1, 20]
    const result = wrapAwareWindow(4, 5, 3, lineCounts, singleSegment(lineCounts))
    expect(result.startIndex).toBe(3)
    expect(result.endIndex).toBe(4)
    expect(result.visibleCount).toBe(1)
    expect(result.rangeLabel).toBe('4-4 of 4')
    expect(result.startSkipHardLines).toBe(0)
  })

  it('review-changes 修正: 最下部で境界イベントがまるごとは収まらない場合、先頭側（より古い部分）のハード改行区間を間引いて残り行数を使い切る', () => {
    // 唯一のイベントが5つのハード改行区間（各1行）を持つが visible=3。
    // 末尾（より新しい）側から3区間だけ部分採用し、先頭2区間を間引く。
    const lineCounts = [5]
    const hardLineCountsOf = (): readonly number[] => [1, 1, 1, 1, 1]
    const result = wrapAwareWindow(1, 3, 0, lineCounts, hardLineCountsOf)
    expect(result.startIndex).toBe(0)
    expect(result.endIndex).toBe(1)
    expect(result.visibleCount).toBe(1)
    // 5区間中、末尾3区間だけ採用 → 先頭2区間を省略。
    expect(result.startSkipHardLines).toBe(2)
  })

  it('途中スクロール中: 現在位置を起点に、新しい方向へ収まる件数だけ選ぶ', () => {
    // total(20) > visible(10) かつ offset(0) < offsetForBottom(10) なので mid-scroll 扱い。
    // 先頭5件が各2行(=計10行)で visible=10 なら5件がちょうど収まる。
    const lineCounts = [2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const result = wrapAwareWindow(20, 10, 0, lineCounts, singleSegment(lineCounts))
    expect(result.startIndex).toBe(0)
    expect(result.endIndex).toBe(5)
    expect(result.rangeLabel).toBe('1-5 of 20')
    expect(result.endSkipHardLines).toBe(0)
  })

  it('途中スクロール中で1件目から visible を超える場合でも最低1件は表示する（単一区間のため丸ごと採用）', () => {
    // total(10) > visible(5) かつ offset(0) < offsetForBottom(5) なので mid-scroll 扱い。
    const lineCounts = [20, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const result = wrapAwareWindow(10, 5, 0, lineCounts, singleSegment(lineCounts))
    expect(result.startIndex).toBe(0)
    expect(result.endIndex).toBe(1)
    expect(result.visibleCount).toBe(1)
  })

  it('review-changes 修正: 途中スクロール中で境界イベントがまるごとは収まらない場合、末尾側（より新しい部分）のハード改行区間を間引く', () => {
    // total(10) > visible(3) かつ offset(0) < offsetForBottom(7) なので mid-scroll 扱い。
    // 先頭（現在位置）のイベントが6つのハード改行区間（各1行）を持つが visible=3。
    // 先頭（現在位置に近い）側から3区間だけ部分採用し、末尾3区間を間引く。
    const lineCounts = [6, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const hardLineCountsOf = (index: number): readonly number[] =>
      index === 0 ? [1, 1, 1, 1, 1, 1] : [lineCounts[index]]
    const result = wrapAwareWindow(10, 3, 0, lineCounts, hardLineCountsOf)
    expect(result.startIndex).toBe(0)
    expect(result.endIndex).toBe(1)
    // 6区間中、先頭3区間だけ採用 → 末尾3区間を省略。
    expect(result.endSkipHardLines).toBe(3)
  })
})

describe('wrapAwareWindowForTexts（release-6 FR-10）', () => {
  it('estimateWrappedLineCount + wrapAwareWindow の合成と一致する', () => {
    const texts = ['aaaa bbbb', 'cccc', 'dddd eeee ffff']
    const contentWidth = 6
    const lineCounts = texts.map((t) => estimateWrappedLineCount(t, contentWidth))
    // これらのテキストに埋め込み改行は無いため、各イベントは単一のハード改行区間として扱われる
    // （wrapAwareWindowForTexts の実際の実装と一致する）。
    expect(wrapAwareWindowForTexts(texts, contentWidth, 3, 2)).toEqual(
      wrapAwareWindow(texts.length, 3, 2, lineCounts, (index: number) => [lineCounts[index]])
    )
  })
})

describe('countHardLines（review-changes 修正: 切り詰めモードでも埋め込み改行を考慮する）', () => {
  it('空文字列は1行', () => {
    expect(countHardLines('')).toBe(1)
  })

  it('改行の無いテキストは1行（幅に関わらず、切り詰めモードは単語折り返しをしないため）', () => {
    expect(countHardLines('a very long line of text that would wrap in wrap mode')).toBe(1)
  })

  it('改行1つで2行になる', () => {
    expect(countHardLines('line1\nline2')).toBe(2)
  })

  it('改行の個数+1が行数になる（12行の実機再現ケース）', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `paragraph line ${i + 1}`)
    expect(countHardLines(lines.join('\n'))).toBe(12)
  })
})

describe('hardLineAwareWindowForTexts（review-changes 修正）', () => {
  it('改行の無いテキスト（通常のイベント）では windowForOffset と同じ件数になる', () => {
    const texts = ['a', 'b', 'c', 'd', 'e']
    expect(hardLineAwareWindowForTexts(texts, 3, 5)).toEqual(windowForOffset(5, 3, 5))
  })

  it('埋め込み改行を含む1件が visible を超える場合、その1件だけで画面をあふれさせない', () => {
    // 実機で確認した再現ケース: 12行に改行されるイベントが1件だけ末尾にあり、
    // 他は通常の1行イベント。visible=8 のとき、末尾から遡って収まる件数だけに絞る。
    const bigEvent = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
    const texts = ['a', 'b', 'c', 'd', 'e', bigEvent]
    const window = hardLineAwareWindowForTexts(texts, 8, 5)
    // 巨大イベント1件だけで既に12行(visible=8超)なので、そのイベントのみが表示される
    // （0件表示という壊れた見た目を避けるフォールバック、FR-10 の設計を踏襲）。
    expect(window.startIndex).toBe(5)
    expect(window.endIndex).toBe(6)
    expect(window.rangeLabel).toBe('6-6 of 6')
  })

  it('通常の短いイベントが並ぶ場合は visible いっぱいまで詰め込む', () => {
    const texts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const window = hardLineAwareWindowForTexts(texts, 5, 9)
    expect(window.visibleCount).toBe(5)
    expect(window.rangeLabel).toBe('6-10 of 10')
  })
})
