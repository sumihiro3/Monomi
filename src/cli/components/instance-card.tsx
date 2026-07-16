import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { FALLBACK_BOX_WIDTH } from '../box-border.js'
import { sanitizeDisplayText, sanitizeNullableDisplayText } from '../sanitize-display-text.js'
import {
  formatAge,
  formatRunningWorkAge,
  statusColor,
  statusGlyph,
  statusLabel,
} from '../status-display.js'
import { terminalDisplayName } from '../terminal-display.js'
import { collapseHomeDir, truncateMiddle } from '../truncate-path.js'

/**
 * カードの罫線・`paddingX={1}` が消費する表示桁数（FR-05）。
 *
 * `width` prop は Ink の `Box` の外形幅（罫線込み）で、実測（instance-card.test.tsx）でも
 * `╭` 〜 `╮` の総幅が `width` と一致することを確認済み。内訳: `borderStyle`（round/double
 * いずれも）の左右罫線 2 桁 + `paddingX={1}` の左右余白 2 桁 = 計 4 桁。`detail-view.tsx` の
 * `EVENT_BOX_CHROME_WIDTH`（同じく 4）と同じ計算式を踏襲する。ここを実際のクロム幅より
 * 小さく見積もると、`truncateMiddle` が生成した `先頭…末尾` の省略結果を Ink の
 * `wrap="truncate-end"` がさらに末尾から機械的に切り詰めてしまい、`…-23/…` のような
 * 二重の省略記号が現れてレイアウトの意図（末尾の識別子を温存する）が崩れる
 * （実装時に実描画で確認して判明、要件文書の「paddingX 分のみを引く」という素朴な想定を修正）。
 */
const CARD_CHROME_WIDTH = 4

/** {@link InstanceCard} の props（presentational）。 */
export interface InstanceCardProps {
  /** 描画対象の instance 行（フィルタ適用後の 1 件）。 */
  row: InstanceStatusRow
  /** 選択カーソルがこのカード上にあるか（ボーダー種別・色で視覚区別する、FR-01 AC-2 / release-10 FR-04）。 */
  selected: boolean
  /**
   * カードの表示幅（列数）。グリッド（{@link ./instance-table.js}）が
   * `columnsForWidth` に基づき算出した 1 枚あたりの幅を渡す。未指定なら内容幅に従う。
   */
  width?: number
}

/**
 * 1 instance = 1 枚のボーダー付きカード（§10.2 / FR-01、presentational）。
 *
 * タイトル行に project 名（bold）、本文に device 名 / branch（null は `-`）/
 * 状態（色付きグリフ + ラベル）+ 経過時間を縦積みで描く（FR-01 AC-1）。選択中は
 * `borderStyle="double"`（二重線）+ ボーダー色 `cyan` に変えて区別し、従来の `>` プレフィックス +
 * `inverse` 反転は使わない（FR-01 AC-2、release-10-dashboard-polish FR-04。実機確認での
 * ユーザーフィードバックにより、当初の `borderStyle="bold"` ではフォントによって通常線との
 * 差が分かりにくかったため `double` へ変更）。状態の色・
 * グリフ・ラベル・経過時間の整形は presentation 語彙（{@link ../status-display.js}）へ
 * 委ね、優先順位・導出ロジックは一切持たない（§0.5・AC-3）。未選択時の罫線は
 * {@link ./help-overlay.js} と同じ `borderStyle="round"` を用いる。double 罫線でも幅・行数は
 * round と同一で `columnsForWidth`（{@link ../card-grid.js}）の計算には影響しない
 * （release-10-dashboard-polish FR-04 AC-3）。`project.name`・`device.name`・`branch` はレポーター元/
 * ペアリング済み child が制御しうる自由記述で、hub 側の検証は型のみのため ANSI エスケープ・制御文字を
 * 含み得る。描画前に {@link ../sanitize-display-text.js} で除染する（release-10-dashboard-polish
 * レビュー修正・release-21-known-issues-cleanup FR-02: CWE-150、{@link ./detail-view.js} と同じ対策）。
 * `device` 行には、session のターミナル特定情報（`session.terminal.term_program`/`wsl_distro`）から
 * {@link ../terminal-display.js#terminalDisplayName} が非 null を返したときのみ ` (<terminal>)` を
 * 括弧付きで併記する（release-24-dashboard-display-polish FR-03 AC-1、既知課題 U16）。カードの行数は
 * 増やさず、`terminal-display.js` 自体は除染しないため（CWE-150）ここで `device.name` と同様に
 * {@link ../sanitize-display-text.js} を適用してから連結する（AC-2）。`terminalDisplayName` が `null`
 * （`session.terminal` 自体が `null`、または `term_program`/`wsl_distro` がともに `null`）のときは
 * 従来通り device 名のみを表示する（AC-3、NFR 後方互換）。行全体は既存の `wrap="truncate-end"` に
 * 従うため、device 名が長い場合は末尾の `(<terminal>)` ごと切り詰められることを許容する（AC-4）。
 * 末尾行には `running_work`
 * （実行中の作業名。hub が `PreToolUse(Workflow/Task/Agent/Skill)` から導出、release-16-running-work-display
 * FR-02）を `▶ <name>` 形式で描く。`null`（非稼働・区切りイベント後）のときは `branch` の
 * `-` フォールバック（AC-2）と同じ流儀で行自体は維持し `-` を表示し、カード高さを安定させる
 * （FR-03 AC-2）。`name` はレポーター元の自由記述（Workflow 名・`subagent_type`・skill 名）で
 * ANSI エスケープ・制御文字を含み得るため、`device.name`・`branch` と同様に
 * {@link ../sanitize-display-text.js} で除染してから描画する（FR-03 AC-4）。`wrap="truncate-end"`
 * によりカード幅（`width` prop）に収まらない名前は切り詰め、レイアウトは崩れない（FR-03 AC-5）。
 * release-18 FR-05: `running_work.started_at` があるとき `▶ <name> (<経過時間>)` 形式で経過時間を
 * 付記する（{@link ../status-display.js#formatRunningWorkAge}）。`started_at` が無い（旧 hub との
 * 混在）場合は経過時間を省き、従来通り `▶ <name>` のまま表示する（NFR: 後方互換）。
 * release-24-dashboard-display-polish FR-05（既知課題 U18）: `branch` 行の直後・状態行の直前に
 * `path` 行を新規追加し、カードの行数を 5 行から 6 行に増やす。`row.path` は必須の絶対パスで
 * `branch` と異なり `-` フォールバックは不要だが、`device.name`・`branch` と同じく
 * {@link ../sanitize-display-text.js} で除染してから {@link ../truncate-path.js#collapseHomeDir}
 * （`/Users/<name>/...` → `~/...`）・{@link ../truncate-path.js#truncateMiddle}（`先頭…末尾`
 * 形式の中間省略、末尾のリポジトリ名・worktree 名を優先温存）を順に適用する（AC）。
 * `card-grid.js` の `columnsForWidth` は幅のみに依存し高さ（カードの行数）を見ない設計のため、
 * 行数増加は列数計算に影響しない。
 *
 * @param props {@link InstanceCardProps}。
 * @returns 1 instance を表す カードの要素。
 */
export function InstanceCard({ row, selected, width }: InstanceCardProps): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle={selected ? 'double' : 'round'}
      borderColor={selected ? 'cyan' : undefined}
      paddingX={1}
      width={width}
    >
      <Text bold wrap="truncate-end">
        {sanitizeDisplayText(row.project.name)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {formatDeviceLine(row)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {sanitizeNullableDisplayText(row.branch) ?? '-'}
      </Text>
      <Text dimColor wrap="truncate-end">
        {formatPathLine(row, width)}
      </Text>
      <Text wrap="truncate-end">
        <Text color={statusColor(row.status.display)}>
          {statusGlyph(row.status.display)} {statusLabel(row.status.display)}
        </Text>
        <Text dimColor>
          {'  '}
          {formatAge(row.status.elapsed_seconds)}
        </Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {row.running_work ? formatRunningWorkLine(row.running_work) : '-'}
      </Text>
    </Box>
  )
}

/**
 * `path` 行の表示文字列を組み立てる（release-24-dashboard-display-polish FR-05、既知課題 U18）。
 *
 * `row.path` を {@link sanitizeDisplayText} で除染（CWE-150）した**後**に
 * {@link collapseHomeDir}（`/Users/<name>/...` → `~/...`）を適用し、その結果に対して
 * {@link truncateMiddle} で中間省略の幅計算を行う（除染前の生文字列に対して幅計算しない）。
 * 省略幅は `width` prop から罫線・`paddingX={1}` 分（計 4 桁、{@link CARD_CHROME_WIDTH}）を
 * 引いた値を渡す。`width` 未指定（1 列レイアウトで `stdout.columns` が非TTY等で取得できない場合）
 * は `box-border.ts` の他フォールバックと同じ {@link FALLBACK_BOX_WIDTH} を基準幅に使う。
 *
 * @param row {@link InstanceCardProps}.`row`。
 * @param width {@link InstanceCardProps}.`width`。
 * @returns 除染・ホーム短縮・中間省略済みの path 文字列。
 */
function formatPathLine(row: InstanceStatusRow, width: number | undefined): string {
  const sanitized = sanitizeDisplayText(row.path)
  const collapsed = collapseHomeDir(sanitized)
  const maxWidth = (width ?? FALLBACK_BOX_WIDTH) - CARD_CHROME_WIDTH
  return truncateMiddle(collapsed, maxWidth)
}

/**
 * `device` 行の表示文字列を組み立てる（release-24-dashboard-display-polish FR-03 AC-1〜AC-3、
 * 既知課題 U16）。
 *
 * @param row {@link InstanceCardProps}.`row`。
 * @returns 除染済みの `device.name`、またはターミナル名が導出できたときは
 *   `<device.name> (<terminal>)`。
 */
function formatDeviceLine(row: InstanceStatusRow): string {
  const deviceName = sanitizeDisplayText(row.device.name)
  const terminal = terminalDisplayName(
    row.session.terminal?.term_program ?? null,
    row.session.terminal?.wsl_distro ?? null
  )
  return terminal === null ? deviceName : `${deviceName} (${sanitizeDisplayText(terminal)})`
}

/**
 * 末尾行の `running_work` 表示文字列を組み立てる（release-16 FR-03 AC-3、release-18 FR-05 で
 * 経過時間を追加）。
 *
 * @param work {@link InstanceCardProps.row}.`running_work`（non-null。呼び出し側で null チェック済み）。
 * @returns `▶ <name>`、または経過時間が算出できるときは `▶ <name> (<経過時間>)`。
 */
function formatRunningWorkLine(work: NonNullable<InstanceStatusRow['running_work']>): string {
  const name = sanitizeDisplayText(work.name)
  const age = formatRunningWorkAge(work.started_at)
  return age === null ? `▶ ${name}` : `▶ ${name} (${age})`
}
