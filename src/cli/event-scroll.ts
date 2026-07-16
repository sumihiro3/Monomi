import { displayWidth } from './box-border.js'

/**
 * 詳細ビュー（Agent View Lv.1）イベント履歴のスクロール計算（§10.4 / release-6 FR-02）。
 *
 * `card-grid.ts` の {@link ../card-grid.js#columnsForWidth} と同じ思想で、React に依存しない
 * 純粋関数として「端末高さ → 表示可能行数」と「スクロールウィンドウ（先頭 index=offset 方式）」を
 * 計算する。DetailView 側は `useStdout().stdout.rows` から得た値をこれらに渡すだけで、
 * offset の clamp や `X-Y of Z` の算出ロジックを React コンポーネント内へ散らさない。
 * 単体テストで境界値（0 件・表示未満・はみ出し・非TTY・最下部/途中）を直接検証できる。
 *
 * 全体件数 Z（rangeLabel の "of Z"）は hub から取得済みのイベント件数であり、
 * hub 側取得上限 `RECENT_EVENTS_LIMIT`（現状 100、`src/hub/instance-status-service.ts`）で
 * 頭打ちになる。DB の真の全イベント件数ではない（release-6 FR-02 AC-4 / スコープ外）。
 *
 * review-changes 指摘（重要な限界）: 「React に依存しない」のは関数の実装（引数のみで完結し
 * 副作用が無い）についての話であり、{@link DETAIL_RESERVED_BREAKDOWN} の各定数の**値**は
 * AppView・DetailView の JSX 構造（行の増減・marginTop の箇所数など）と 1 対 1 で結合している。
 * `columnsForWidth` の `Math.floor(width / MIN_CARD_WIDTH)` のような一般式ではなく、レイアウトを
 * 手で数え上げたマジックナンバーである点で `card-grid.ts` とは結合の強さが異なる。この結合は
 * コンパイラでも既存テストでも検出できないため、AppView/DetailView 側の行構成（フィールド追加・
 * BOX増減・marginTop増減）を変えたら、必ず {@link DETAIL_RESERVED_BREAKDOWN} を合わせて更新する
 * こと（release-6 FR-07 AC-4 で明文化済みの運用）。
 *
 * {@link estimateWrappedLineCount} / {@link wrapAwareWindow} / {@link wrapAwareWindowForTexts} は
 * release-6 FR-10 の追加分（折り返しモードで画面があふれないよう表示件数を動的に絞る）。
 * FR-05 AC-4・FR-08 AC-2 が壁打ち追記時点で当初許容していた「折り返しモード中はヘッダー・概要BOXが
 * スクロールしうる」という例外はこの実装により撤回され、折り返しモードでも `visible` を超えない
 * 件数に絞ることで常に固定表示を保つ（切り詰めモードの挙動・件数計算は変更しない、FR-10 AC-5）。
 */

/**
 * `rows` 未取得（非TTY 等）時の固定表示行数（FR-02 AC-5 のフォールバック）。
 *
 * release-4 で `stdout.columns` が非TTY で `undefined` になり1列フォールバックが壊れていた
 * 不具合（FR-02 AC-4）と同種の見落としを避けるため、`rows` が falsy（undefined / 0）または
 * 非TTY のときはここに定めた固定値を必ず返す。
 */
export const FALLBACK_VISIBLE_ROWS = 10

/**
 * TTY で高さが取れた場合でも下回らせない表示行数の下限。
 *
 * 端末が極端に低いと `rows - reserved` が 0 以下になり得るが、
 * イベントBOXが潰れて何も見えなくなるのを防ぐため最低限の行数を確保する
 * （`columnsForWidth` が `Math.max(1, …)` で最低1列を保証するのと同じ思想）。
 */
export const MIN_VISIBLE_ROWS = 3

/**
 * イベント履歴BOXのスクロール内容以外が消費する端末行数の内訳（FR-02 AC-5 の余白減算式）。
 *
 * 「未解決事項: 余白計算式」をここに集約して確定させる。各項は release-6 の詳細ビュー
 * レイアウト（AppView + DetailView）に対応し、レイアウト変更時はこの内訳だけを直せばよい。
 * 合計は {@link DETAIL_RESERVED_ROWS}。
 */
export const DETAIL_RESERVED_BREAKDOWN = {
  /** AppView 最上部のタイトル行（"Claude Code Status …"）。 */
  appHeader: 1,
  /** 上部プロジェクト概要BOX: `round` 下辺(1) + 自前タイトル行(1, FR-06) + フィールド行群
   * （instance_id/project/device/branch/status/running/session_id/path/terminal/pr）。
   * release-24 FR-02 で `path` の直後に `terminal` 行を追加したため、旧値 10 から +1 して 11 にする。
   * borderTop 非描画ぶんは自前タイトル行が相殺する。 */
  overviewBox: 11,
  /** イベント履歴BOX の chrome: 自前タイトル行(1, FR-06) + 範囲ラベル付き自前下辺(1, FR-07)。上下罫線は borderTop/Bottom=false で無効化し box-border の罫線行に置換する。スクロールするイベント本文は含めない。 */
  eventBoxChrome: 2,
  /** `marginTop={1}` の空行 3 箇所（header→detail / overview→events / body→footer）。 */
  sectionGaps: 3,
  /** 最下部のフッターヒント行。 */
  footer: 1,
} as const

/**
 * イベント履歴BOXのスクロール内容以外が消費する端末行数の合計。
 *
 * DetailView は `visibleRowsForHeight(rows, isTTY, DETAIL_RESERVED_ROWS)` の形で渡す。
 */
export const DETAIL_RESERVED_ROWS: number = Object.values(DETAIL_RESERVED_BREAKDOWN).reduce(
  (sum, n) => sum + n,
  0
)

/**
 * 端末高さから、イベント履歴BOXに一度に表示できる行数を算出する（FR-02 AC-5）。
 *
 * `isTTY` が false、または `rows` が未取得（`undefined`）／0 の場合は
 * {@link FALLBACK_VISIBLE_ROWS} を返す（`ink-testing-library` の render-to-string など
 * 非TTY 環境向けフォールバック）。それ以外は `rows - reserved` を表示行数とし、
 * 端末が低くても {@link MIN_VISIBLE_ROWS} を下回らないようにする。
 *
 * @param rows 端末の行数（`useStdout().stdout.rows` 相当）。未取得なら `undefined`。
 * @param isTTY 端末が TTY かどうか（`useStdout().stdout.isTTY` 相当）。
 * @param reserved スクロール内容以外が使う行数（通常 {@link DETAIL_RESERVED_ROWS}）。
 * @returns 表示可能なイベント行数（1 以上の整数）。
 */
export function visibleRowsForHeight(
  rows: number | undefined,
  isTTY: boolean,
  reserved: number
): number {
  if (!isTTY || !rows) {
    return FALLBACK_VISIBLE_ROWS
  }
  return Math.max(MIN_VISIBLE_ROWS, rows - reserved)
}

/** {@link windowForOffset} が返す表示ウィンドウ。`events.slice(startIndex, endIndex)` が表示分。 */
export interface ScrollWindow {
  /** 表示ウィンドウ先頭のイベント index（= 正規化後の offset。0 始まり・含む）。 */
  startIndex: number
  /** 表示ウィンドウ末尾の次の index（`slice` の第2引数と同じく排他的）。 */
  endIndex: number
  /** 表示件数（`endIndex - startIndex`）。 */
  visibleCount: number
  /** 右下に出す範囲ラベル（例 `25-34 of 34`）。0 件時は `0 of 0`。 */
  rangeLabel: string
  /**
   * `startIndex` のイベントについて、先頭から省略するハード改行区切り区間の個数（review-changes
   * 修正）。0 なら省略なし（イベント全体を表示）。最下部追従（tail-follow）時、境界のイベントが
   * 丸ごとは収まらない場合に、そのイベントの末尾（＝より新しい部分）だけを残して先頭側を間引く
   * ことで、BOX を可能な限り埋める（件数単位ではなくハード改行単位で切る）。
   */
  startSkipHardLines: number
  /**
   * `endIndex - 1` のイベントについて、末尾から省略するハード改行区切り区間の個数（review-changes
   * 修正）。0 なら省略なし。途中スクロール中、境界のイベントが丸ごとは収まらない場合に、
   * そのイベントの先頭（＝現在位置に近い部分）だけを残して末尾側を間引く。
   */
  endSkipHardLines: number
}

/**
 * offset（表示ウィンドウ先頭 index）を有効範囲 `[0, max(0, total - visible)]` に丸める。
 *
 * スクロールキー処理（DetailView 側の React state 更新）で、下限 0・上限（最下部）を
 * はみ出さないよう共通利用する。
 *
 * @param total 取得済みイベント総数（表示配列の長さ）。
 * @param visible 一度に表示できる行数（{@link visibleRowsForHeight} の戻り値）。
 * @param offset 丸めたい offset。
 * @returns `[0, offsetForBottom(total, visible)]` に収めた整数 offset。
 */
export function clampOffset(total: number, visible: number, offset: number): number {
  const maxOffset = offsetForBottom(total, visible)
  return Math.min(Math.max(Math.floor(offset), 0), maxOffset)
}

/**
 * 最下部（最新イベントを末尾に表示する状態）の offset を返す。
 *
 * 初期スクロール位置（FR-02 AC-6）と、最下部にいる間の新着追従（FR-02 AC-7）で使う。
 * 全件が1画面に収まる（`total <= visible`）場合は 0。
 *
 * @param total 取得済みイベント総数。
 * @param visible 一度に表示できる行数。
 * @returns 最下部を表示する offset（`max(0, total - visible)`）。
 */
export function offsetForBottom(total: number, visible: number): number {
  return Math.max(0, total - visible)
}

/**
 * 現在の offset が最下部（最新を見ている状態）かどうかを判定する（FR-02 AC-7 の tail-follow 判定）。
 *
 * これが true の間だけ新着イベントに自動追従し、false（途中までスクロール中）なら
 * 現在位置を維持する。全件が収まる場合は常に最下部扱い（true）。
 *
 * @param total 取得済みイベント総数。
 * @param visible 一度に表示できる行数。
 * @param offset 現在の offset。
 * @returns 最下部にいれば true。
 */
export function isAtBottom(total: number, visible: number, offset: number): boolean {
  return offset >= offsetForBottom(total, visible)
}

/**
 * offset（表示ウィンドウ先頭 index）から表示スライス境界と範囲ラベルを算出する（FR-02 AC-4）。
 *
 * イベント配列は表示側で反転済み（古い順・最新が末尾、FR-02 AC-1）である前提。offset は
 * 内部で {@link clampOffset} により有効範囲へ丸めるため、呼び出し側は生の React state を
 * そのまま渡してよい。ラベルは1始まり両端含みの `X-Y of Z`（例 `25-34 of 34`）で、
 * Z は取得済み件数（上限 `RECENT_EVENTS_LIMIT`）であり DB の真の全件数ではない。
 * `visible` は 1 以上を前提とする（{@link visibleRowsForHeight} が最低 {@link MIN_VISIBLE_ROWS} を保証）。
 *
 * @param total 取得済みイベント総数（表示配列の長さ）。
 * @param visible 一度に表示できる行数。
 * @param offset 表示ウィンドウ先頭 index（丸め前でよい）。
 * @returns 表示スライス境界と範囲ラベルを含む {@link ScrollWindow}。
 */
export function windowForOffset(total: number, visible: number, offset: number): ScrollWindow {
  const startIndex = clampOffset(total, visible, offset)
  const endIndex = Math.min(startIndex + Math.max(0, visible), total)
  const visibleCount = endIndex - startIndex
  const rangeLabel = total === 0 ? '0 of 0' : `${startIndex + 1}-${endIndex} of ${total}`
  return {
    startIndex,
    endIndex,
    visibleCount,
    rangeLabel,
    startSkipHardLines: 0,
    endSkipHardLines: 0,
  }
}

/**
 * 折り返し（`wrap="wrap"`）表示時の 1 件分の行数を見積もる（release-6 FR-10 AC-3）。
 *
 * `box-border.ts` の {@link displayWidth}（East Asian Wide/Fullwidth 対応の表示桁数）を使い、
 * 単語境界（半角スペース）を尊重した貪欲折り返しをシミュレーションする。外部依存（wrap-ansi 等）は
 * 追加しない。
 *
 * review-changes 修正（重大な見落とし）: `tool_summary` 等のレポーター由来の自由記述には
 * 埋め込み改行（`\n`、例: URL/OGP プレビューの複数行テキスト）が含まれ得るが、当初の実装は
 * これを考慮せず「改行なしの1行」前提で全体を単語分割していた。改行は単語区切り文字
 * （半角スペース）にはマッチしないため、改行を含む1つの「巨大単語」として幅ベースの折り返し
 * 計算に丸められ、実際の改行による強制的な行分割ぶんが完全に無視されて行数を著しく過小評価
 * していた（実機で確認: 改行を多数含む tool_summary を持つイベントが1件でもあると、その1件だけで
 * 画面があふれ概要BOXが見えなくなる不具合として再現した）。
 *
 * 修正: まず `\n` で「強制改行区間」に分割し、各区間ごとに独立して単語境界の折り返しを計算し、
 * 区間ごとの行数を合算する（強制改行は width に関わらず必ず行を分ける）。
 *
 * 安全側（実際の Ink 描画より少なめに見積もらない）に倒すため（FR-10 AC-4）:
 * - 1 単語が `contentWidth` に収まらない場合、その巨大単語自体で複数行を消費させたうえで、
 *   直後の単語は必ず新しい行から始めさせる（実際の折り返しが単語内で改行できる場合より
 *   行数が少なくなることはあっても多くなることはない = 安全側）。
 *
 * @param text 折り返し前の表示テキスト（1 イベント分、プレーンテキスト。埋め込み改行を含みうる）。
 * @param contentWidth BOX の実効幅（罫線・padding を除いた表示桁数）。
 * @returns 折り返し後の行数（1 以上の整数）。
 */
export function estimateWrappedLineCount(text: string, contentWidth: number): number {
  const width = Math.max(1, Math.floor(contentWidth))
  if (text.length === 0) {
    return 1
  }
  // 強制改行（\n）で区間に分割し、各区間を独立に折り返す（改行は width によらず必ず行を分ける）。
  const hardLines = text.split('\n')
  let total = 0
  for (const hardLine of hardLines) {
    total += estimateWrappedLineCountForHardLine(hardLine, width)
  }
  return Math.max(1, total)
}

/**
 * 強制改行（`\n`）を含まない 1 区間の折り返し後行数を見積もる（{@link estimateWrappedLineCount} の内部処理）。
 *
 * `wrapAwareWindow` の境界イベント部分採用（review-changes 修正）でも、ハード改行区間ごとの
 * 行数を個別に知る必要があるため export する。
 *
 * @param line 強制改行を含まない1区間のテキスト（空文字列もありうる、その場合は空行として1行を消費する）。
 * @param width BOX の実効幅（{@link estimateWrappedLineCount} で正規化済み、1以上の整数）。
 * @returns この区間の折り返し後行数（1 以上の整数）。
 */
export function estimateWrappedLineCountForHardLine(line: string, width: number): number {
  const words = line.split(' ').filter((w) => w.length > 0)
  if (words.length === 0) {
    // 空行（連続する改行の間など）も画面上は1行分を消費する。
    return 1
  }
  let lines = 1
  let lineWidth = 0
  for (const word of words) {
    const wordWidth = displayWidth(word)
    if (wordWidth > width) {
      // 単語単体が1行に収まらない: 現在行に何か入っていれば確定して改行し、
      // 巨大単語ぶんの行数を積んだうえで、次の単語は新しい行から始める
      // （単語内で改行できる実際の折り返しより行数が少なくなることはない = 安全側）。
      if (lineWidth > 0) {
        lines += 1
      }
      lines += Math.ceil(wordWidth / width) - 1
      lineWidth = width
      continue
    }
    const spaceWidth = lineWidth > 0 ? 1 : 0
    if (lineWidth + spaceWidth + wordWidth > width) {
      lines += 1
      lineWidth = wordWidth
    } else {
      lineWidth += spaceWidth + wordWidth
    }
  }
  return lines
}

/**
 * 折り返しモードで、表示可能行数 `visible` を超えないよう表示件数を動的に絞った
 * スクロールウィンドウを返す（release-6 FR-10 AC-1・AC-2）。
 *
 * `lineCounts`（`texts` を {@link estimateWrappedLineCount} で見積もった行数、`texts` と同じ並び・
 * 長さ）を使い、{@link windowForOffset} が返す「1 件=1 行」前提の名目ウィンドウを起点に、
 * 実際に収まる件数だけへ削る:
 * - 最下部（tail-follow, {@link isAtBottom}）を見ている場合は名目ウィンドウの末尾（= 最新イベント）
 *   を起点に、そこから古い方向へ収まる件数だけ選ぶ（最新を必ず表示し続ける）
 * - 途中スクロール中は名目ウィンドウの先頭（= 現在の表示位置）を起点に、そこから新しい方向へ
 *   収まる件数だけ選ぶ（現在の表示位置を維持する）
 *
 * review-changes 修正（ユーザー指摘: 「スクロールできる＝BOX内の全行が埋まっている、のはず」）:
 * 以前は境界のイベントが丸ごとは収まらない場合、そのイベントを丸ごと除外していたため、
 * 実際に表示される合計行数が `visible` に満たず BOX に空白が残ることがあった（総イベント数と
 * 埋め込み改行を多く含む実データの組み合わせで顕著）。境界イベントは「丸ごと含める/丸ごと除外」の
 * 二択ではなく、`hardLineCountsOf` で得られるハード改行区間ごとの行数を使って部分採用する
 * （最下部追従時はそのイベントの末尾側、途中スクロール時は先頭側だけを残す）。これにより
 * 「スクロール中で見えている行はすべて BOX の枠いっぱいまで埋まっている」を実現する。
 * 1 件も確定していない状態で境界イベントの最後のハード改行区間 1 つすら収まらない場合でも、
 * その 1 区間は必ず含める（0 件表示という壊れた見た目を避けるフォールバック）。
 *
 * 範囲ラベル "X-Y of Z" は実際に表示する件数の範囲を反映し、Z は取得済み総件数のまま変えない
 * （FR-10 AC-2・FR-08 AC-3）。
 *
 * @param total 取得済みイベント総数（`lineCounts.length` と一致する前提）。
 * @param visible 一度に表示できる行数（{@link visibleRowsForHeight} の戻り値）。
 * @param offset 表示ウィンドウ先頭 index（丸め前でよい。{@link windowForOffset} と同じ）。
 * @param lineCounts 各イベントの折り返し後行数見積もり（`total` と同じ長さ、古い順）。
 * @param hardLineCountsOf 指定 index のイベントを、ハード改行（`\n`）区切り区間ごとの行数配列
 *   （区間の並び順、各要素は 1 以上）として返す。`sum(hardLineCountsOf(i)) === lineCounts[i]` を
 *   満たす前提。
 * @returns 折り返しモード用に件数を絞った {@link ScrollWindow}。
 */
export function wrapAwareWindow(
  total: number,
  visible: number,
  offset: number,
  lineCounts: readonly number[],
  hardLineCountsOf: (index: number) => readonly number[]
): ScrollWindow {
  if (total === 0) {
    return windowForOffset(total, visible, offset)
  }
  const nominal = windowForOffset(total, visible, offset)
  const atBottom = isAtBottom(total, visible, offset)

  let startIndex: number
  let endIndex: number
  let startSkipHardLines = 0
  let endSkipHardLines = 0

  if (atBottom) {
    // 最新（nominal.endIndex の1つ前）を起点に、古い方向へ収まる件数だけ選ぶ。
    let count = 0
    let usedLines = 0
    let idx = nominal.endIndex - 1
    while (idx >= 0) {
      const lines = lineCounts[idx] ?? 1
      const remaining = visible - usedLines
      if (remaining <= 0) break
      if (lines <= remaining) {
        usedLines += lines
        count += 1
        idx -= 1
        continue
      }
      // 丸ごとは収まらない: このイベントの末尾（より新しい）ハード改行区間から
      // remaining 行ぶんだけ部分採用する。1 件も確定していなければ最低 1 区間は強制的に含める。
      const perHardLine = hardLineCountsOf(idx)
      let hlUsed = 0
      let keepFromHardLine = perHardLine.length
      for (let h = perHardLine.length - 1; h >= 0; h -= 1) {
        const c = perHardLine[h] ?? 1
        if (hlUsed + c > remaining && keepFromHardLine < perHardLine.length) break
        hlUsed += c
        keepFromHardLine = h
        if (hlUsed >= remaining) break
      }
      if (keepFromHardLine < perHardLine.length) {
        count += 1
        startSkipHardLines = keepFromHardLine
      }
      break
    }
    endIndex = nominal.endIndex
    startIndex = endIndex - count
  } else {
    // 現在の表示位置（nominal.startIndex）を起点に、新しい方向へ収まる件数だけ選ぶ。
    let count = 0
    let usedLines = 0
    let idx = nominal.startIndex
    while (idx < total) {
      const lines = lineCounts[idx] ?? 1
      const remaining = visible - usedLines
      if (remaining <= 0) break
      if (lines <= remaining) {
        usedLines += lines
        count += 1
        idx += 1
        continue
      }
      // 丸ごとは収まらない: このイベントの先頭（現在位置に近い）ハード改行区間から
      // remaining 行ぶんだけ部分採用する。1 件も確定していなければ最低 1 区間は強制的に含める。
      const perHardLine = hardLineCountsOf(idx)
      let hlUsed = 0
      let keepUpToHardLine = 0
      for (let h = 0; h < perHardLine.length; h += 1) {
        const c = perHardLine[h] ?? 1
        if (hlUsed + c > remaining && keepUpToHardLine > 0) break
        hlUsed += c
        keepUpToHardLine = h + 1
        if (hlUsed >= remaining) break
      }
      if (keepUpToHardLine > 0) {
        count += 1
        endSkipHardLines = perHardLine.length - keepUpToHardLine
      }
      idx += 1
      break
    }
    startIndex = nominal.startIndex
    endIndex = startIndex + count
  }

  const visibleCount = endIndex - startIndex
  const rangeLabel = `${startIndex + 1}-${endIndex} of ${total}`
  return { startIndex, endIndex, visibleCount, rangeLabel, startSkipHardLines, endSkipHardLines }
}

/**
 * 折り返しモード時の表示ウィンドウを、イベントのプレーンテキスト表現から直接計算する
 * （release-6 FR-10）。{@link estimateWrappedLineCount} と {@link wrapAwareWindow} の合成で、
 * DetailView 側は「イベント1件分のプレーンテキスト配列」を渡すだけでよい。
 *
 * @param texts 各イベントの表示テキスト（`occurred_at`・`event_type` 等を結合したプレーンテキスト、
 *   古い順、{@link windowForOffset} が受け取る `events` 配列と同じ並び）。
 * @param contentWidth BOX の実効幅（{@link estimateWrappedLineCount} にそのまま渡す）。
 * @param visible 一度に表示できる行数。
 * @param offset 表示ウィンドウ先頭 index（丸め前でよい）。
 * @returns 折り返しモード用に件数を絞った {@link ScrollWindow}。
 */
export function wrapAwareWindowForTexts(
  texts: readonly string[],
  contentWidth: number,
  visible: number,
  offset: number
): ScrollWindow {
  const width = Math.max(1, Math.floor(contentWidth))
  const lineCounts = texts.map((text) => estimateWrappedLineCount(text, contentWidth))
  const hardLineCountsOf = (index: number): readonly number[] =>
    texts[index].split('\n').map((hardLine) => estimateWrappedLineCountForHardLine(hardLine, width))
  return wrapAwareWindow(texts.length, visible, offset, lineCounts, hardLineCountsOf)
}

/**
 * 埋め込み改行（`\n`）の個数から、切り詰め（`wrap="truncate-end"`）表示時の1件分の行数を数える
 * （review-changes 修正: FR-10 は折り返しモードのみを対象にしていたが、既定の切り詰めモードでも
 * `tool_summary` 等の埋め込み改行により「1件=1行」の前提が同様に崩れることが実機検証で判明した）。
 *
 * `wrap="truncate-end"` は改行区切りの各区間を独立に（区間ごとに幅を超えた分だけ "…" で）切り詰めるが、
 * 区間そのものを合体させない。そのため折り返し（単語境界での複数行化）は起きない一方、
 * 埋め込み改行の数だけ必ず行数が増える。行数は改行の個数+1（= `\n` で分割した区間数）。
 *
 * @param text 表示テキスト（1 イベント分、プレーンテキスト。埋め込み改行を含みうる）。
 * @returns 切り詰めモードでの行数（1 以上の整数）。
 */
export function countHardLines(text: string): number {
  if (text.length === 0) {
    return 1
  }
  return text.split('\n').length
}

/**
 * 切り詰めモードでも画面があふれないよう表示件数を動的に絞ったスクロールウィンドウを、
 * イベントのプレーンテキスト表現から直接計算する（release-6、review-changes 修正）。
 *
 * {@link countHardLines}（埋め込み改行の個数のみを見る。切り詰めモードでは単語境界の
 * 折り返しは起きないため {@link estimateWrappedLineCount} ほど厳密な見積もりは不要）と
 * {@link wrapAwareWindow} の合成。{@link wrapAwareWindowForTexts}（折り返しモード用）と対になる。
 *
 * @param texts 各イベントの表示テキスト（古い順、{@link windowForOffset} が受け取る配列と同じ並び）。
 * @param visible 一度に表示できる行数。
 * @param offset 表示ウィンドウ先頭 index（丸め前でよい）。
 * @returns 切り詰めモード用に件数を絞った {@link ScrollWindow}。
 */
export function hardLineAwareWindowForTexts(
  texts: readonly string[],
  visible: number,
  offset: number
): ScrollWindow {
  const lineCounts = texts.map((text) => countHardLines(text))
  // 切り詰めモードでは 1 ハード改行区間 = 1 行（単語折り返しは起きない）。
  const hardLineCountsOf = (index: number): readonly number[] =>
    texts[index].split('\n').map(() => 1)
  return wrapAwareWindow(texts.length, visible, offset, lineCounts, hardLineCountsOf)
}
