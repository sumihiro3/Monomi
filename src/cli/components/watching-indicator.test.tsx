import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BACKPRESSURE_THRESHOLD_BYTES,
  type WritableLengthSource,
} from '../memory-watchdog.js'
import { WatchingIndicator } from './watching-indicator.js'

/** 非バックプレッシャーのフェイク stdout（`writableLength` は常に閾値未満）。 */
function fakeStdout(writableLength = 0): WritableLengthSource {
  return { writableLength }
}

/**
 * 実タイマーを使う（`vi.useFakeTimers()` は不使用）。
 *
 * 実装当初は `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` を試したが、Ink の
 * カスタムリコンサイラ上で React 19 が `setInterval` コールバック内の `setState` を
 * コミットするタイミングは `MessageChannel` 経由のスケジューラに乗っており、これは
 * fake timers（`@sinonjs/fake-timers`、`setTimeout`/`setInterval` 等のみ差し替え）の
 * 対象外のため、`advanceTimersByTimeAsync` では描画が一切更新されないことを実機で確認した
 * （`clearInterval` の呼び出し自体は同期なので、その検証だけは fake timers でも通っていた）。
 * このリポジトリの既存テスト（`app-view.test.tsx`・`detail-view.test.tsx`）も同じ理由で
 * 全面的に実タイマー + `vi.waitFor`/実 `setTimeout` を使っており、本ファイルもそれに合わせる。
 */

/** マウントした instance を必ず片付け、テスト間で実 `setInterval` が漏れないようにする。 */
let cleanupFns: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanupFns) fn()
  cleanupFns = []
})

describe('WatchingIndicator（FR-02）', () => {
  it('AC-1: isRunning=true の間、1000ms ごとに WATCHING の表示/非表示が切り替わる', async () => {
    const { lastFrame, unmount } = render(<WatchingIndicator isRunning stdout={fakeStdout()} />)
    cleanupFns.push(unmount)

    // マウント直後は visible=true → "● WATCHING" を含む。
    expect(lastFrame()).toContain('●')
    expect(lastFrame()).toContain('WATCHING')

    // 1000ms 経過で非表示側へトグル（"●" は常時表示のまま残り、"WATCHING" だけ消える）。
    await vi.waitFor(() => expect(lastFrame()).not.toContain('WATCHING'), { timeout: 3000 })
    expect(lastFrame()).toContain('●')

    // さらに 1000ms で再び表示側へ戻る。
    await vi.waitFor(() => expect(lastFrame()).toContain('WATCHING'), { timeout: 3000 })
  })

  it('AC-3: isRunning=false のとき何も描画しない（null）', () => {
    const { lastFrame, unmount } = render(
      <WatchingIndicator isRunning={false} stdout={fakeStdout()} />
    )
    cleanupFns.push(unmount)
    expect(lastFrame()).toBe('')
  })

  it('AC-4: アンマウント時に setInterval が clearInterval される', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const { unmount } = render(<WatchingIndicator isRunning stdout={fakeStdout()} />)

    unmount()

    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('AC-4: isRunning が true→false へ切り替わると setInterval がクリアされ、以後トグルしない', async () => {
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const { lastFrame, rerender, unmount } = render(
      <WatchingIndicator isRunning stdout={fakeStdout()} />
    )
    cleanupFns.push(unmount)
    expect(lastFrame()).toContain('WATCHING')

    rerender(<WatchingIndicator isRunning={false} stdout={fakeStdout()} />)

    // 直前の interval の cleanup が effect の入れ替わりで呼ばれる（AC-3 のクリーンアップ経路）。
    expect(clearSpy).toHaveBeenCalled()
    expect(lastFrame()).toBe('')

    // クリア済みなので、インターバル（1000ms）を跨いで待っても再表示されない（残留タイマーが無いことの確認）。
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(lastFrame()).toBe('')

    clearSpy.mockRestore()
  })
})

describe('WatchingIndicator — バックプレッシャー時は点滅トグルをスキップ（FR-02 AC-3）', () => {
  it('writableLength が閾値以上の間は 2200ms 待っても visible がトグルしない', async () => {
    const stdout = fakeStdout(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES)
    const { lastFrame, unmount } = render(<WatchingIndicator isRunning stdout={stdout} />)
    cleanupFns.push(unmount)

    // マウント直後は visible=true → "WATCHING" を含む。
    expect(lastFrame()).toContain('WATCHING')

    // 1000ms・2000ms の tick を跨いでもバックプレッシャー中はトグルされない。
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(lastFrame()).toContain('WATCHING')
  })

  it('バックプレッシャーがドレインされると次の tick から点滅トグルが再開する', async () => {
    const stdout = fakeStdout(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES)
    const { lastFrame, unmount } = render(<WatchingIndicator isRunning stdout={stdout} />)
    cleanupFns.push(unmount)
    expect(lastFrame()).toContain('WATCHING')

    // 1000ms 待ってもバックプレッシャー中はスキップされたまま。
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(lastFrame()).toContain('WATCHING')

    // ドレインされた（同一オブジェクトの writableLength を書き換え、次 tick の判定に反映させる）。
    stdout.writableLength = 0

    // ドレイン後の次 tick でトグルが再開し、非表示側へ切り替わる。
    await vi.waitFor(() => expect(lastFrame()).not.toContain('WATCHING'), { timeout: 3000 })
  })

  it('writableLength が閾値未満なら通常どおりトグルする（境界値: threshold - 1）', async () => {
    const stdout = fakeStdout(DEFAULT_BACKPRESSURE_THRESHOLD_BYTES - 1)
    const { lastFrame, unmount } = render(<WatchingIndicator isRunning stdout={stdout} />)
    cleanupFns.push(unmount)
    expect(lastFrame()).toContain('WATCHING')

    await vi.waitFor(() => expect(lastFrame()).not.toContain('WATCHING'), { timeout: 3000 })
  })
})
