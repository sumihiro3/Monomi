import { Box, Text } from 'ink'
import { type ReactElement } from 'react'
import { FILTER_ORDER, statusLabel, type StatusFilter } from '../status-display.js'

/** {@link StatusFilterBar} の props（presentational: 状態を持たず props を描くだけ）。 */
export interface StatusFilterBarProps {
  /** 表示状態ごとの件数（フィルタ適用前の全件から集計）。 */
  counts: Record<string, number>
  /** 現在有効なフィルタ（強調表示に使う）。 */
  activeFilters: readonly StatusFilter[]
}

/**
 * 状態フィルタのバー（§10.2 の `[1]稼働中 2  [2]権限待ち 1 …`）。
 *
 * `1`–`5` キーに対応する各状態のラベルと件数を並べ、有効なフィルタを反転表示する。
 * フィルタのトグルは KeyBindingController→store の責務で、ここは描画のみ。
 *
 * @param props {@link StatusFilterBarProps}。
 * @returns フィルタバーの要素。
 */
export function StatusFilterBar({ counts, activeFilters }: StatusFilterBarProps): ReactElement {
  return (
    <Box>
      {FILTER_ORDER.map((filter, index) => {
        const active = activeFilters.includes(filter)
        return (
          <Box key={filter} marginRight={2}>
            <Text inverse={active}>
              [{index + 1}]{statusLabel(filter)} {counts[filter] ?? 0}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
