import { Box, Text, useStdout } from 'ink'
import type { ReactElement } from 'react'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { t } from '../../i18n/index.js'
import { columnsForWidth } from '../card-grid.js'
import { InstanceCard } from './instance-card.js'

/** {@link InstanceTable} の props（presentational）。 */
export interface InstanceTableProps {
  /** 表示対象の instance 行（フィルタ適用後、`store.filtered()` の並び順）。 */
  rows: readonly InstanceStatusRow[]
  /** 選択カーソルの位置（0 起点、`rows` の添字）。 */
  selectedIndex: number
}

/**
 * instance 一覧のレスポンシブなカードグリッド（§10.2 / FR-01・FR-02、container 兼 presentational）。
 *
 * 1 instance = 1 枚の {@link InstanceCard} を描く。列数は `useStdout()` で得た端末幅
 * （`stdout.columns`）と TTY 判定（`stdout.isTTY`）を {@link ../card-grid.js} の
 * `columnsForWidth` に渡して決める（FR-02 AC-2）。列数が 2 以上なら `flexWrap="wrap"` の
 * 横並びで描き、1 行に収まらなくなったら次行へ自動折返しする（FR-02 AC-1）。列数が 1
 * （非TTY・幅未取得を含む）のときは `flexDirection="column"` で縦積みを**構造的に**強制する。
 * 幅の計算値（`stdout.columns` が `undefined` になり得る）に依存して折返しを起こす設計だと、
 * 非TTY環境でカードが横並びしてしまう不具合があったため、レイアウト方向そのもので縮退を
 * 保証する形に直している（FR-02 AC-4）。`useStdout` をこのグリッド内に閉じることで、呼び出し
 * 側（app-view.tsx / cli.ts）はカード化前と同じ `rows` / `selectedIndex` の props だけで済む。
 *
 * カーソルの並び順は `rows`（= `store.filtered()`）の 1 次元順のまま map するだけで、
 * 折返し順（左→右・上→下）と選択インデックスの一致を Ink の flexWrap に委ねる。独自の
 * 行列インデックス計算は持たない（FR-02 AC-3）。状態表現・優先順位は一切持たず、カード内の
 * 色・グリフ・ラベル・age 整形は {@link ../status-display.js} 経由で再利用する（§0.5・AC-3）。
 *
 * @param props {@link InstanceTableProps}。
 * @returns カードグリッドの要素（0 件時は不在メッセージ）。
 */
export function InstanceTable({ rows, selectedIndex }: InstanceTableProps): ReactElement {
  const { stdout } = useStdout()
  const columns = columnsForWidth(stdout.columns, Boolean(stdout.isTTY))

  if (rows.length === 0) {
    return (
      <Text dimColor>
        {'  '}
        {t('list.empty')}
      </Text>
    )
  }

  if (columns === 1) {
    // 非TTY・幅未取得（stdout.columns === undefined）を含め、1 列を flexDirection="column"
    // で構造的に保証する（レビュー修正: flexWrap + 幅頼みだと stdout.columns が undefined の
    // とき cardWidth も undefined になり、各カードが内容幅で横並びしてしまっていた。column
    // レイアウトなら子要素は常に 1 行 1 枚で積まれるため、幅の値に関わらず縮退が壊れない）。
    // width は分かれば全幅表示に使うが、無ければ省略して内容幅で描く（縦積みには影響しない）。
    return (
      <Box flexDirection="column">
        {rows.map((row, index) => (
          <InstanceCard
            key={row.instance_id}
            row={row}
            selected={index === selectedIndex}
            width={stdout.columns}
          />
        ))}
      </Box>
    )
  }

  // 多列時は端末幅を列数で等分する（columnsForWidth の定義上 columns > 1 なら stdout.columns
  // は真値の正数であることが保証される。§card-grid.ts の columnsForWidth 参照）。
  const cardWidth = Math.floor(stdout.columns / columns)

  return (
    <Box flexDirection="row" flexWrap="wrap">
      {rows.map((row, index) => (
        <InstanceCard
          key={row.instance_id}
          row={row}
          selected={index === selectedIndex}
          width={cardWidth}
        />
      ))}
    </Box>
  )
}
