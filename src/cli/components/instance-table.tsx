import { Box, Text } from 'ink'
import { type ReactElement } from 'react'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { formatAge, statusColor, statusGlyph, statusLabel } from '../status-display.js'

/** {@link InstanceTable} の props（presentational）。 */
export interface InstanceTableProps {
  /** 表示対象の instance 行（フィルタ適用後）。 */
  rows: readonly InstanceStatusRow[]
  /** 選択カーソルの位置（0 起点、`rows` の添字）。 */
  selectedIndex: number
}

/** 各列の表示幅（半角換算のおおよその目安）。 */
const COLUMN_WIDTH = { project: 22, device: 12, branch: 26, state: 14 } as const

/**
 * instance の一覧テーブル（§10.2、presentational）。
 *
 * `PROJECT / DEVICE / BRANCH / STATE / AGE` の列で 1 instance 1 行を描き、選択行に
 * `>` カーソルを立てて反転表示する。状態ラベル・色・グリフ・AGE 整形は presentation 語彙
 * （{@link ../status-display.js}）に委ね、優先順位や導出ロジックは持たない（§0.5）。
 *
 * @param props {@link InstanceTableProps}。
 * @returns 一覧テーブルの要素。
 */
export function InstanceTable({ rows, selectedIndex }: InstanceTableProps): ReactElement {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {'  '}
        {'PROJECT'.padEnd(COLUMN_WIDTH.project)}
        {'DEVICE'.padEnd(COLUMN_WIDTH.device)}
        {'BRANCH'.padEnd(COLUMN_WIDTH.branch)}
        {'STATE'.padEnd(COLUMN_WIDTH.state)}
        AGE
      </Text>
      {rows.length === 0 ? (
        <Text dimColor>{'  '}(該当するインスタンスがありません)</Text>
      ) : (
        rows.map((row, index) => {
          const selected = index === selectedIndex
          return (
            <Text key={row.instance_id} inverse={selected} wrap="truncate-end">
              {selected ? '> ' : '  '}
              {pad(row.project.name, COLUMN_WIDTH.project)}
              {pad(row.device.name, COLUMN_WIDTH.device)}
              {pad(row.branch ?? '-', COLUMN_WIDTH.branch)}
              <Text color={statusColor(row.status.display)}>
                {statusGlyph(row.status.display)}{' '}
                {pad(statusLabel(row.status.display), COLUMN_WIDTH.state - 2)}
              </Text>
              {formatAge(row.status.elapsed_seconds)}
            </Text>
          )
        })
      )}
    </Box>
  )
}

/**
 * 列幅に合わせて右パディング／切り詰めする（簡易整形。全角幅は考慮しない）。
 *
 * @param text 元の文字列。
 * @param width 目標の表示幅（文字数）。
 * @returns 末尾を空白で埋めた、または切り詰めた文字列。
 */
function pad(text: string, width: number): string {
  if (text.length >= width) {
    return `${text.slice(0, Math.max(1, width - 1))} `
  }
  return text.padEnd(width)
}
