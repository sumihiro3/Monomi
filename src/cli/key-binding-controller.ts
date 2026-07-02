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
 * release-1 の対象キーのみを扱う（AC-5: ファジー検索 `/`・ソート `s`・デバイス循環 `d` は含めない）。
 * watch モードは release-4 で常時 ON に変更されたため、トグル用のキーは持たない。
 *
 * `viewMode` が `'list'` のときのみ、フィルタ・カーソル移動・詳細を開く操作を受け付ける
 * （詳細表示中にこれらを裏で実行すると、一覧に戻った際の状態が誤操作で変わってしまうため）:
 * - `1`–`5`: 状態フィルタのトグル（{@link InstanceListStore.toggleFilter}、複数選択可）
 * - `j`/`k` と `↑`/`↓`: カーソル移動（vim 流・矢印両対応）
 * - `Enter`: 詳細（Agent View Lv.1）を開く
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
   * @param viewMode 現在表示中のビュー。`'detail'` 中はフィルタ・移動・詳細操作を無視する。
   */
  handleKey(input: string, key: KeyFlags, viewMode: ViewMode): void {
    if (viewMode === 'list') {
      const filter = filterForKey(input)
      if (filter !== null) {
        this.store.toggleFilter(filter)
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
}
