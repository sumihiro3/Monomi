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
   * iTerm2 等の追加はこの配列へ足すだけでよい（AC-8）。`WeztermFocusStrategy`
   * （release-28-wezterm-focus FR-04）もこの配列へ含める形で組み込む（`weztermStrategy` とは別枠に
   * しない。darwin では既存の hint 総当たりにそのまま乗せられるため）。
   */
  darwinStrategies: Strategy[]
  /** tmux 経由でのフォーカス切替（`tmuxPane` があるとき先に呼ぶ、AC-5/AC-6）。 */
  tmuxStrategy: TmuxStrategy
  /** WSL2（Windows Terminal）向け best-effort フォーカス（AC-7）。 */
  wslStrategy: WslStrategy
  /**
   * WSL2 interop 経由で `wezterm.exe cli activate-pane` を試みる strategy
   * （release-28-wezterm-focus FR-04）。`target.weztermPane` があるとき {@link wslStrategy} より
   * 先に試す。省略時は WezTerm 経路を試さず、従来どおり {@link wslStrategy} 直行になる
   * （未配線でも壊れないよう optional にする）。
   */
  weztermWslStrategy?: Strategy
  /**
   * ネイティブ Linux（darwin でも WSL でもない）上で `wezterm cli activate-pane` を試みる strategy
   * （release-28-wezterm-focus FR-04）。`target.weztermPane` があるときにのみ使う。省略時、または
   * `weztermPane` が無い場合は従来どおり `unsupported_platform` になる。
   *
   * **`cli.ts` の既定実装では意図的に未配線（release-28-wezterm-focus スコープ縮小、実機検証後の
   * 決定）**: macOS で `activate-pane` 単体では OS レベルのウィンドウ前面化が起きないことが実機で
   * 判明したが、ネイティブ Linux 向けの前面化手段（X11/Wayland 非依存で書ける方法）が未検証のため、
   * ペイン内部状態だけ切り替わりウィンドウは前面化されない不完全な体験になる懸念が拭えない。
   * ディスパッチ構造自体は汎用のまま残しているため、前面化手段が実機検証できた時点で
   * `cli.ts` から再配線すれば足りる。
   */
  weztermStrategy?: Strategy
  /** 実行環境の platform（省略時 `process.platform`。テストで `'darwin'`/`'linux'` 等に固定する）。 */
  platform?: NodeJS.Platform
  /** WSL2 環境判定（省略時 {@link defaultIsWsl}）。 */
  isWsl?: () => boolean
}

/**
 * 検証済みの {@link FocusTarget} から実ターミナルのタブ/ウィンドウへフォーカスを移すディスパッチャ
 * （release-23-terminal-focus FR-04d、release-28-wezterm-focus FR-04 で拡張、AC-6）。
 *
 * ディスパッチ順:
 * 1. `tmuxPane` があれば、他のどの strategy よりも先に {@link TmuxStrategy.switchClient} を呼ぶ。
 *    成功時は返ってきた**外側クライアントの TTY** に差し替えて以降の判定を続ける（tmux ペイン内の
 *    pts では外側ターミナルを特定できないため）。失敗（`tmux_detached`/`error`）はそのまま最終結果
 *    として返す — tmux 経由と分かっている対象を tty 直アプローチへフォールバックさせても
 *    タブを見つけられる見込みが薄いため。あわせて `target.weztermPane` は `null` へ縮退させる
 *    （release-28-wezterm-focus FR-04 AC-5、review-changes 修正: tmux 併用時の WezTerm ペイン特定は
 *    スコープ外のため再解決の仕組みが無く、tmux 切替前に捕捉した値は切替後の外側クライアントに
 *    対応するとは限らない — 別クライアントから同一 tmux セッションへ attach していた場合、誤った
 *    ペインを前面化しうる。null 化により以降の分岐は既存の tty ベースフォールバックのみを使う）。
 * 2. （tmux 切替後を含め）tty と weztermPane の両方が無ければ `no_terminal`（review-changes 修正:
 *    reporter が tty を解決できない環境でも `weztermPane` があれば WezTerm 経路は機能しうるため、
 *    tty 単独では強制終了させない。ARCHITECTURE.md §14.3 の「不合格フィールドは個別に null へ
 *    縮退し、他の有効フィールドで strategy が機能しうる」規約に合わせる）。
 * 3. `platform === 'darwin'` なら `darwinStrategies` を `term_program` ヒントに一致するものを
 *    先頭へ寄せた順で総当たりし、`ok` が出た時点で確定する。tmux 内では `TERM_PROGRAM` が
 *    `'tmux'` になりヒントにならないため、この場合は配列順そのままの総当たりになる（想定通り）。
 *    全滅した場合は最後に試した strategy の結果（`not_found`/`error`）をそのまま返す。`WezTerm`
 *    ユーザーは `darwinStrategies` に含まれる `WeztermFocusStrategy`（cli.ts が配線）がこの総当たり
 *    に自然に乗る。
 * 4. darwin でなく {@link FocusServiceOptions.isWsl} が true（WSL2）なら、`target.weztermPane` が
 *    あり {@link FocusServiceOptions.weztermWslStrategy} が配線済みなら先にそれを試す。`ok` なら
 *    確定、そうでなければ（`weztermPane` が無い場合を含め）従来どおり `wslStrategy.focus`
 *    （Windows Terminal 前面化）へフォールバックする。
 * 5. それ以外（ネイティブ Linux 等）は、`target.weztermPane` があり
 *    {@link FocusServiceOptions.weztermStrategy} が配線済みならその結果を返す。どちらか欠ければ
 *    `unsupported_platform`。
 *
 * strategy が例外を投げても `focus()` 自体は必ず {@link FocusResult} で解決する（想定外の例外は
 * `'error'` に丸める）。CLI 側（FR-05）はこの戻り値だけを見て notice の出し分けを行えばよい。
 */
export class FocusService {
  private readonly darwinStrategies: Strategy[]
  private readonly tmuxStrategy: TmuxStrategy
  private readonly wslStrategy: WslStrategy
  private readonly weztermWslStrategy: Strategy | undefined
  private readonly weztermStrategy: Strategy | undefined
  private readonly platform: NodeJS.Platform
  private readonly isWsl: () => boolean

  /**
   * @param options strategy 群・platform 判定の依存（{@link FocusServiceOptions}）。
   */
  constructor(options: FocusServiceOptions) {
    this.darwinStrategies = options.darwinStrategies
    this.tmuxStrategy = options.tmuxStrategy
    this.wslStrategy = options.wslStrategy
    this.weztermWslStrategy = options.weztermWslStrategy
    this.weztermStrategy = options.weztermStrategy
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
    let weztermPane = target.weztermPane

    if (target.tmuxPane !== null) {
      const outcome = await this.switchTmuxClient(target)
      if (outcome.result !== 'ok') {
        return outcome.result
      }
      tty = outcome.tty
      // tmux 併用時の WezTerm ペイン特定はスコープ外（FR-04 AC-5）。tmux 切替前に捕捉した
      // weztermPane を切替後もそのまま使うと、別クライアント経由で同一 tmux セッションへ
      // attach していた場合などに誤ったペインを前面化しうるため null へ縮退させる
      // （review-changes 修正）。
      weztermPane = null
    }

    if (tty === null && weztermPane === null) {
      return 'no_terminal'
    }

    // tmux 切替が発生した場合、strategy 群が参照する `target.tty`/`target.weztermPane` を
    // tmux 切替後の値へ差し替えた上で渡す（release-28-wezterm-focus FR-04-pre で strategy が
    // `tty` 単独ではなく `target` 全体を受け取るようになったため、tmux 切替後の値も target 経由で
    // 伝える必要がある）。
    const resolvedTarget: FocusTarget = { ...target, tty, weztermPane }

    if (this.platform === 'darwin') {
      return this.focusDarwin(resolvedTarget)
    }

    if (this.isWsl()) {
      return this.focusWsl(resolvedTarget)
    }

    return this.focusNativeLinux(resolvedTarget)
  }

  /** darwin 上で strategy を hint 順に総当たりする（AC-6 手順 3）。 */
  private async focusDarwin(target: FocusTarget): Promise<FocusResult> {
    const ordered = orderByHint(this.darwinStrategies, target)
    let last: FocusResult = 'not_found'
    for (const strategy of ordered) {
      last = await this.runStrategy(strategy, target)
      if (last === 'ok') {
        return last
      }
    }
    return last
  }

  /**
   * WSL2 上でのフォーカス（AC-6 手順 4、release-28-wezterm-focus FR-04）。
   *
   * `target.weztermPane` があり {@link weztermWslStrategy} が配線済みなら先に試す（`ok` で確定）。
   * それ以外（`weztermPane` が無い／未配線／`weztermWslStrategy` が `ok` 以外を返した場合）は
   * 従来どおり {@link wslStrategy}（Windows Terminal 前面化）へフォールバックする。
   */
  private async focusWsl(target: FocusTarget): Promise<FocusResult> {
    if (target.weztermPane !== null && this.weztermWslStrategy !== undefined) {
      const weztermResult = await this.runStrategy(this.weztermWslStrategy, target)
      if (weztermResult === 'ok') {
        return weztermResult
      }
    }
    return this.runWslStrategy(target.tty)
  }

  /**
   * ネイティブ Linux（darwin でも WSL でもない）上でのフォーカス（AC-6 手順 5、
   * release-28-wezterm-focus FR-04）。
   *
   * `target.weztermPane` があり {@link weztermStrategy} が配線済みならその結果を返す。どちらか
   * 欠ければ従来どおり `unsupported_platform`。
   */
  private async focusNativeLinux(target: FocusTarget): Promise<FocusResult> {
    if (target.weztermPane !== null && this.weztermStrategy !== undefined) {
      return this.runStrategy(this.weztermStrategy, target)
    }
    return 'unsupported_platform'
  }

  /** 1 つの {@link Strategy} を実行し、例外は `'error'` へ丸める。 */
  private async runStrategy(strategy: Strategy, target: FocusTarget): Promise<FocusResult> {
    try {
      return await strategy.focus(target)
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
  private async runWslStrategy(tty: string | null): Promise<FocusResult> {
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
