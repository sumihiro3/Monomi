import { Box, Text, useApp, useInput } from 'ink'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import type { InstanceStatusRow } from '../../hub/dto.js'
import type { HubApiClient } from '../hub-api-client.js'
import { InstanceListStore } from '../instance-list-store.js'
import {
  KeyBindingController,
  type KeyBindingHost,
  type ViewMode,
} from '../key-binding-controller.js'
import { DEFAULT_POLL_INTERVAL_MS, PollingLoop, type ReresolveClient } from '../polling-loop.js'
import { FILTER_ORDER, type StatusFilter } from '../status-display.js'
import { DetailView } from './detail-view.js'
import { HelpOverlay } from './help-overlay.js'
import { InstanceTable } from './instance-table.js'
import { StatusFilterBar } from './status-filter-bar.js'

/** {@link AppView} の props（container: 依存を注入してテスト可能にする）。 */
export interface AppViewProps {
  /** hub への読み取りクライアント。 */
  client: HubApiClient
  /** watch モードのポーリング間隔（省略時 {@link DEFAULT_POLL_INTERVAL_MS}）。 */
  pollIntervalMs?: number
  /**
   * watch 中の取得失敗時に到達先を選び直す再解決ファクトリ（省略時は再解決しない / #1）。
   * bin 実行では {@link ../hub-api-client.js} の `createHubConnection` が供給する。
   */
  reresolve?: ReresolveClient
}

/**
 * CLI のルートコンテナ（class-diagram §4 / FR-05）。
 *
 * {@link InstanceListStore}（一覧状態）・{@link PollingLoop}（更新）・
 * {@link KeyBindingController}（キー入力）を配線し、一覧／詳細の描画とキー操作を束ねる。
 * store と polling は再描画で作り直さないよう ref に保持し、外部ミュータブル状態の変更後は
 * version カウンタで再描画をトリガする。status 導出・優先順位は一切持たない（§0.5）。
 *
 * 挙動（FR-05 AC-1〜AC-4 / FR-03 AC-1・AC-3 / FR-04）:
 * - マウント時に watch モード（間隔ポーリング）を常時 ON で開始し、その中の即時取得で
 *   全 instance を一覧表示（FR-05 AC-1・FR-03 AC-1/AC-3）。手動での OFF トグルは持たない
 *   （FR-03 AC-2 撤回）
 * - `1`–`5` で状態フィルタをトグル（AC-2）。一覧表示中のみ有効（FR-04）
 * - `Enter` で選択 instance の直近イベントタイムラインを表示（AC-4）。詳細表示中はフッターの
 *   ショートカットヒントが専用の内容へ切り替わり、フィルタ・移動・詳細を開く操作は無視される
 *   （FR-04）
 *
 * @param props {@link AppViewProps}。
 * @returns CLI ルートの要素。
 */
export function AppView({
  client,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  reresolve,
}: AppViewProps): ReactElement {
  const { exit } = useApp()

  const storeRef = useRef<InstanceListStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = new InstanceListStore()
  }
  const store = storeRef.current

  const pollingRef = useRef<PollingLoop<InstanceStatusRow[]> | null>(null)
  if (pollingRef.current === null) {
    pollingRef.current = new PollingLoop(
      (c) => c.listInstances(),
      client,
      pollIntervalMs,
      reresolve
    )
  }
  const polling = pollingRef.current

  // 外部ミュータブル状態（store / polling）の変更を React へ伝えるための再描画トリガ。
  // setVersion の setter 参照は不変なので useCallback で安定させ、useEffect の依存配列に
  // 正しく載せられるようにする（FR-09 L1: useExhaustiveDependencies）。
  const [, setVersion] = useState(0)
  const bump = useCallback((): void => setVersion((v) => v + 1), [])

  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [detailRow, setDetailRow] = useState<InstanceStatusRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    polling.onUpdate((rows) => {
      store.setInstances(rows)
      setError(null)
      bump()
    })
    polling.onError((err) => {
      setError(String(err))
      bump()
    })
    // watch モードを既定 ON にする（FR-03 AC-1/AC-3）。start() は内部で即時 refresh() を
    // 実行するため、初回全件表示（AC-1）は維持したまま起動直後から isRunning()===true になる。
    polling.start()
    return () => polling.stop()
    // store / polling は ref で安定。bump は useCallback で安定。マウント時 1 回だけ配線する。
  }, [store, polling, bump])

  const filteredRows = store.filtered()
  const lastIndex = Math.max(filteredRows.length - 1, 0)
  const clampedSelected = Math.min(Math.max(selectedIndex, 0), lastIndex)

  // Ink 7 の useInput は useEffectEvent 経由で常に最新クロージャを呼ぶため、
  // host / controller は毎描画で作り直しても最新の state を参照できる。
  const host: KeyBindingHost = {
    moveSelection: (delta) => {
      const length = store.filtered().length
      if (length === 0) return
      setSelectedIndex((current) => {
        const clamped = Math.min(Math.max(current, 0), length - 1)
        return Math.min(Math.max(clamped + delta, 0), length - 1)
      })
    },
    openDetail: () => {
      const rows = store.filtered()
      if (rows.length === 0) return
      const row = rows[Math.min(Math.max(selectedIndex, 0), rows.length - 1)]
      setDetailRow(row)
      setViewMode('detail')
    },
    back: () => {
      if (showHelp) {
        setShowHelp(false)
        return
      }
      if (viewMode === 'detail') {
        setViewMode('list')
        setDetailRow(null)
      }
    },
    toggleHelp: () => setShowHelp((h) => !h),
    quit: () => {
      polling.stop()
      exit()
    },
  }
  const controller = new KeyBindingController(store, host)

  useInput((input, key) => {
    controller.handleKey(
      input,
      {
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        return: key.return,
        escape: key.escape,
      },
      viewMode
    )
    bump()
  })

  const counts = countByDisplay(store.instances)
  const projectCount = store.projectRows().length
  const deviceCount = new Set(filteredRows.map((row) => row.device.id)).size

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Claude Code Status</Text>
        <Text dimColor>
          {'  '}— {projectCount} projects · {deviceCount} devices
        </Text>
        {polling.isRunning() ? <Text color="green">{'  '}● watching</Text> : null}
      </Text>

      {viewMode === 'detail' && detailRow !== null ? (
        <Box marginTop={1}>
          <DetailView client={client} row={detailRow} pollIntervalMs={pollIntervalMs} />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <StatusFilterBar counts={counts} activeFilters={store.activeFilters as StatusFilter[]} />
          <Box marginTop={1}>
            <InstanceTable rows={filteredRows} selectedIndex={clampedSelected} />
          </Box>
        </Box>
      )}

      {error !== null ? <Text color="red">エラー: {error}</Text> : null}
      {showHelp ? (
        <Box marginTop={1}>
          <HelpOverlay />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>{footerHint(viewMode)}</Text>
      </Box>
    </Box>
  )
}

/**
 * フッターのショートカットヒントを表示中のビューに応じて切り替える（FR-04）。
 *
 * 詳細ビューではフィルタ・カーソル移動・詳細を開く操作を受け付けない（{@link KeyBindingController}
 * 側でも無視される）ため、それらのヒントを出さない。
 *
 * @param viewMode 現在表示中のビュー。
 * @returns フッターに表示するヒント文字列。
 */
function footerHint(viewMode: ViewMode): string {
  return viewMode === 'detail'
    ? 'esc back ? help q quit'
    : '1-5 filter j/k ↑↓ move ↵ detail esc back ? help q quit'
}

/**
 * 全 instance を表示状態ごとに件数集計する（フィルタバーの件数表示用）。
 *
 * @param rows 集計対象（フィルタ適用前の全件）。
 * @returns 表示状態 → 件数。フィルタ対象 5 状態は 0 で初期化する。
 */
function countByDisplay(rows: readonly InstanceStatusRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const filter of FILTER_ORDER) {
    counts[filter] = 0
  }
  for (const row of rows) {
    counts[row.status.display] = (counts[row.status.display] ?? 0) + 1
  }
  return counts
}
