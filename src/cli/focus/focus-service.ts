import fs from 'node:fs'
import type { FocusResult, FocusTarget, Strategy, TmuxStrategy, WslStrategy } from './types.js'

/** {@link defaultIsWsl} の依存差し替え（テスト用）。 */
export interface WslDetectionOptions {
  /** 参照する環境変数集合。省略時は `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** `/proc/version` を読む関数。省略時は実 `fs.readFileSync`。ファイル不在等は例外を投げてよい。 */
  readProcVersion?: () => string
}

/**
 * WSL2 環境かどうかを判定する（FR-04 AC-6: `WSL_DISTRO_NAME` または `/proc/version` の
 * `"microsoft"` 含有）。`process.platform` は WSL2 上でも `'linux'` を返すため、darwin 判定の
 * 次にこの関数で判定する必要がある。
 *
 * @param options `env`/`readProcVersion` の差し替え（省略可、テスト用）。
 * @returns WSL2 環境と判定できれば true。
 */
export function defaultIsWsl(options: WslDetectionOptions = {}): boolean {
  const env = options.env ?? process.env
  if (env.WSL_DISTRO_NAME) {
    return true
  }
  const readProcVersion =
    options.readProcVersion ?? (() => fs.readFileSync('/proc/version', 'utf8'))
  try {
    return /microsoft/i.test(readProcVersion())
  } catch {
    // /proc/version が無い（macOS 等）・読み取り失敗はいずれも「WSL ではない」として扱う。
    return false
  }
}

/**
 * {@link FocusService} の依存（strategy 群 + platform 判定。FR-04 AC-6/AC-8）。
 */
export interface FocusServiceOptions {
  /**
   * darwin 上で総当たりする {@link Strategy} 群（`term_program` ヒントで並べ替える）。
   * iTerm2 等の追加はこの配列へ足すだけでよい（AC-8）。
   */
  darwinStrategies: Strategy[]
  /** tmux 経由でのフォーカス切替（`tmuxPane` があるとき先に呼ぶ、AC-5/AC-6）。 */
  tmuxStrategy: TmuxStrategy
  /** WSL2（Windows Terminal）向け best-effort フォーカス（AC-7）。 */
  wslStrategy: WslStrategy
  /** 実行環境の platform（省略時 `process.platform`。テストで `'darwin'`/`'linux'` 等に固定する）。 */
  platform?: NodeJS.Platform
  /** WSL2 環境判定（省略時 {@link defaultIsWsl}）。 */
  isWsl?: () => boolean
}

/**
 * 検証済みの {@link FocusTarget} から実ターミナルのタブ/ウィンドウへフォーカスを移すディスパッチャ
 * （release-23-terminal-focus FR-04d、AC-6）。
 *
 * ディスパッチ順:
 * 1. `tmuxPane` があれば、他のどの strategy よりも先に {@link TmuxStrategy.switchClient} を呼ぶ。
 *    成功時は返ってきた**外側クライアントの TTY** に差し替えて以降の判定を続ける（tmux ペイン内の
 *    pts では外側ターミナルを特定できないため）。失敗（`tmux_detached`/`error`）はそのまま最終結果
 *    として返す — tmux 経由と分かっている対象を tty 直アプローチへフォールバックさせても
 *    タブを見つけられる見込みが薄いため。
 * 2. （tmux 切替後を含め）tty が無ければ `no_terminal`。
 * 3. `platform === 'darwin'` なら `darwinStrategies` を `term_program` ヒントに一致するものを
 *    先頭へ寄せた順で総当たりし、`ok` が出た時点で確定する。tmux 内では `TERM_PROGRAM` が
 *    `'tmux'` になりヒントにならないため、この場合は配列順そのままの総当たりになる（想定通り）。
 *    全滅した場合は最後に試した strategy の結果（`not_found`/`error`）をそのまま返す。
 * 4. darwin でなく {@link FocusServiceOptions.isWsl} が true なら `wslStrategy.focus` の結果を返す。
 * 5. それ以外（Linux ネイティブ等）は `unsupported_platform`。
 *
 * strategy が例外を投げても `focus()` 自体は必ず {@link FocusResult} で解決する（想定外の例外は
 * `'error'` に丸める）。CLI 側（FR-05）はこの戻り値だけを見て notice の出し分けを行えばよい。
 */
export class FocusService {
  private readonly darwinStrategies: Strategy[]
  private readonly tmuxStrategy: TmuxStrategy
  private readonly wslStrategy: WslStrategy
  private readonly platform: NodeJS.Platform
  private readonly isWsl: () => boolean

  /**
   * @param options strategy 群・platform 判定の依存（{@link FocusServiceOptions}）。
   */
  constructor(options: FocusServiceOptions) {
    this.darwinStrategies = options.darwinStrategies
    this.tmuxStrategy = options.tmuxStrategy
    this.wslStrategy = options.wslStrategy
    this.platform = options.platform ?? process.platform
    this.isWsl = options.isWsl ?? (() => defaultIsWsl())
  }

  /**
   * `target` が指すセッションの実行中ターミナルへフォーカスを移す。
   *
   * @param target `focus-target.ts#toFocusTarget` が返す検証済みフォーカス対象。呼び出し側が
   *   まだ null 判定を済ませていない場合に備え `null` も受け付け、その場合は `no_terminal` を返す。
   * @returns フォーカス結果。
   */
  async focus(target: FocusTarget | null): Promise<FocusResult> {
    if (target === null) {
      return 'no_terminal'
    }

    let tty = target.tty

    if (target.tmuxPane !== null) {
      const outcome = await this.switchTmuxClient(target)
      if (outcome.result !== 'ok') {
        return outcome.result
      }
      tty = outcome.tty
    }

    if (tty === null) {
      return 'no_terminal'
    }

    if (this.platform === 'darwin') {
      return this.focusDarwin(tty, target)
    }

    if (this.isWsl()) {
      return this.focusWsl(tty)
    }

    return 'unsupported_platform'
  }

  /** darwin 上で strategy を hint 順に総当たりする（AC-6 手順 3）。 */
  private async focusDarwin(tty: string, target: FocusTarget): Promise<FocusResult> {
    const ordered = orderByHint(this.darwinStrategies, target)
    let last: FocusResult = 'not_found'
    for (const strategy of ordered) {
      last = await this.runStrategy(strategy, tty)
      if (last === 'ok') {
        return last
      }
    }
    return last
  }

  /** 1 つの {@link Strategy} を実行し、例外は `'error'` へ丸める。 */
  private async runStrategy(strategy: Strategy, tty: string): Promise<FocusResult> {
    try {
      return await strategy.focus(tty)
    } catch {
      return 'error'
    }
  }

  /** {@link TmuxStrategy.switchClient} を実行し、例外は `{ result: 'error' }` へ丸める。 */
  private async switchTmuxClient(target: FocusTarget): ReturnType<TmuxStrategy['switchClient']> {
    try {
      return await this.tmuxStrategy.switchClient(target)
    } catch {
      return { result: 'error' }
    }
  }

  /** {@link WslStrategy.focus} を実行し、例外は `'error'` へ丸める。 */
  private async focusWsl(tty: string): Promise<FocusResult> {
    try {
      return await this.wslStrategy.focus(tty)
    } catch {
      return 'error'
    }
  }
}

/**
 * `term_program` ヒントに一致する strategy を先頭へ寄せた順序へ並べ替える（安定ソート、AC-6）。
 *
 * ヒントに一致するものが無い（tmux 内など）場合は元の配列順のまま返す ＝ 単純な総当たりになる。
 *
 * @param strategies 並べ替え対象（元配列は変更しない）。
 * @param target ヒント判定に使う検証済みフォーカス対象。
 * @returns 並べ替え後の配列。
 */
function orderByHint(strategies: Strategy[], target: FocusTarget): Strategy[] {
  const matched = strategies.filter((s) => s.matchesHint(target))
  const rest = strategies.filter((s) => !s.matchesHint(target))
  return [...matched, ...rest]
}
