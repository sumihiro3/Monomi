import { Text } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import { t } from '../../i18n/index.js'

/** {@link WatchingIndicator} の props。 */
export interface WatchingIndicatorProps {
  /**
   * watch モード（ポーリング）が実行中かどうか。`PollingLoop` オブジェクトそのものではなく
   * boolean を渡す設計にしている。呼び出し側（`AppView`）は毎描画で新しい `PollingLoop` 参照を
   * 作らないため object 比較でも壊れないが、boolean にしておくことで `useEffect` の cleanup を
   * この値ひとつに確定的にキーでき（`[isRunning]`）、true→false 遷移時の `setInterval` クリア
   * （FR-02 AC-3）が素直に保証できる。
   */
  isRunning: boolean
}

/**
 * watch モード中に点滅する「● WATCHING」インジケータ（FR-02、`app-view.tsx` から分離）。
 *
 * @remarks 設計判断: なぜこのコンポーネントだけローカル state を持つか
 * このリポジトリの `components/*` は基本的に props をそのまま描くだけの presentational
 * コンポーネントで、状態は `AppView`（コンテナ）に集約する慣例になっている。本コンポーネントは
 * その慣例に対する意図的な例外であり、点滅トグル用の `visible` state と `setInterval` をここに
 * 閉じ込めている。理由は、`AppView` はすでに「無条件再レンダー・集計の重複計算」という既知の
 * 問題（P4、本リリースでは未修正）を抱えており、点滅の 500ms ごとの再描画トリガーを `AppView` の
 * state に混ぜると、`filteredRows` の再計算やカードグリッドの再描画を 500ms ごとに誘発して
 * P4 を悪化させてしまう。React は子コンポーネントの `setState` だけでは親を再レンダーしないため、
 * state をこの子に閉じ込めることで「点滅が `AppView` 本体の再レンダーを誘発しない」（FR-02 AC-2）
 * が構造的に保証される。
 *
 * `isRunning` が true の間だけ 1000ms 間隔で `visible` をトグルし、`WATCHING` の文字列表示/非表示を
 * 繰り返す（●自体は running 中常時表示、AC-1）。`isRunning` が false になった時点で非表示
 * （`null`）を返し、直前の `setInterval` は `useEffect` の cleanup で確実にクリアされる（AC-3）。
 * 当初は 500ms で実装したが、実機確認でのユーザーフィードバックにより体感の速さを半分にする
 * 1000ms へ変更した。
 *
 * @param props {@link WatchingIndicatorProps}。
 * @returns `isRunning` が false なら `null`。true なら点滅する `<Text>`。
 */
export function WatchingIndicator({ isRunning }: WatchingIndicatorProps): ReactElement | null {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!isRunning) {
      return
    }
    const id = setInterval(() => {
      setVisible((current) => !current)
    }, 1000)
    return () => clearInterval(id)
  }, [isRunning])

  if (!isRunning) {
    return null
  }

  // t() は必ず描画時に評価する（モジュールスコープ const での凍結禁止、../../i18n/index.js 参照）。
  return (
    <Text color="green">
      {'  '}● {visible ? t('app.watching') : ''}
    </Text>
  )
}
