import { Box, Text } from 'ink'
import type { ReactElement } from 'react'

/**
 * `[key, description]` のヘルプ 1 行。
 *
 * 一覧ビューと詳細ビュー（Agent View Lv.1）でキーの意味が変わるものは説明にビューを明記し、
 * フッターヒント（{@link ./app-view.js#footerHint}）との不整合を無くす。`j`/`k`・`↑`/`↓` は
 * 一覧ではカーソル移動、詳細ではイベント履歴スクロール（release-6 FR-02 AC-3）。`←`/`→`（FR-04）と
 * `w`（折り返し切替, FR-08）は詳細ビュー専用。
 */
const HELP_LINES: ReadonlyArray<readonly [string, string]> = [
  ['1-5', '一覧: 状態フィルタのトグル（複数選択可）'],
  ['j / k, ↑ / ↓', '一覧: カーソル移動 / 詳細: イベント履歴スクロール'],
  ['Enter', '一覧: 詳細（Agent View Lv.1）を開く'],
  ['← / →', '詳細: 隣接プロジェクトへ移動'],
  ['w', '詳細: イベント行の折り返し/切り詰め切替'],
  ['esc', '戻る / ヘルプを閉じる'],
  ['?', 'ヘルプの表示/非表示'],
  ['q', '終了'],
]

/**
 * {@link HelpOverlay} 本体（`borderStyle="round"` の上下罫線2行 + タイトル1行 + {@link HELP_LINES}）
 * が消費する表示行数（review-changes 修正）。
 *
 * detail ビュー表示中に `?` でヘルプを開くと、AppView は DetailView の下に
 * `<Box marginTop={1}><HelpOverlay /></Box>` を追加で積む。DetailView 自身は
 * `event-scroll.js#DETAIL_RESERVED_ROWS` から「ヘルプ非表示」前提で表示行数
 * （`visible`）を計算しているため、ヘルプの分（本定数 + AppView 側の marginTop 1 行）を
 * 追加で差し引かないと、合計描画行数が端末行数を超えて上部（ヘッダー・概要BOX）が
 * スクロールして見えなくなる（実機で確認済み）。AppView は本定数 + 1（marginTop）を
 * {@link ../components/detail-view.js#DetailViewProps.extraReservedRows} として渡す。
 */
export const HELP_OVERLAY_ROWS = HELP_LINES.length + 3

/**
 * キーバインドの一覧を出すヘルプオーバーレイ（§10.3、presentational）。
 *
 * props を取らず、固定のキー説明を描くだけ。表示/非表示の制御は AppView が持つ。
 *
 * @returns ヘルプオーバーレイの要素。
 */
export function HelpOverlay(): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>キーバインド</Text>
      {HELP_LINES.map(([key, description]) => (
        <Text key={key}>
          <Text color="cyan">{key.padEnd(16)}</Text>
          {description}
        </Text>
      ))}
    </Box>
  )
}
