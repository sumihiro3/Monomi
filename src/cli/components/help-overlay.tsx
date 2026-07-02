import { Box, Text } from 'ink'
import { type ReactElement } from 'react'

/** `[key, description]` のヘルプ 1 行。 */
const HELP_LINES: ReadonlyArray<readonly [string, string]> = [
  ['1-5', '状態フィルタのトグル（複数選択可）'],
  ['j / k, ↑ / ↓', 'カーソル移動'],
  ['Enter', '詳細（Agent View Lv.1）を開く'],
  ['esc', '戻る / ヘルプを閉じる'],
  ['?', 'ヘルプの表示/非表示'],
  ['q', '終了'],
]

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
