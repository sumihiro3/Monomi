import { Box, Text, useInput, useStdout } from 'ink'
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { InstanceDetail, InstanceStatusRow, RecentEventDto } from '../../hub/dto.js'
import { t } from '../../i18n/index.js'
import { bottomBorderWithLabel, resolveBoxWidth, topBorderWithTitle } from '../box-border.js'
import {
  clampOffset,
  DETAIL_RESERVED_ROWS,
  hardLineAwareWindowForTexts,
  offsetForBottom,
  type ScrollWindow,
  visibleRowsForHeight,
  wrapAwareWindowForTexts,
} from '../event-scroll.js'
import type { HubApiClient } from '../hub-api-client.js'
import { PollingLoop } from '../polling-loop.js'
import { sanitizeDisplayText, sanitizeNullableDisplayText } from '../sanitize-display-text.js'
import { formatAge, statusColor, statusGlyph, statusLabel } from '../status-display.js'

/**
 * イベント行の表示モード（FR-08）。`truncate-end` は 1 行に切り詰め（既定）、`wrap` は全文折り返し。
 * どちらも Ink の `Text` の `wrap` prop（`Styles['textWrap']`）へそのまま渡せる値に一致させている。
 */
type WrapMode = 'truncate-end' | 'wrap'

/**
 * イベント履歴のスクロール位置（review-changes 修正）。
 *
 * `following: true` の間は表示ウィンドウ先頭 index を state に持たず、毎レンダー
 * `offsetForBottom(total, visible)` から新鮮に導出する（tail-follow、FR-02 AC-7）。
 * `following: false` のときだけ `offset`（手動スクロール中の表示ウィンドウ先頭 index）が意味を持つ。
 * `k`/上矢印は1回でも即座に手動スクロールへ切り替える（ユーザー判断: 「2回連続で初めて手動」は
 * 挙動が伝わりにくいため撤回）。
 */
type ScrollPosition = { following: true } | { following: false; offset: number }

/**
 * イベント履歴 BOX が罫線・padding で消費する表示桁数（FR-10 AC-3）。
 *
 * `borderStyle="round"` の左右 `│`（2桁）+ `paddingX={1}` の左右余白（2桁）= 4桁。
 * `resolveBoxWidth` が返す BOX 幅からこれを引いた値が、イベント本文が実際に使える表示幅
 * （`estimateWrappedLineCount` に渡す `contentWidth`）になる。
 */
const EVENT_BOX_CHROME_WIDTH = 4

/** {@link DetailView} の props（container: 自身で詳細を取得する）。 */
export interface DetailViewProps {
  /** 詳細取得に使う hub クライアント。 */
  client: HubApiClient
  /** 一覧で選択された行（詳細取得前のヘッダ表示・フォールバックに使う）。 */
  row: InstanceStatusRow
  /** 自動更新のポーリング間隔（一覧と同じ値を配線する。FR-05 AC-1）。 */
  pollIntervalMs: number
  /**
   * DetailView の外側（AppView）が追加で描画する行数（review-changes 修正）。
   * detail ビュー表示中に `?` でヘルプを開くと、AppView は DetailView の下に
   * `HelpOverlay` を追加で積むため、その分をここで受け取って表示行数（`visible`）の
   * 計算から差し引く。ヘルプ非表示なら 0（省略時の既定値）。
   */
  extraReservedRows?: number
}

/**
 * 詳細ビュー（Agent View Lv.1、§10.4 / release-6 FR-01・FR-02・FR-04）。container。
 *
 * 上部にプロジェクト概要の `borderStyle="round"` BOX（instance_id・project・device・branch・
 * status〈色付きグリフ＋ラベル＋経過時間〉・session_id・path・pr、FR-01）、下部にスクロール
 * 可能なイベント履歴の `borderStyle="round"` BOX（FR-02）を積む。イベントは hub 契約（新しい順、
 * 不変）を CLI 表示側で反転し、ターミナルログ風の古い順・最新末尾で描く（FR-02 AC-1）。
 *
 * 両 BOX は端末幅一杯（{@link ../box-border.js#resolveBoxWidth}）に固定し、Ink の上辺（イベント
 * 履歴は下辺も）罫線を `borderTop`/`borderBottom={false}` で切り離して、{@link ../box-border.js} が
 * 生成するタイトル入り罫線に差し替える。上辺に「概要」「イベント履歴」を左寄せ（FR-06）、
 * イベント履歴 BOX の下辺に範囲ラベル "X-Y of Z" を右寄せで埋め込む（FR-07）。概要 BOX の各
 * フィールドは `wrap="truncate-end"` で 1 行＝高さ固定にし、スクロール操作で動かない（FR-05）。
 *
 * 一覧と同じ {@link PollingLoop} を再利用し、`pollIntervalMs` 間隔で
 * {@link HubApiClient.getInstanceDetail} を呼び直して概要とイベントを自動更新する（FR-05 AC-1）。
 * `start()` が内部で即時取得するため初回表示は打鍵不要で出る（FR-05 AC-2）。アンマウント時に確実に
 * `stop()` する（FR-05 AC-3）。取得失敗しても直前の detail は消さず、初回ロード失敗時のみエラーを
 * 前面に出す（FR-05 AC-4）。status 導出は hub 側の結果をそのまま描くだけで CLI では持たず、
 * 状態色・グリフ・ラベル・age 整形は {@link ../status-display.js} を再利用する（§0.5 / FR-01 AC-3）。
 *
 * スクロール位置は「表示ウィンドウ先頭 index を state に持って総件数変化で再ピン留めする」方式
 * ではなく、`scrollPosition`（{@link ScrollPosition}、最下部を追従中かどうかを表す `following`
 * boolean を中心にした state）で管理する（review-changes 修正）。旧方式は hub の直近イベント取得
 * 上限（`RECENT_EVENTS_LIMIT`）に達すると総件数が変化しなくなり、再ピン留めの契機自体が失われて
 * 追従が壊れたまま固定される不具合があった（長時間セッションの実機で再現・確認済み）。
 * `scrollPosition.following===true` の間は毎レンダー `offsetForBottom(total, visible)` から新鮮に
 * 位置を再計算するため、総件数が据え置きのまま裏でイベント配列の中身だけがスライドしていても常に
 * 正しく最新へ追従する（記憶した値と実際の状態がズレて固定される、という構造的な脆弱性そのものを
 * 解消している）。端末高さ（`useStdout().stdout.rows`）を
 * {@link ../event-scroll.js#visibleRowsForHeight} に渡して表示行数を可変にし、非TTY・`rows` 未取得
 * なら固定行にフォールバックする（FR-02 AC-5）。`k`（上/古い方向）で1回でも即座に手動スクロールへ
 * 切り替わり、`j`（下/新しい方向）で最下部まで戻ると自動追従へ復帰する（FR-02 AC-6・AC-7）。
 * 自身で `useInput` を持ち `j`/`k`・`↑`/`↓` で 1 行スクロールし、`w` でイベント行の切り詰め⇔折り返しを
 * トグルする（`wrapMode`、FR-08）。`←`/`→`・`1`-`5`・`Enter`・`esc` は無視（詳細⇄一覧の遷移と隣接移動は
 * AppView / KeyBindingController の関心事、FR-02 AC-3）。折り返しモード中は 1 件が複数行に跨るため、
 * {@link ../event-scroll.js#wrapAwareWindowForTexts} で折り返し後の行数見積もり（単語境界の折り返しも
 * 考慮）に基づき表示件数を動的に絞る（FR-10）。review-changes 修正: `tool_summary` 等に埋め込み改行
 * （例: URL/OGP プレビューの複数行テキスト）が含まれると、既定の切り詰め（truncate-end）モードでも
 * Ink は改行区切りの各区間を独立した行として描画するため「1件=1行」の前提が同様に崩れる。切り詰め
 * モードでは {@link ../event-scroll.js#hardLineAwareWindowForTexts}（改行の個数のみを見る、単語折り返しは
 * 起きないため）で同じ絞り込みを行う。どちらのモードでもイベント履歴 BOX の高さが `visible` を超えず、
 * ヘッダー・概要BOXは常に固定表示される（FR-05 AC-4・FR-08 AC-2 の当初の例外は撤回済み）。範囲ラベルは
 * 実際に表示している件数の範囲を反映しつつ、Z は取得済みイベント件数基準のまま変わらない
 * （FR-08 AC-3・FR-10 AC-2）。
 * Ink の `useInput` は複数コンポーネントで競合なく共存する（AppView の入力とは別ハンドラ）。
 *
 * @param props {@link DetailViewProps}。
 * @returns 詳細ビューの要素。
 */
export function DetailView({
  client,
  row,
  pollIntervalMs,
  extraReservedRows = 0,
}: DetailViewProps): ReactElement {
  const [detail, setDetail] = useState<InstanceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // review-changes 修正（重大な見落とし）: 以前は「表示ウィンドウ先頭 offset（生の index）」を
  // React state に持ち、新着イベント検知を「total か visible が変わったら useEffect で offset を
  // 再ピン留めする」方式にしていた。この方式には構造的な欠陥があった: hub の直近イベント取得上限
  // （RECENT_EVENTS_LIMIT=100）に達すると、以後は新しいイベントが増えても total は 100 のまま
  // 変わらなくなる（古いイベントが押し出されるだけで件数は一定）。そのため total 変化を唯一の
  // トリガにしていた useEffect は上限到達後 二度と発火しなくなり、その瞬間の offset の値が
  // （何らかの理由で真の最下部からわずかにでもズレていた場合）以後ずっと固定されてしまい、
  // 新着追従が壊れた状態が永続する（実機の長時間セッションで再現・確認済み）。
  //
  // 修正: 「表示ウィンドウ先頭 index」を state として持つのをやめ、代わりに「最下部を追従中か
  // どうか」を表す boolean を持つ ScrollPosition という単純な状態にする。追従中は毎レンダー
  // offsetForBottom(total, visible) から新鮮に再計算するため、total が据え置きのまま裏で
  // イベント配列の中身だけがスライドしても（=hub上限到達後の定常状態）常に正しく最新を指す。
  // 「前回の状態を記憶して差分を見る」という壊れやすい仕組みそのものを無くしている。
  // 追従フラグと手動 offset を1つの state にまとめているのは、`j`/`k` の連打（同一 tick 内で
  // 複数回 dispatch される場合がある）で state 更新関数に古いクロージャ値を渡さないため。
  // setScrollPosition は必ず関数形（`current => ...`）で呼び、React が管理する最新値を使う。
  const [scrollPosition, setScrollPosition] = useState<ScrollPosition>({ following: true })
  // イベント行の切り詰め/折り返しモード（FR-08）。初期は切り詰め（FR-08 AC-4）。ユーザーが `w` で
  // 明示選択する状態なので、対象 instance が変わっても（下の instance 変化 effect ではリセットせず）
  // 永続させる。隣接プロジェクト移動や詳細再入場をまたいでモードを保つ（FR-08 AC-5 の実装判断）。
  const [wrapMode, setWrapMode] = useState<WrapMode>('truncate-end')

  useEffect(() => {
    let cancelled = false
    // 対象 instance / client / 間隔が変わったら直前 detail を捨ててから張り直す。
    setDetail(null)
    setError(null)
    // FR-04 AC-4: 対象 instance 変化時にスクロールを初期化する（最下部から表示、FR-02 AC-6）。
    setScrollPosition({ following: true })
    // 一覧側と同じ機構を再利用（FR-05 AC-1）。詳細は固定 client でよいので reresolve は渡さない。
    const loop = new PollingLoop<InstanceDetail>(
      (c) => c.getInstanceDetail(row.instance_id),
      client,
      pollIntervalMs
    )
    loop.onUpdate((fetched) => {
      if (cancelled) return
      setDetail(fetched)
      setError(null)
    })
    loop.onError((err) => {
      // FR-05 AC-4: 直前の detail は消さない。error は初回ロード失敗時のみ描画で前面に出す。
      if (cancelled) return
      setError(String(err))
    })
    // start() は内部で即時 refresh するため初回表示は維持される（FR-05 AC-2）。
    loop.start()
    return () => {
      // アンマウントで確実にポーリングを止める（FR-05 AC-3）。
      cancelled = true
      loop.stop()
    }
  }, [client, row.instance_id, pollIntervalMs])

  // 取得済みの detail があればそれを、なければ選択行を概要 BOX のソースにする（FR-01 AC-2）。
  // ポーリングで detail が更新されると status/branch/pr 等も追従する（FR-05 AC-1）。
  const source = detail ?? row

  // hub は recent_events を新しい順で返す（API 契約は不変）。表示側でのみ反転し、
  // 古い順・最新末尾のターミナルログ風にする（FR-02 AC-1）。detail 未取得時は空。
  const events = useMemo(
    () => (detail === null ? [] : [...detail.recent_events].reverse()),
    [detail]
  )
  const total = events.length

  const { stdout } = useStdout()
  // 端末桁数 → BOX 幅（FR-06 AC-3）。columns 未取得（非TTY 等）は固定幅へフォールバックする。
  // 両 BOX にこの幅を付与し、自前タイトル/ラベル罫線（box-border）の桁と揃える。
  const boxWidth = resolveBoxWidth(stdout.columns, Boolean(stdout.isTTY))
  // イベント履歴 BOX の実効幅（罫線2桁 + paddingX={1}の左右2桁を除いた表示桁数、FR-10 AC-3）。
  // wrapMode==='wrap' 時の折り返し行数見積もり（estimateWrappedLineCount）にのみ使う。
  const contentWidth = Math.max(1, boxWidth - EVENT_BOX_CHROME_WIDTH)
  // 端末高さ → 表示行数（FR-02 AC-5）。rows 未取得（非TTY 等）は固定行へフォールバックする。
  // review-changes 修正: extraReservedRows（AppView が detail の下にヘルプを追加で積む分）も
  // 差し引くことで、ヘルプ表示中も合計描画行数が端末行数を超えず、ヘッダー・概要BOXが
  // スクロールして見えなくなることを防ぐ。
  const visible = visibleRowsForHeight(
    stdout.rows,
    Boolean(stdout.isTTY),
    DETAIL_RESERVED_ROWS + extraReservedRows
  )

  // following=true の間は毎レンダー最下部を新鮮に再計算する（FR-02 AC-6・AC-7）。
  // total（イベント件数）が hub の取得上限で頭打ちになって変化しなくなっても、この式は
  // 「今の total・visible」から都度導出するため、裏でイベント配列の中身がスライドしていても
  // 常に正しく最新へ追従する（値を記憶して差分検知する仕組みを持たないため、ズレて固定される
  // ことがない）。
  const offset = scrollPosition.following
    ? offsetForBottom(total, visible)
    : clampOffset(total, visible, scrollPosition.offset)

  // FR-02 AC-3: j/k・↑/↓ で 1 行スクロール。FR-08: `w` でイベント行の切り詰め⇔折り返しをトグル
  // する（release-4 の watch トグル撤去後は未使用のキーで衝突なし）。
  // ←/→・1-5・Enter・esc はここでは無視する（詳細⇄一覧・隣接移動・フィルタは AppView / controller が握る）。
  // review-changes 修正: `j`/`k` を連打すると同一 tick 内で複数回 dispatch されることがあり、
  // state を直接クロージャで読んで更新すると（`scrollPosition` を外側スコープから参照する形だと）
  // 各呼び出しが同じ古い値を見て後続の押下が反映されない不具合があった。`setScrollPosition` を
  // 必ず関数形（`current => ...`）で呼び、React が管理する最新値のみを基準に計算する。
  useInput((input, key) => {
    if (input === 'j' || key.downArrow) {
      setScrollPosition((current) => {
        // 最下部へ向かう方向。既に追従中なら何もしない（既に最下部）。
        if (current.following) return current
        const next = clampOffset(total, visible, current.offset + 1)
        // 手動位置が最下部に達したら、以後は再び自動追従（following）に戻す。
        return next >= offsetForBottom(total, visible)
          ? { following: true }
          : { following: false, offset: next }
      })
    } else if (input === 'k' || key.upArrow) {
      setScrollPosition((current) => {
        // 古い方向。現在の実効位置（追従中なら最下部）を起点に、1 回でも即座に手動スクロールへ
        // 切り替える（ユーザー判断: 「複数回連続で初めて手動」は挙動が伝わりにくいため撤回）。
        const currentOffset = current.following ? offsetForBottom(total, visible) : current.offset
        return { following: false, offset: clampOffset(total, visible, currentOffset - 1) }
      })
    } else if (input === 'w') {
      setWrapMode((mode) => (mode === 'truncate-end' ? 'wrap' : 'truncate-end'))
    }
  })

  // FR-10 + review-changes 修正: 1件=1行の名目ウィンドウ（windowForOffset）をそのまま使うと、
  // イベント本文（tool_summary 等）に埋め込み改行が含まれる場合に実際の行数が visible を超えて
  // 画面があふれ、固定表示のはずのヘッダー・概要BOX（FR-05）がスクロールして見えなくなる。
  // これは折り返しモードに限らず、既定の切り詰め（truncate-end）モードでも起きる（Ink の
  // wrap="truncate-end" は改行区切りの各区間を独立に切り詰めるだけで、区間そのものは合体させない
  // ため、埋め込み改行の個数だけ必ず行数が増える。実機検証で確認済み）。
  // 折り返しモードは行数見積もり（estimateWrappedLineCount、単語境界の折り返しも考慮）で
  // wrapAwareWindowForTexts を、切り詰めモードは改行の個数のみ（countHardLines）で
  // hardLineAwareWindowForTexts を使い、どちらも収まる件数だけに絞る。
  const scrollWindow: ScrollWindow =
    wrapMode === 'wrap'
      ? wrapAwareWindowForTexts(events.map(eventLineText), contentWidth, visible, offset)
      : hardLineAwareWindowForTexts(events.map(eventLineText), visible, offset)
  const visibleEvents = events.slice(scrollWindow.startIndex, scrollWindow.endIndex)

  return (
    <Box flexDirection="column">
      {/* 上部: プロジェクト概要 BOX（FR-01 AC-1・FR-05・FR-06）。上辺罫線はタイトル「概要」を
          埋め込んだ自前行に置換し（borderTop=false）、幅を端末一杯に固定する（FR-06 AC-1/AC-3）。
          release-9-i18n FR-02: タイトルは t('detail.overview') で解決する（en 訳語は ASCII の
          "Overview"）。box-border.ts の displayWidth は全角/半角どちらも表示桁数を計算済みのため、
          en の ASCII タイトルに切り替わっても罫線と角文字（╮）のずれは生じない（box-border 側の
          変更は不要）。 */}
      <Text>{topBorderWithTitle(boxWidth, t('detail.overview'))}</Text>
      <Box
        borderStyle="round"
        borderTop={false}
        width={boxWidth}
        flexDirection="column"
        paddingX={1}
      >
        <Field label="instance_id">
          <Text>{source.instance_id}</Text>
        </Field>
        <Field label="project">
          <Text bold>{source.project.name}</Text>
        </Field>
        <Field label="device">
          <Text>{source.device.name}</Text>
        </Field>
        <Field label="branch">
          <Text>{sanitizeNullableDisplayText(source.branch) ?? '-'}</Text>
        </Field>
        <Field label="status">
          <Text color={statusColor(source.status.display)}>
            {statusGlyph(source.status.display)} {statusLabel(source.status.display)}
          </Text>
          <Text dimColor>
            {' '}
            ({t('detail.elapsedSuffix', { age: formatAge(source.status.elapsed_seconds) })})
          </Text>
        </Field>
        <Field label="session_id">
          <Text>{sanitizeDisplayText(source.session.id)}</Text>
        </Field>
        <Field label="path">
          <Text>{sanitizeDisplayText(source.path)}</Text>
        </Field>
        <Field label="pr">
          <Text>{source.pr.state}</Text>
        </Field>
      </Box>

      {/* 下部: スクロール可能なイベント履歴 BOX（FR-02・FR-06・FR-07）。上辺はタイトル「イベント履歴」、
          下辺は範囲ラベル "X-Y of Z" を右寄せで埋め込んだ自前罫線に置換し（borderTop/Bottom=false）、
          左右 │ だけを Ink に描かせる。overview→events の marginTop はここ 1 箇所で、event-scroll の
          DETAIL_RESERVED_BREAKDOWN.sectionGaps が数える 3 箇所の 1 つ。
          review-changes 修正: BOX に高さを指定せず内容量に任せていたため、
          hardLineAwareWindowForTexts/wrapAwareWindowForTexts が「収まる件数」を選ぶ都合上
          （次の1件を足すと visible を超える場合はそこで打ち切る）、実際に表示される合計行数が
          visible より少なくなることがあり、スクロール位置によって BOX の高さが伸縮して見えた。
          `height={visible}` で高さを固定し、内容が visible に満たない分は自動的に空白で埋まる
          （Box の子要素がその行数に満たなくても Yoga レイアウトが空きを残すだけで、高さの伸縮は
          起きない）。`overflow="hidden"` は、1件のイベント単体が visible を超える縁的ケース
          （常に最低1件は表示するフォールバック）でも高さを visible ちょうどに強制し、
          そのケースで残っていたわずかな画面あふれも合わせて解消する。 */}
      <Box flexDirection="column" marginTop={1}>
        {/* release-9-i18n FR-02: タイトルは t('detail.eventHistory') で解決する（en 訳語は ASCII の
            "Event History"）。box-border.ts の displayWidth 計算は変更不要（上の概要 BOX 参照）。 */}
        <Text>{topBorderWithTitle(boxWidth, t('detail.eventHistory'))}</Text>
        <Box
          borderStyle="round"
          borderTop={false}
          borderBottom={false}
          width={boxWidth}
          height={visible}
          overflow="hidden"
          flexDirection="column"
          paddingX={1}
        >
          {/* FR-05 AC-4: detail 取得後はバックグラウンド失敗で error が立っても events を出し続け、
              error を前面に出すのは detail が null のまま（初回ロード失敗）のときだけにする。 */}
          {detail !== null ? (
            total === 0 ? (
              <Text dimColor>{t('detail.noEvents')}</Text>
            ) : (
              // window で切り出した可視分のみを古い順（上）→ 新しい順（下）で描く（FR-02 AC-1）。
              // wrap は wrapMode に従う（FR-08）: 'truncate-end' で 1 行固定、'wrap' で全文折り返し。
              // 折り返し時は 1 件が複数行に跨るが、scrollWindow は wrapAwareWindowForTexts が
              // visibleEvents の折り返し後合計行数が visible を超えないよう件数を絞った結果なので、
              // BOX 高さは可変にならず固定のまま（FR-10）。範囲ラベル "X-Y of Z" は行数ではなく
              // 実際に表示している件数の範囲を反映する（Z は取得済み件数基準のまま, FR-08 AC-3・FR-10 AC-2）。
              //
              // key に wrapMode を含めて「トグル時に Text を作り直す」のが要点。Ink は `wrap` 変更を
              // style 差し替え（dom.js setStyle）で処理するが、これは Yoga ノードを markDirty しない。
              // テキスト本文が不変だと Yoga の測定キャッシュ（前回 truncate 時の 1 行分の高さ）が残り、
              // wrap='wrap' にしても再測定されず折り返しが反映されない。key を変えて再マウントすると
              // 新しい ink-text ノード（新しい measure func）で正しい textWrap で測り直される。
              // review-changes 修正: event_subtype・tool_name・tool_summary はレポーター由来の
              // 自由記述（tool_summary は切り詰めた tool_input）で、ANSI/制御文字注入の経路になり
              // 得るため描画前にサニタイズする（sanitize-display-text.ts）。event_type は
              // z.enum(EVENT_TYPES) で固定値のみ許可されるため注入経路にならず対象外。
              //
              // review-changes 修正（重大な見落とし）: 埋め込み改行を含む1つの `<Text>` に対して
              // `wrap="truncate-end"` を指定すると、Ink は改行区切りの各区間を独立に切り詰める
              // わけではなく、先頭の区間だけで表示幅を超えた場合に「以降の区間ごと」丸ごと
              // 描画を打ち切ることが実機検証で判明した（例:
              // `tool_summary` の1行目が長いコマンド文字列で表示幅を超え、2行目以降の有用な
              // 情報〈OGPプレビュー本文等〉が完全に不可視になった上、event-scroll.ts の行数見積もり
              // （`countHardLines`/`estimateWrappedLineCount` は「各区間は独立して必ず1行以上を
              // 消費する」前提）と実描画がズレて、BOX に余白が残る形で件数が過小に絞られていた）。
              // 修正: イベント本文（`eventLineText` 相当）をハード改行区間ごとに分割し、区間ごとに
              // 独立した `<Text>` 要素として描画する。各区間は他の区間の幅超過に影響されず、
              // 自身の内容だけで独立に切り詰め/折り返しされるため、行数見積もりとの整合性が保たれる。
              // 先頭区間（`occurred_at`/`event_type`/`tool_name` 等のプレフィックスを含む）だけは
              // 従来通りフィールドごとに色分けし、2区間目以降は平文（`dimColor`）で描く。
              // `eventLineText` の1区間目は「プレフィックス + tool_summary の1行目」を結合した
              // ものなので、`tool_summary` 自身の行配列（summaryLines）とはインデックスが1つずれる
              // （summaryLines[i] は i>=1 のとき hardLines[i] と一致するが、i=0 は結合されている）。
              // startSkipHardLines/endSkipHardLines はハード改行区間（hardLines）単位の値だが、
              // summaryLines に対してもそのまま slice でき、プレフィックスを表示するかどうかは
              // 「1区間目（プレフィックス込み）が間引かれていないか」＝ startSkip===0 で判定できる
              // （i=0 を落とす slice(startSkip) は summaryLines に対しても同じ添字で正しく働く。
              // i>=1 の対応関係がそのまま summaryLines にも当てはまるため）。
              visibleEvents.map((event, i) => {
                const startSkip = i === 0 ? scrollWindow.startSkipHardLines : 0
                const endSkip = i === visibleEvents.length - 1 ? scrollWindow.endSkipHardLines : 0
                const summaryLines =
                  event.tool_summary !== null ? event.tool_summary.split('\n') : []
                const keptSummaryLines = summaryLines.slice(
                  startSkip,
                  summaryLines.length - endSkip
                )
                const showPrefix = startSkip === 0
                return (
                  <Box key={`${event.id}:${wrapMode}`} flexDirection="column">
                    {showPrefix ? (
                      <Text wrap={wrapMode}>
                        <Text dimColor>{event.occurred_at} </Text>
                        {event.event_type}
                        {event.event_subtype !== null ? (
                          <Text dimColor> ({sanitizeDisplayText(event.event_subtype)})</Text>
                        ) : null}
                        {event.tool_name !== null ? (
                          <Text color="cyan"> {sanitizeDisplayText(event.tool_name)}</Text>
                        ) : null}
                        {event.tool_summary !== null ? (
                          <Text dimColor>: {sanitizeDisplayText(keptSummaryLines[0] ?? '')}</Text>
                        ) : null}
                      </Text>
                    ) : null}
                    {(showPrefix ? keptSummaryLines.slice(1) : keptSummaryLines).map((line, li) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 区間は同一イベント内で並び替わらず安定
                      <Text key={li} dimColor wrap={wrapMode}>
                        {/* review-changes 修正（重大な見落とし）: 空行（連続する埋め込み改行の間の
                            空区間）を空文字列のまま独立した <Text> として描画すると、Ink はその
                            要素の高さを 0 に潰し、行数見積もり（countHardLines/
                            estimateWrappedLineCount は空行も1行として数える）と実描画がズレて
                            表示件数が過小に絞られる（実機で確認: BOX の下端に1行分の空白が残った）。
                            半角スペース1文字にフォールバックし、必ず1行ぶんの高さを確保する。 */}
                        {sanitizeDisplayText(line) || ' '}
                      </Text>
                    ))}
                  </Box>
                )
              })
            )
          ) : error !== null ? (
            <Text color="red">{t('detail.fetchFailed', { error })}</Text>
          ) : (
            <Text dimColor>{t('detail.loading')}</Text>
          )}
        </Box>
        {/* FR-07: 範囲ラベル "X-Y of Z" を下辺罫線へ右寄せで埋め込む（BOX 内の独立ラベル行は廃止）。
            Z は hub が取得済みのイベント件数で、取得上限 RECENT_EVENTS_LIMIT（現状 100、
            src/hub/instance-status-service.ts）で頭打ちになる。DB の真の全件数ではない。 */}
        <Text>{bottomBorderWithLabel(boxWidth, scrollWindow.rangeLabel)}</Text>
      </Box>
    </Box>
  )
}

/**
 * ラベル + 値の 1 行（概要 BOX のメタ情報表示に使う内部 presentational）。
 *
 * 行全体に `wrap="truncate-end"` を付け、長い値（path・session_id 等）や status 行の複数子でも
 * 折り返さず 1 行＝高さ固定にする（FR-05 AC-2）。BOX に確定幅（`width={boxWidth}`）が入って初めて
 * 切り詰めが効くため、概要 BOX の幅指定と対で機能する（instance-card.tsx と同じパターン）。
 *
 * @param props ラベルと子要素。
 * @returns 整形済みの 1 行。
 */
function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{label.padEnd(12)}</Text>
      {children}
    </Text>
  )
}

/**
 * イベント 1 件のプレーンテキスト表現を組み立てる（release-6 FR-10 用、測定専用）。
 *
 * JSX 側（{@link DetailView} 内の `visibleEvents.map`）が実際に描画する `occurred_at` / `event_type` /
 * `event_subtype` / `tool_name` / `tool_summary` の結合順・区切り記号（スペース・括弧・コロン）を
 * そのまま文字列として再現する。色付け（`dimColor`/`color="cyan"`）は表示幅に影響しないため、
 * このプレーンテキストへ {@link ../event-scroll.js#estimateWrappedLineCount} を適用した見積もりは
 * 実際の描画と表示幅の面で一致する。サニタイズ（`sanitize-display-text.ts`）は実描画側でのみ行えば
 * よく（表示幅はサニタイズ前後で変わらない制御文字/ANSI除去のため）、ここでは行わない。
 *
 * @param event 直近イベント 1 件（表示側で反転済みの配列要素）。
 * @returns 折り返し行数見積もり用のプレーンテキスト。
 */
function eventLineText(event: RecentEventDto): string {
  let text = `${event.occurred_at} ${event.event_type}`
  if (event.event_subtype !== null) {
    text += ` (${event.event_subtype})`
  }
  if (event.tool_name !== null) {
    text += ` ${event.tool_name}`
  }
  if (event.tool_summary !== null) {
    text += `: ${event.tool_summary}`
  }
  return text
}
