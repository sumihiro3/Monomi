import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { t } from '../../i18n/index.js'
import { MONOMI_VERSION } from '../../version.js'
import { compareVersion } from '../../version-compare.js'
import { toFocusTarget } from '../focus/focus-target.js'
import type { FocusResult, FocusTarget } from '../focus/types.js'
import type { HubApiClient } from '../hub-api-client.js'
import { InstanceListStore } from '../instance-list-store.js'
import { DEFAULT_BACKPRESSURE_THRESHOLD_BYTES, isStdoutBackpressured } from '../memory-watchdog.js'
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
import { WatchingIndicator } from './watching-indicator.js'

/**
 * 検証済み {@link FocusTarget} を実ターミナルのタブ/ウィンドウへフォーカスさせる関数の DI 型
 * （`FocusService#focus` と同じ signature、release-23-terminal-focus FR-05c）。
 */
export type FocusRunner = (target: FocusTarget | null) => Promise<FocusResult>

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
  /**
   * この CLI 自身の device_id（release-23-terminal-focus FR-05 AC-2）。`f` によるフォーカス
   * 実行を選択行の `device.id` と照合するゲートに使う。省略時は空文字列（実在する device_id と
   * 一致し得ない安全側の既定値のため、フォーカスは常に `focus.otherDevice` へ縮退する）。
   * 実運用では `src/cli.ts` の `runDashboard()`（FR-05d）が
   * `loadConfig().deviceId ?? deriveDeviceId(os.hostname())` を注入する。
   */
  localDeviceId?: string
  /**
   * {@link FocusTarget} を実ターミナルへフォーカスする実行体（FocusService の DI、FR-04d）。
   * テストでは mock に差し替える。省略時は常に `unsupported_platform` を返す no-op
   * （実運用では `src/cli.ts` の `runDashboard()`（FR-05d）が FocusService を注入する）。
   */
  focusRunner?: FocusRunner
  /**
   * ダッシュボード起動時に確定した永続 notice（呼び出し側で i18n 解決済みの文字列、
   * release-25-auto-update）。hub/reporter の自動更新結果や版ずれ警告の受け皿で、`f` フォーカス
   * 失敗時の理由 notice（{@link showNotice}、約4秒で自動消去する時限式）とは独立した表示領域を持つ。
   * 更新告知・版ずれ警告はユーザーが認識するまで残すべきで自動消去すべきではないため、時限式の
   * 仕組みは流用しない。省略時は空配列（何も表示しない）。実運用では `src/cli.ts` の
   * `runDashboard(startupNotices)` が注入する。
   */
  startupNotices?: string[]
}

/**
 * {@link AppViewProps.focusRunner} の既定値（未注入時の安全な no-op、release-23-terminal-focus FR-05c）。
 *
 * `src/cli.ts` の配線（FR-05d）が完了するまでの間、`AppView` を単体で使う既存呼び出し元が
 * 型エラーなくビルドできるようにするためのフォールバック。
 */
const noopFocusRunner: FocusRunner = () => Promise.resolve('unsupported_platform')

/**
 * FocusResult を CLI 表示用の理由 notice へ写す（release-23-terminal-focus FR-05c、AC-4）。
 *
 * `ok` は呼び出し側（{@link AppView} の `focusTerminal`）が成功時に notice を出さず早期 return
 * するため、ここには渡ってこない前提。`no_terminal` は `AppView` 側の事前ゲート（terminal
 * 情報なし/検証不合格判定）で通常は発生しないはずだが、縮退時の安全側フォールバックとして
 * `focus.noTerminalInfo` に写す。
 *
 * @param result `focusRunner` が返した `'ok'` 以外の {@link FocusResult}。
 * @returns 表示する notice 文言。
 */
function noticeForFocusResult(result: Exclude<FocusResult, 'ok'>): string {
  switch (result) {
    case 'tmux_detached':
      return t('focus.tmuxDetached')
    case 'not_found':
      return t('focus.notFound')
    case 'unsupported_platform':
      return t('focus.unsupported')
    case 'no_terminal':
      return t('focus.noTerminalInfo')
    case 'error':
      return t('focus.failed')
  }
}

/** notice の自動消去までの時間（release-23-terminal-focus FR-05c、AC-4: 約4秒）。 */
const FOCUS_NOTICE_DURATION_MS = 4000

/**
 * CLI のルートコンテナ（class-diagram §4 / FR-05）。
 *
 * {@link InstanceListStore}（一覧状態）・{@link PollingLoop}（更新）・
 * {@link KeyBindingController}（キー入力）を配線し、一覧／詳細の描画とキー操作を束ねる。
 * store と polling は再描画で作り直さないよう ref に保持し、外部ミュータブル状態の変更後は
 * version カウンタで再描画をトリガする。status 導出・優先順位は一切持たない（§0.5）。
 *
 * 挙動（FR-05 AC-1〜AC-4 / FR-03 AC-1・AC-3 / FR-04 / release-6 FR-03・FR-04 /
 * release-20-dashboard-heap-guard FR-04）:
 * - マウント時に watch モード（間隔ポーリング）を常時 ON で開始し、その中の即時取得で
 *   全 instance を一覧表示（FR-05 AC-1・FR-03 AC-1/AC-3）。手動での OFF トグルは持たない
 *   （FR-03 AC-2 撤回）。詳細ビュー表示中は一覧用ポーリングを止め、一覧へ戻ると再開する
 *   （release-20-dashboard-heap-guard FR-04 AC-1/AC-2、既知課題 B5 の解消）
 * - `1`–`6` で状態フィルタをトグル（AC-2）。一覧表示中のみ有効（FR-04）
 * - `Enter` で選択 instance の直近イベントタイムラインを表示（AC-4）。`selectedIndex` は一覧・
 *   詳細で共有する単一状態で、表示 instance は `store.filtered()[selectedIndex]` から都度導出する
 *   （detailRow スナップショットは廃止、release-6 FR-04 AC-3）
 * - 詳細表示中はフッターのヒントが専用内容へ切り替わり、`←`/`→` で一覧の並び順の前後 instance へ
 *   循環移動する（{@link KeyBindingController.handleKey} が `moveProject` へ写す、release-6 FR-04
 *   AC-1/AC-2）。`esc` で一覧へ戻るとカーソルは移動先の instance に自然一致する（AC-3）。`j`/`k`・
 *   `↑`/`↓` は {@link DetailView} 自身がイベントスクロールとして消費し、一覧状態には影響しない
 *   （release-6 FR-02 AC-3）。`1`-`6`・`Enter` は詳細中は引き続き無視する
 * - ターミナルのタブ/ウィンドウタイトルを {@link ../terminal-title.js#setTerminalTitle} で管理する
 *   （release-6 FR-09）。マウント直後・一覧表示中は既定値 `Monomi`、詳細表示中は
 *   `project名 @ device名` を設定し、隣接プロジェクト移動・ポーリング更新で表示中の project/device
 *   が変わればタイトルも追従する（AC-1〜AC-4）
 *
 * - `f` で選択中 instance のセッション実行中ターミナルへフォーカス移動する
 *   （release-23-terminal-focus FR-05c）。選択行なし・別デバイス・`closed`・ターミナル情報
 *   なし/検証不合格のいずれかでは `focusRunner` を呼ばず理由 notice を表示する（AC-2〜AC-4）。
 *   成功時は notice を出さず（タブ移動自体がフィードバック）、失敗時のみ理由別 notice を表示し
 *   約4秒で自動消去する。フッターヒントは選択行が同一デバイスのときのみ ` f focus` を追加する
 *   （AC-5）
 * - `startupNotices`（release-25-auto-update）はヘッダー直下に警告色（黄）でスタック表示する
 *   永続 notice 領域。hub/reporter の自動更新結果・版ずれ警告の受け皿で、`f` 失敗時の時限式
 *   notice とは独立しており自動消去しない
 * - リモート hub の版ずれ可視化（release-25-auto-update FR-04）: watch ポーリングの取得関数が
 *   `listInstances()` に続けて `client.getLastHubVersion()`（既存応答のヘッダ読み取りのみ、追加
 *   リクエストは発生させない）を読み、自版との比較（`version-compare.ts`）が `older`/`unknown`
 *   （ヘッダ欠落＝版不明も旧版扱い）なら「hub が旧版、hub デバイスで更新を」notice を
 *   `startupNotices` と同じ永続 notice 領域に表示する（AC-1・AC-3）。`same`/`newer` になれば
 *   notice を消す（AC-2）。直前と同一の notice 文字列なら再セットしない dedup で、連続ポーリングの
 *   たびに表示が増殖しないようにする（AC-4、表示は常に高々 1 件）。hub ロール自身への接続は
 *   再起動後に版が一致するため、この notice は自然に出ない。
 *
 * @param props {@link AppViewProps}。
 * @returns CLI ルートの要素。
 */
export function AppView({
  client,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  reresolve,
  localDeviceId = '',
  focusRunner = noopFocusRunner,
  startupNotices = [],
}: AppViewProps): ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()

  const storeRef = useRef<InstanceListStore | null>(null)
  if (storeRef.current === null) {
    storeRef.current = new InstanceListStore()
  }
  const store = storeRef.current

  // release-25-auto-update FR-04: フォールバックで PollingLoop が client を差し替えても、実際に
  // 応答した client の版を捕捉できるよう、取得のたびに c.getLastHubVersion() を読んで ref へ保持する
  // （PollingLoop<InstanceStatusRow[]> の型は不変のまま。追加リクエストは発生させない）。
  const hubVersionRef = useRef<string | undefined>(undefined)
  const pollingRef = useRef<PollingLoop<InstanceStatusRow[]> | null>(null)
  if (pollingRef.current === null) {
    pollingRef.current = new PollingLoop(
      async (c) => {
        const rows = await c.listInstances()
        hubVersionRef.current = c.getLastHubVersion()
        return rows
      },
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

  // release-23-terminal-focus FR-05c: `f` フォーカス実行の理由 notice（既存の error state に
  // 倣うが、こちらは約4秒で自動消去する時限式）。アンマウント後の setState を防ぐため
  // mountedRef を、連続実行時に前回のタイマーを取り消すため noticeTimerRef を持つ。
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  // release-25-auto-update FR-04: リモート hub の版ずれ notice（startupNotices と同じ永続 notice
  // 領域に表示、自動消去しない）。remoteHubNoticeRef は直近セット値を保持し、onUpdate クロージャ
  // （マウント時に 1 回だけ配線、state のクロージャは stale）からでも dedup 判定できるようにする
  // （AC-4: 表示は常に高々 1 件）。
  const [remoteHubNotice, setRemoteHubNotice] = useState<string | null>(null)
  const remoteHubNoticeRef = useRef<string | null>(null)
  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [])

  /**
   * notice を表示し、約4秒後に自動で消す（AC-4）。連続で呼ばれた場合は前回のタイマーを
   * 解除してから新しい notice をセットし直す（複数タイマーの重複起動を防ぐ）。
   */
  const showNotice = (message: string): void => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current)
    }
    setNotice(message)
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null
      if (mountedRef.current) {
        setNotice(null)
      }
    }, FOCUS_NOTICE_DURATION_MS)
  }

  useEffect(() => {
    polling.onUpdate((rows) => {
      store.setInstances(rows)
      setError(null)

      // release-25-auto-update FR-04 AC-1〜AC-4: hub 版 < 自版、またはヘッダ欠落（版不明）を
      // 'unknown' として旧版と同じ経路に倒す（version-compare.ts の設計方針）。'same'/'newer' なら
      // notice を消す。直前と同一文字列なら setState を呼ばない（dedup、AC-4）。
      const hubVersionComparison = compareVersion(hubVersionRef.current)
      const nextRemoteHubNotice =
        hubVersionComparison === 'older' || hubVersionComparison === 'unknown'
          ? t('autoUpdate.remoteHubOutdated', {
              hubVersion: hubVersionRef.current ?? t('cli.hubStatus.versionUnknown'),
              selfVersion: MONOMI_VERSION,
            })
          : null
      if (nextRemoteHubNotice !== remoteHubNoticeRef.current) {
        remoteHubNoticeRef.current = nextRemoteHubNotice
        setRemoteHubNotice(nextRemoteHubNotice)
      }

      // stdout がバックプレッシャー中は再描画トリガーだけ間引く（データ更新は継続し、
      // ドレイン後の次回描画で最新状態が反映されるようにする, FR-02 AC-2）。
      if (!isStdoutBackpressured(stdout, DEFAULT_BACKPRESSURE_THRESHOLD_BYTES)) {
        bump()
      }
    })
    polling.onError((err) => {
      setError(String(err))
      if (!isStdoutBackpressured(stdout, DEFAULT_BACKPRESSURE_THRESHOLD_BYTES)) {
        bump()
      }
    })
    // watch モードを既定 ON にする（FR-03 AC-1/AC-3）。start() は内部で即時 refresh() を
    // 実行するため、初回全件表示（AC-1）は維持したまま起動直後から isRunning()===true になる。
    polling.start()
    return () => polling.stop()
    // store / polling は ref で安定。bump は useCallback で安定。stdout（useStdout() 由来）は
    // マウント中同一参照を保つため、実質的にマウント時 1 回だけ配線される（FR-02 AC-2 で
    // isStdoutBackpressured の判定に使うため依存配列に追加）。
  }, [store, polling, bump, stdout])

  // release-20-dashboard-heap-guard FR-04 AC-1/AC-2: 詳細ビュー表示中は一覧側 PollingLoop を止め、
  // 一覧表示へ戻ったら再開する（既知課題 B5 の解消）。start()/stop() は冪等
  // （polling-loop.ts 142-162行, timer!==null で早期 return）なので、マウント用 useEffect（上）が
  // 既に start() 済みの状態でこの effect が重ねて start()/stop() を呼んでも安全。詳細中は
  // `polling.onUpdate` 自体が呼ばれなくなるため store.setInstances()/bump() も発生しなくなり
  // （AC-1・AC-3）、一覧へ戻ると start() の内部即時 refresh() で最新データが反映される（AC-4）。
  // DetailView は自身の独立した PollingLoop を持つため、ここでは一覧側のみを制御すればよい。
  useEffect(() => {
    if (viewMode === 'detail') {
      polling.stop()
    } else {
      polling.start()
    }
  }, [viewMode, polling])

  // release-20-dashboard-heap-guard FR-03 AC-1: store.filtered() は1レンダー1回だけ呼び、
  // 以降の派生値（projectRows/counts/deviceCount・host のクランプ計算）は全てこの結果を再利用する。
  // store は ref で安定なミュータブル参照のため、依存配列には値そのものではなく
  // setInstances/toggleFilter が更新のたびに新配列を作る store.instances / store.activeFilters を
  // 使い、実データが変わらない限り再計算されないようにする（両者はコールバック内のテキストには
  // 現れないが、変更検知のトリガーとして依存配列に必須）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 上記の理由で store.instances/store.activeFilters を意図的に依存配列へ含める。
  const filteredRows = useMemo(
    () => store.filtered(),
    [store, store.instances, store.activeFilters]
  )
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
      // FR-03 AC-1: store.filtered() を再度呼ばず、同一レンダーで既に計算済みの filteredRows を
      // 使う（host はレンダーごとに作り直されるため、常に最新の filteredRows を捕捉している）。
      const length = filteredRows.length
      if (length === 0) return
      setSelectedIndex((current) => {
        const clamped = Math.min(Math.max(current, 0), length - 1)
        return Math.min(Math.max(clamped + delta, 0), length - 1)
      })
    },
    openDetail: () => {
      // 選択は既存 selectedIndex をそのまま使い、表示 instance は selectedRow から導出する
      // （detailRow スナップショットは持たない, release-6 FR-04 AC-3）。空一覧では開かない。
      if (filteredRows.length === 0) return
      setViewMode('detail')
    },
    moveProject: (delta) => {
      // FR-04 AC-1/AC-2: 一覧の並び順で前後 instance へ移動し、端では反対側へ循環する。
      // len===0 は no-op。current を範囲クランプしてから wrap し、負値を避けるため +length する。
      const length = filteredRows.length
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
    // release-23-terminal-focus FR-05c: `f`。selectedRow は同一レンダーで既に計算済みの値を
    // 使う（host はレンダーごとに作り直されるため常に最新を捕捉している、moveSelection と同じ理由）。
    focusTerminal: () => {
      // ①行なし → no-op（filteredRows が空のときのみ undefined になる）。
      if (selectedRow === undefined) return

      // ②別デバイスの行 → 実行せず理由 notice（AC-2）。
      if (selectedRow.device.id !== localDeviceId) {
        showNotice(t('focus.otherDevice'))
        return
      }

      // ③closed 行 → 実行せず理由 notice（stale TTY 誤爆防止、AC-3）。
      if (selectedRow.status.display === 'closed') {
        showNotice(t('focus.sessionClosed'))
        return
      }

      // ④terminal 情報なし/検証不合格 → 実行せず理由 notice（AC-3）。tty・tmuxPane・weztermPane の
      // いずれも無ければどの strategy にも到達できないため、focusRunner を呼ばずここで縮退させる。
      // release-28-wezterm-focus 実機検証で判明した所見への対応: WSL2 の resolve_tty() が不正な値
      // （例 `/dev/?`）を返し tty 検証が null に落ちても weztermPane が有効なら WezTerm 経路が
      // 機能しうるため、focus-service.ts の no_terminal 判定（AC-7）と同じ条件に揃える。
      const target = toFocusTarget(selectedRow.session.terminal)
      if (
        target === null ||
        (target.tty === null && target.tmuxPane === null && target.weztermPane === null)
      ) {
        showNotice(t('focus.noTerminalInfo'))
        return
      }

      // ⑤実行。成功時（'ok'）は notice を出さない（タブ移動自体がフィードバック、AC-4）。
      // 失敗時のみ理由別 notice。focusRunner が想定外に reject した場合も failed 相当に丸める。
      void focusRunner(target)
        .then((result) => {
          if (result === 'ok' || !mountedRef.current) return
          showNotice(noticeForFocusResult(result))
        })
        .catch(() => {
          if (mountedRef.current) {
            showNotice(t('focus.failed'))
          }
        })
    },
  }
  const controller = new KeyBindingController(store, host)

  useInput((input, key) => {
    // release-20-dashboard-heap-guard FR-03 AC-3: handleKey が「操作をディスパッチしたか」を
    // 返すようになったため、無効キー（未割当のキー入力）では bump() を呼ばず無駄な再描画を防ぐ。
    const dispatched = controller.handleKey(
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
    if (dispatched) {
      bump()
    }
  })

  // FR-03 AC-2: 集計系の派生値を useMemo 化する。countByDisplay は全件（store.instances）基準、
  // projectRows/deviceCount は既に計算済みの filteredRows を再利用するため、依存が変わらない限り
  // （watching インジケータの点滅・ヘルプ開閉などの無関係な再描画をまたいでも）再計算されない。
  const counts = useMemo(() => countByDisplay(store.instances), [store.instances])
  const projectRows = useMemo(() => store.projectRows(filteredRows), [store, filteredRows])
  const projectCount = projectRows.length
  const deviceCount = useMemo(
    () => new Set(filteredRows.map((row) => row.device.id)).size,
    [filteredRows]
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text backgroundColor="blue" bold>
          {' Monomi '}
        </Text>
        <Text dimColor> v{MONOMI_VERSION}</Text>
        <Text dimColor>
          {'  '}— {projectCount} projects · {deviceCount} devices
        </Text>
        <WatchingIndicator isRunning={polling.isRunning()} stdout={stdout} />
      </Text>

      {startupNotices.length > 0 || remoteHubNotice !== null ? (
        <Box flexDirection="column">
          {startupNotices.map((message) => (
            <Text key={message} color="yellow">
              {message}
            </Text>
          ))}
          {remoteHubNotice !== null ? <Text color="yellow">{remoteHubNotice}</Text> : null}
        </Box>
      ) : null}

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

      {error !== null ? (
        <Text color="red">
          {t('app.errorPrefix')}
          {error}
        </Text>
      ) : null}
      {notice !== null ? <Text color="yellow">{notice}</Text> : null}
      {showHelp ? (
        <Box marginTop={1}>
          <HelpOverlay />
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {footerHint(
            viewMode,
            selectedRow !== undefined && selectedRow.device.id === localDeviceId
          )}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * フッターのショートカットヒントを表示中のビューに応じて切り替える（FR-04 / release-6 FR-03 AC-1）。
 *
 * 詳細ビューではフィルタ（`1`-`6`）・詳細を開く（`Enter`）操作を出さず、代わりに詳細固有の
 * `j/k scroll`（イベントスクロール, {@link DetailView}）・`←/→ project`（隣接 instance 移動,
 * {@link KeyBindingController}）・`w wrap`（イベント行の折り返し/切り詰め切替, {@link DetailView}, FR-08）を
 * 提示する。
 *
 * `canFocusTerminal`（選択行の `device.id` が CLI 自身の device_id と一致するか）が true の
 * ときのみ末尾に ` f focus` を追加する（release-23-terminal-focus FR-05c、AC-5）。closed/
 * ターミナル情報なしなどの実行不可条件はここでは見ない（それらは実行時に理由 notice で示す）。
 *
 * @param viewMode 現在表示中のビュー。
 * @param canFocusTerminal 選択行が同一デバイスか（`f` ヒントの表示可否）。
 * @returns フッターに表示するヒント文字列。
 */
function footerHint(viewMode: ViewMode, canFocusTerminal: boolean): string {
  const focusSuffix = canFocusTerminal ? ' f focus' : ''
  return viewMode === 'detail'
    ? `j/k scroll ←/→ project w wrap esc back ? help q quit${focusSuffix}`
    : `1-6 filter j/k ↑↓ move ↵ detail esc back ? help q quit${focusSuffix}`
}

/**
 * 全 instance を表示状態ごとに件数集計する（フィルタバーの件数表示用）。
 *
 * @param rows 集計対象（フィルタ適用前の全件）。
 * @returns 表示状態 → 件数。フィルタ対象 6 状態は 0 で初期化する。
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
