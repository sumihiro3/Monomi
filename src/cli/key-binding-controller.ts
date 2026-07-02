import type { InstanceListStore } from './instance-list-store.js'
import type { PollingLoop } from './polling-loop.js'
import { filterForKey } from './status-display.js'

/**
 * Ink の `Key` のうち本 CLI が参照するフラグだけを抜き出した最小形。
 *
 * 単体テストで `Key` 全フィールドを組み立てずに済むよう部分集合にしている
 * （AppView が `useInput` の `key` からこの 4 つを詰め替える）。
 */
export interface KeyFlags {
  upArrow: boolean
  downArrow: boolean
  return: boolean
  escape: boolean
}

/**
 * store / polling で完結しない画面遷移・選択移動の受け口（AppView が React state で実装）。
 *
 * KeyBindingController はキー → 操作の対応だけを知り、選択位置やビュー状態そのものは持たない
 * （それらは AppView の React state の関心事）。
 */
export interface KeyBindingHost {
  /** 選択カーソルを相対移動する（`+1` 下 / `-1` 上）。範囲クランプは実装側。 */
  moveSelection(delta: number): void
  /** 選択中 instance の詳細ビューを開く（Enter）。 */
  openDetail(): void
  /** 戻る（esc）。ヘルプ表示中はヘルプを閉じ、詳細表示中は一覧へ戻す。 */
  back(): void
  /** ヘルプオーバーレイの表示/非表示を切り替える（`?`）。 */
  toggleHelp(): void
  /** アプリを終了する（`q`）。 */
  quit(): void
}

/**
 * キー入力をアクションへ写すコントローラ（class-diagram §4 / §10.3）。
 *
 * release-1 の対象キーのみを扱う（AC-5: ファジー検索 `/`・ソート `s`・デバイス循環 `d` は含めない）:
 * - `1`–`5`: 状態フィルタのトグル（{@link InstanceListStore.toggleFilter}、複数選択可）
 * - `w`: watch モードの ON/OFF（{@link PollingLoop} の start/stop）
 * - `j`/`k` と `↑`/`↓`: カーソル移動（vim 流・矢印両対応）
 * - `Enter`: 詳細（Agent View Lv.1）を開く
 * - `esc`: 戻る、`?`: ヘルプ、`q`: 終了
 *
 * View 状態（選択位置・モード）を持たず、判断ロジックも持たない薄い写像に徹する。
 */
export class KeyBindingController {
  /**
   * @param store フィルタ操作の対象。
   * @param polling watch モードの制御対象。
   * @param host 画面遷移・選択移動の受け口。
   */
  constructor(
    private readonly store: InstanceListStore,
    private readonly polling: PollingLoop,
    private readonly host: KeyBindingHost
  ) {}

  /**
   * 1 キー入力を対応する操作へディスパッチする。
   *
   * @param input `useInput` が渡す入力文字（矢印・Enter・esc では空文字）。
   * @param key 参照するキーフラグ。
   */
  handleKey(input: string, key: KeyFlags): void {
    const filter = filterForKey(input)
    if (filter !== null) {
      this.store.toggleFilter(filter)
      return
    }

    if (input === 'w') {
      this.toggleWatch()
      return
    }

    if (input === 'j' || key.downArrow) {
      this.host.moveSelection(1)
      return
    }
    if (input === 'k' || key.upArrow) {
      this.host.moveSelection(-1)
      return
    }

    if (key.return) {
      this.host.openDetail()
      return
    }
    if (key.escape) {
      this.host.back()
      return
    }
    if (input === '?') {
      this.host.toggleHelp()
      return
    }
    if (input === 'q') {
      this.host.quit()
    }
  }

  /** watch モードをトグルする（稼働中なら停止、停止中なら開始）。 */
  private toggleWatch(): void {
    if (this.polling.isRunning()) {
      this.polling.stop()
    } else {
      this.polling.start()
    }
  }
}
