import type { InstanceListStore } from './instance-list-store.js'
import { filterForKey } from './status-display.js'

/**
 * 表示中のビュー（AppView の React state と同じ語彙）。
 *
 * KeyBindingController はこれを state としては持たず、{@link KeyBindingController.handleKey}
 * の引数として都度受け取るだけ（薄い写像を保つ）。
 */
export type ViewMode = 'list' | 'detail'

/**
 * Ink の `Key` のうち本 CLI が参照するフラグだけを抜き出した最小形。
 *
 * 単体テストで `Key` 全フィールドを組み立てずに済むよう部分集合にしている
 * （AppView が `useInput` の `key` からこの 6 つを詰め替える）。
 */
export interface KeyFlags {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
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
  /**
   * 詳細ビュー中に、一覧の並び順で隣接する instance へ移動する（`+1` 次 / `-1` 前、FR-04 AC-1）。
   *
   * 端での循環（wrap、FR-04 AC-2）は実装側（AppView）が担う。KeyBindingController は
   * delta を渡すだけで、選択位置の実体（`selectedIndex`）や wrap 判定は持たない。
   */
  moveProject(delta: number): void
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
 * release-1 の対象キーのみを扱う（AC-5: ファジー検索 `/`・ソート `s`・デバイス循環 `d` は含めない）。
 * watch モードは release-4 で常時 ON に変更されたため、トグル用のキーは持たない。
 *
 * `viewMode` が `'list'` のときのみ、フィルタ・カーソル移動・詳細を開く操作を受け付ける
 * （詳細表示中にこれらを裏で実行すると、一覧に戻った際の状態が誤操作で変わってしまうため）:
 * - `1`–`6`: 状態フィルタのトグル（{@link InstanceListStore.toggleFilter}、複数選択可）
 * - `j`/`k` と `↑`/`↓`: カーソル移動（vim 流・矢印両対応）
 * - `Enter`: 詳細（Agent View Lv.1）を開く
 *
 * `viewMode` が `'detail'` のときは `←`/`→` を隣接プロジェクト移動へ写す（FR-04）:
 * - `←`: {@link KeyBindingHost.moveProject}(-1)、`→`: {@link KeyBindingHost.moveProject}(+1)
 *
 * `j`/`k`・`↑`/`↓` は release-4 では詳細表示中は無視していたが、release-6 でイベント履歴の
 * スクロールへ再割当てされた（FR-02 AC-3）。ただしそのスクロールは `DetailView` 自身が
 * 独自の `useInput` で直接消費するため、本 controller では list モードのときのみ処理し、
 * detail モードでは（前述の `←`/`→` 以外）一切ディスパッチしない。
 *
 * `viewMode` によらず常に有効:
 * - `esc`: 戻る（ヘルプを閉じる／詳細から一覧へ）、`?`: ヘルプ、`q`: 終了
 *
 * View 状態（選択位置・モード）を持たず、判断ロジックも持たない薄い写像に徹する。
 */
export class KeyBindingController {
  /**
   * @param store フィルタ操作の対象。
   * @param host 画面遷移・選択移動の受け口。
   */
  constructor(
    private readonly store: InstanceListStore,
    private readonly host: KeyBindingHost
  ) {}

  /**
   * 1 キー入力を対応する操作へディスパッチする。
   *
   * @param input `useInput` が渡す入力文字（矢印・Enter・esc では空文字）。
   * @param key 参照するキーフラグ。
   * @param viewMode 現在表示中のビュー。`'detail'` 中はフィルタ・カーソル移動・詳細を開く操作
   *   を無視する。`j`/`k`・`↑`/`↓` も detail 中は無視する（`DetailView` 自身のイベントスクロール
   *   が消費するため）。`←`/`→` のみ detail 中に隣接プロジェクト移動へ写す（FR-04）。
   * @returns 操作をディスパッチしたか（= 状態が変わり得るハンドル済みキーだったか、
   *   release-20-dashboard-heap-guard FR-03 AC-3）。呼び出し側（`AppView` の `useInput`）は
   *   これが `true` のときのみ再描画トリガー（`bump()`）を呼び、無効キーでの無駄な再描画を防ぐ。
   */
  handleKey(input: string, key: KeyFlags, viewMode: ViewMode): boolean {
    if (viewMode === 'list') {
      const filter = filterForKey(input)
      if (filter !== null) {
        this.store.toggleFilter(filter)
        return true
      }

      if (input === 'j' || key.downArrow) {
        this.host.moveSelection(1)
        return true
      }
      if (input === 'k' || key.upArrow) {
        this.host.moveSelection(-1)
        return true
      }

      if (key.return) {
        this.host.openDetail()
        return true
      }
    }

    if (viewMode === 'detail') {
      if (key.leftArrow) {
        this.host.moveProject(-1)
        return true
      }
      if (key.rightArrow) {
        this.host.moveProject(1)
        return true
      }
    }

    if (key.escape) {
      this.host.back()
      return true
    }
    if (input === '?') {
      this.host.toggleHelp()
      return true
    }
    if (input === 'q') {
      this.host.quit()
      return true
    }
    return false
  }
}
