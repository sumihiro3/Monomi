import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { sanitizeDisplayText, sanitizeNullableDisplayText } from '../sanitize-display-text.js'
import { formatAge, statusColor, statusGlyph, statusLabel } from '../status-display.js'

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
 * （release-10-dashboard-polish FR-04 AC-3）。`device.name`・`branch` はレポーター元/ペアリング
 * 済み child が制御しうる自由記述で、hub 側の検証は型のみのため ANSI エスケープ・制御文字を
 * 含み得る。描画前に {@link ../sanitize-display-text.js} で除染する（release-10-dashboard-polish
 * レビュー修正: CWE-150、{@link ./detail-view.js} と同じ対策）。末尾行には `running_work`
 * （実行中の作業名。hub が `PreToolUse(Workflow/Task/Agent/Skill)` から導出、release-16-running-work-display
 * FR-02）を `▶ <name>` 形式で描く。`null`（非稼働・区切りイベント後）のときは `branch` の
 * `-` フォールバック（AC-2）と同じ流儀で行自体は維持し `-` を表示し、カード高さを安定させる
 * （FR-03 AC-2）。`name` はレポーター元の自由記述（Workflow 名・`subagent_type`・skill 名）で
 * ANSI エスケープ・制御文字を含み得るため、`device.name`・`branch` と同様に
 * {@link ../sanitize-display-text.js} で除染してから描画する（FR-03 AC-4）。`wrap="truncate-end"`
 * によりカード幅（`width` prop）に収まらない名前は切り詰め、レイアウトは崩れない（FR-03 AC-5）。
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
        {row.project.name}
      </Text>
      <Text dimColor wrap="truncate-end">
        {sanitizeDisplayText(row.device.name)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {sanitizeNullableDisplayText(row.branch) ?? '-'}
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
        {row.running_work ? `▶ ${sanitizeDisplayText(row.running_work.name)}` : '-'}
      </Text>
    </Box>
  )
}
