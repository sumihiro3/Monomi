import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { formatAge, statusColor, statusGlyph, statusLabel } from '../status-display.js'

/** {@link InstanceCard} の props（presentational）。 */
export interface InstanceCardProps {
  /** 描画対象の instance 行（フィルタ適用後の 1 件）。 */
  row: InstanceStatusRow
  /** 選択カーソルがこのカード上にあるか（ボーダー色で視覚区別する、FR-01 AC-2）。 */
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
 * ボーダー色を `cyan` に変えて区別し、従来の `>` プレフィックス + `inverse` 反転は使わない
 * （FR-01 AC-2）。状態の色・グリフ・ラベル・経過時間の整形は presentation 語彙
 * （{@link ../status-display.js}）へ委ね、優先順位・導出ロジックは一切持たない（§0.5・AC-3）。
 * 罫線は {@link ./help-overlay.js} と同じ `borderStyle="round"` を用いる。
 *
 * @param props {@link InstanceCardProps}。
 * @returns 1 instance を表す カードの要素。
 */
export function InstanceCard({ row, selected, width }: InstanceCardProps): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={selected ? 'cyan' : undefined}
      paddingX={1}
      width={width}
    >
      <Text bold wrap="truncate-end">
        {row.project.name}
      </Text>
      <Text dimColor wrap="truncate-end">
        {row.device.name}
      </Text>
      <Text dimColor wrap="truncate-end">
        {row.branch ?? '-'}
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
    </Box>
  )
}
