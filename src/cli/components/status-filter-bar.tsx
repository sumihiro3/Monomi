import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import { FILTER_ORDER, type StatusFilter, statusLabel } from '../status-display.js'

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
 * `1`–`6` キーに対応する各状態のラベルと件数を並べ、有効なフィルタを `backgroundColor` で
 * 強調表示する（未選択時は無強調、release-10-dashboard-polish FR-05 AC-1。従来の `inverse`
 * 反転から置換）。フィルタのトグルは KeyBindingController→store の責務で、ここは描画のみ。
 *
 * @param props {@link StatusFilterBarProps}。
 * @returns フィルタバーの要素。
 */
export function StatusFilterBar({ counts, activeFilters }: StatusFilterBarProps): ReactElement {
  return (
    // release-9-i18n: 既定ロケール(en)のラベルは日本語より長く(例 "Awaiting next
    // instruction")、100桁前後の端末では flexWrap 無指定だと Yoga が各項目の内部で
    // 文言と件数を千切って折り返してしまう。flexWrap="wrap" で項目単位のまとまりを保って
    // 次行へ折り返す。
    <Box flexWrap="wrap">
      {FILTER_ORDER.map((filter, index) => {
        const active = activeFilters.includes(filter)
        return (
          <Box key={filter} marginRight={2}>
            <Text backgroundColor={active ? 'blue' : undefined}>
              [{index + 1}]{statusLabel(filter)} {counts[filter] ?? 0}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
