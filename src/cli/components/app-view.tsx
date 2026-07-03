import { Box, Text, useApp, useInput, useStdout } from 'ink'
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
import { DEFAULT_TERMINAL_TITLE, setTerminalTitle } from '../terminal-title.js'
import { DetailView } from './detail-view.js'
import { HELP_OVERLAY_ROWS, HelpOverlay } from './help-overlay.js'
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
 * 挙動（FR-05 AC-1〜AC-4 / FR-03 AC-1・AC-3 / FR-04 / release-6 FR-03・FR-04）:
 * - マウント時に watch モード（間隔ポーリング）を常時 ON で開始し、その中の即時取得で
 *   全 instance を一覧表示（FR-05 AC-1・FR-03 AC-1/AC-3）。手動での OFF トグルは持たない
 *   （FR-03 AC-2 撤回）
 * - `1`–`5` で状態フィルタをトグル（AC-2）。一覧表示中のみ有効（FR-04）
 * - `Enter` で選択 instance の直近イベントタイムラインを表示（AC-4）。`selectedIndex` は一覧・
 *   詳細で共有する単一状態で、表示 instance は `store.filtered()[selectedIndex]` から都度導出する
 *   （detailRow スナップショットは廃止、release-6 FR-04 AC-3）
 * - 詳細表示中はフッターのヒントが専用内容へ切り替わり、`←`/`→` で一覧の並び順の前後 instance へ
 *   循環移動する（{@link KeyBindingController.handleKey} が `moveProject` へ写す、release-6 FR-04
 *   AC-1/AC-2）。`esc` で一覧へ戻るとカーソルは移動先の instance に自然一致する（AC-3）。`j`/`k`・
 *   `↑`/`↓` は {@link DetailView} 自身がイベントスクロールとして消費し、一覧状態には影響しない
 *   （release-6 FR-02 AC-3）。`1`-`5`・`Enter` は詳細中は引き続き無視する
 * - ターミナルのタブ/ウィンドウタイトルを {@link ../terminal-title.js#setTerminalTitle} で管理する
 *   （release-6 FR-09）。マウント直後・一覧表示中は既定値 `Monomi`、詳細表示中は
 *   `project名 @ device名` を設定し、隣接プロジェクト移動・ポーリング更新で表示中の project/device
 *   が変わればタイトルも追従する（AC-1〜AC-4）
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
  const { stdout } = useStdout()

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
  // 一覧・詳細で共有する selectedIndex から表示 instance を都度導出する（detailRow スナップショット
  // 廃止, release-6 FR-04 AC-3）。filteredRows が空のときのみ undefined になる。
  const selectedRow = filteredRows[clampedSelected] as InstanceStatusRow | undefined

  // review-changes 修正: 閲覧中の instance が一覧から消えても、他の instance が index を埋めれば
  // selectedRow は undefined にならず、無言で隣の instance へ切り替わってしまっていた
  // （selectedRow の「有無」だけでは、位置ではなく実体が消えたことを検出できない）。
  // viewedInstanceIdRef に「直前に描画していた instance の id」を持ち、詳細表示中は毎レンダーで
  // その id が filteredRows にまだ存在するかを実体（id）で確認する。存在しなければ（対象そのものが
  // 消えた）一覧へ戻し、存在すれば（ユーザーの ←/→ 移動・ポーリング更新のいずれでも）
  // 表示を続けたうえで ref を現在の instance_id に更新する。
  const viewedInstanceIdRef = useRef<string | null>(null)
  const viewedInstanceVanished =
    viewMode === 'detail' &&
    viewedInstanceIdRef.current !== null &&
    !filteredRows.some((row) => row.instance_id === viewedInstanceIdRef.current)
  const currentViewedInstanceId = viewMode === 'detail' ? (selectedRow?.instance_id ?? null) : null
  useEffect(() => {
    if (viewMode !== 'detail') {
      viewedInstanceIdRef.current = null
      return
    }
    if (viewedInstanceVanished) {
      setViewMode('list')
      viewedInstanceIdRef.current = null
      return
    }
    viewedInstanceIdRef.current = currentViewedInstanceId
  }, [viewMode, viewedInstanceVanished, currentViewedInstanceId])

  // release-6 FR-09: 詳細ビュー表示中はターミナルのタブ/ウィンドウタイトルへ `project名 @ device名`
  // を OSC で設定し、一覧表示中（AppView マウント直後含む）は既定値 `Monomi` へ戻す（AC-1・AC-2・AC-4）。
  // 依存配列に project.name/device.name（selectedRow 由来）を含めることで、隣接プロジェクト移動
  // （selectedIndex 変化）・ポーリング更新のどちらで表示中の project/device が変わってもタイトルが
  // 追従する（AC-3）。
  //
  // review-changes 修正: AC-5 は「isTTY を問わず同じ経路でよい（副作用は書き込みのみで害はない）」と
  // していたが、実装時の検証で誤りと判明した。非TTY（`stdout.isTTY` が偽）のとき、Ink は
  // 自身を「非 interactive」とみなし、通常の再描画フレームと本 OSC 書き込みの両方を
  // `stdout.write` へ無調整で素通しする。両者を区別する手段が無い下流の消費者（パイプ出力を読む
  // プロセス、および ink-testing-library の `lastFrame()` 実装）から見ると、この OSC 書き込みが
  // 直前の実フレームを「最後の書き込み」として上書きしてしまい、実フレームが消えたように見える
  // （`app-view.test.tsx` の一覧復帰テストで実際に再現した）。TTY でない出力先にウィンドウ
  // タイトルを設定すること自体に意味も無いため、`stdout.isTTY` のときのみ書き込む。
  const detailProjectName = viewMode === 'detail' ? (selectedRow?.project.name ?? null) : null
  const detailDeviceName = viewMode === 'detail' ? (selectedRow?.device.name ?? null) : null
  useEffect(() => {
    if (!stdout.isTTY) {
      return
    }
    const title =
      detailProjectName !== null && detailDeviceName !== null
        ? `${detailProjectName} @ ${detailDeviceName}`
        : DEFAULT_TERMINAL_TITLE
    setTerminalTitle(stdout, title)
  }, [stdout, detailProjectName, detailDeviceName])

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
      // 選択は既存 selectedIndex をそのまま使い、表示 instance は selectedRow から導出する
      // （detailRow スナップショットは持たない, release-6 FR-04 AC-3）。空一覧では開かない。
      if (store.filtered().length === 0) return
      setViewMode('detail')
    },
    moveProject: (delta) => {
      // FR-04 AC-1/AC-2: 一覧の並び順で前後 instance へ移動し、端では反対側へ循環する。
      // len===0 は no-op。current を範囲クランプしてから wrap し、負値を避けるため +length する。
      const length = store.filtered().length
      if (length === 0) return
      setSelectedIndex((current) => {
        const clamped = Math.min(Math.max(current, 0), length - 1)
        return (clamped + delta + length) % length
      })
    },
    back: () => {
      if (showHelp) {
        setShowHelp(false)
        return
      }
      // detailRow クリアは不要（selectedIndex は共有状態なので保持し、一覧のカーソルが移動先に
      // 一致する, release-6 FR-04 AC-3）。viewMode を list に戻すだけでよい。
      if (viewMode === 'detail') {
        setViewMode('list')
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
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
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

      {viewMode === 'detail' && selectedRow !== undefined ? (
        <Box marginTop={1}>
          <DetailView
            client={client}
            row={selectedRow}
            pollIntervalMs={pollIntervalMs}
            // review-changes 修正: ヘルプ表示中は下に HelpOverlay（HELP_OVERLAY_ROWS）+
            // その marginTop={1}（1行）を追加で積むため、DetailView 側の表示行数からも
            // 同じぶんを差し引いてもらう。差し引かないと合計描画行数が端末行数を超え、
            // ヘッダー・概要BOXがスクロールして見えなくなる（実機で確認済み）。
            extraReservedRows={showHelp ? HELP_OVERLAY_ROWS + 1 : 0}
          />
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
 * フッターのショートカットヒントを表示中のビューに応じて切り替える（FR-04 / release-6 FR-03 AC-1）。
 *
 * 詳細ビューではフィルタ（`1`-`5`）・詳細を開く（`Enter`）操作を出さず、代わりに詳細固有の
 * `j/k scroll`（イベントスクロール, {@link DetailView}）・`←/→ project`（隣接 instance 移動,
 * {@link KeyBindingController}）・`w wrap`（イベント行の折り返し/切り詰め切替, {@link DetailView}, FR-08）を
 * 提示する。
 *
 * @param viewMode 現在表示中のビュー。
 * @returns フッターに表示するヒント文字列。
 */
function footerHint(viewMode: ViewMode): string {
  return viewMode === 'detail'
    ? 'j/k scroll ←/→ project w wrap esc back ? help q quit'
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
