/**
 * `src/cli/focus/` 内で共有する型（release-23 FR-04 基盤）。
 *
 * `focus-target.ts` と各 strategy（`terminal-app-strategy.ts`・`ghostty-strategy.ts` 等、
 * FR-04b 以降）・`focus-service.ts`（FR-04f 以降）の双方が参照する型をここへ独立させることで、
 * 「strategy が focus-target.ts を import し、focus-target.ts が strategy を import し返す」
 * という循環を避ける（strategy ↔ service は互いに `types.ts` のみを参照する）。
 */

/**
 * フォーカス実行 1 回の結果種別（FR-04 AC-6）。
 *
 * - `ok`: 対象タブ/ウィンドウの前面化に成功した。
 * - `no_terminal`: 対象セッションにターミナル特定情報が無い（旧 reporter 由来、または非 TTY 実行）。
 * - `tmux_detached`: `tmux_pane` はあるが attach 中の client が 0 件（tmux-strategy 固有）。
 * - `not_found`: いずれの strategy でも対象タブ/ウィンドウを特定できなかった。
 * - `unsupported_platform`: 対応ターミナル/OS の組み合わせ外（dispatch がどの strategy にも
 *   到達しなかった場合を含む）。
 * - `error`: strategy 実行中に想定外の例外が発生した。
 */
export type FocusResult =
  | 'ok'
  | 'no_terminal'
  | 'tmux_detached'
  | 'not_found'
  | 'unsupported_platform'
  | 'error'

/**
 * 検証・サニタイズ済みのフォーカス対象情報（`focus-target.ts#toFocusTarget` の出力）。
 *
 * wire の `TerminalDto`（snake_case、FR-03）と 1:1 対応するが、こちらは camelCase かつ
 * 各フィールドが個別に厳格検証済み（不合格は `null` へ縮退。FR-04 AC-1）。
 */
export interface FocusTarget {
  /** 検証済み TTY（例 `/dev/ttys003`）。不明・検証不合格は `null`。 */
  tty: string | null
  /** `$TERM_PROGRAM` ヒント（darwin での strategy 順序決定に使う）。検証は行わない。 */
  termProgram: string | null
  /** 検証済み tmux pane 識別子（例 `%3`）。不明・検証不合格は `null`。 */
  tmuxPane: string | null
  /** 検証済み tmux socket 絶対パス。不明・検証不合格は `null`。 */
  tmuxSocket: string | null
  /** `$WSL_DISTRO_NAME` ヒント（WSL 判定に使う）。検証は行わない。 */
  wslDistro: string | null
  /** `$WT_SESSION`。データ保持のみ（タブ単位フォーカスはスコープ外）。 */
  wtSession: string | null
  /** 検証済み WezTerm pane id（`wezterm cli activate-pane --pane-id` 用）。不明・検証不合格は `null`。 */
  weztermPane: string | null
}

/**
 * ターミナル別フォーカス実行 strategy の共通インターフェイス（FR-04 AC-8）。
 *
 * `terminal-app-strategy.ts`・`ghostty-strategy.ts`（FR-04b 以降）がこれを実装する。
 * iTerm2 等の対応追加は、この形の strategy をディスパッチ配列へ足すだけで済む構造にするための
 * 抽象化点（要件のスコープ外事項の受け皿）。
 */
export interface Strategy {
  /**
   * この strategy を優先候補として並べ替えるべきかのヒント判定
   * （darwin: `term_program` 一致で Terminal.app / Ghostty の順序を決める、FR-04 AC-6）。
   *
   * false を返しても総当たり対象からは除外しない（順序決定のみに使う）。
   *
   * @param target 検証済みフォーカス対象。
   * @returns ヒントが一致するなら true。
   */
  matchesHint(target: FocusTarget): boolean

  /**
   * 検証済みフォーカス対象へフォーカスを試みる（release-28-wezterm-focus FR-04-pre）。
   *
   * `WeztermFocusStrategy`（release-28 FR-03/FR-04 以降）は tty ではなく `target.weztermPane`
   * を必要とするため、`tty` 単独ではなく検証済み {@link FocusTarget} 全体を受け取る形に統一する。
   * `tty` のみを使う実装（`TerminalAppStrategy`・`GhosttyStrategy`）は `target.tty` が `null`
   * （reporter が TTY を解決できなかった場合。`weztermPane` のみ有効なケースを含む）なら自身で
   * `not_found` を返す（`focus-service.ts` は tty 単独では総当たりを止めないため、`tty !== null`
   * の保証はしない。各 strategy がフィールドごとに自身の前提を検証する、release-28-wezterm-focus
   * 所見対応）。
   *
   * @param target 検証済みフォーカス対象。
   * @returns フォーカス結果。
   */
  focus(target: FocusTarget): Promise<FocusResult>
}

/**
 * `tmux-strategy.ts`（FR-04b 以降）の切替結果。
 *
 * `switch-client` 等の対象は「tmux セッション内のペイン」であって外側ターミナルの tty ではない
 * ため、通常の {@link Strategy} とは違い専用の戻り値にする：成功時は解決できた**外側クライアント
 * の TTY** を伴い、`focus-service.ts`（FR-04d 以降）はそれを使って darwin/WSL 判定へ続行する
 * （FR-04 AC-5/AC-6）。判別可能な union にして「`ok` なのに `tty` が無い」ような不整合状態を
 * 型で表現できないようにしている。
 */
export type TmuxSwitchOutcome =
  | { result: 'ok'; tty: string }
  | { result: 'tmux_detached' | 'error' }

/**
 * tmux-strategy（FR-04b 以降）が満たすインターフェイス。
 *
 * `focus-service.ts` は `tmuxPane` があるときに他の strategy より先にこれを呼ぶ（FR-04 AC-6）。
 */
export interface TmuxStrategy {
  /**
   * `tmuxPane`/`tmuxSocket` を使って attach 中のクライアントを解決し、`switch-client`/
   * `select-window`/`select-pane` で切り替える（FR-04 AC-5）。
   *
   * @param target 検証済みフォーカス対象（`tmuxPane`/`tmuxSocket` を使う）。
   * @returns 切替結果（成功時は外側クライアント TTY を伴う）。
   */
  switchClient(target: FocusTarget): Promise<TmuxSwitchOutcome>
}

/**
 * wsl-strategy（FR-04b 以降）が満たすインターフェイス。
 *
 * WSL2 上では Windows Terminal のウィンドウ前面化どまりの best-effort（タブ単位の特定は
 * スコープ外）のため、{@link Strategy} と違い `matchesHint` は持たない
 * （`focus-service.ts` の総当たり対象にも含めない。プラットフォーム判定で直接呼ぶ、FR-04 AC-6/AC-7）。
 */
export interface WslStrategy {
  /**
   * Windows Terminal のウィンドウを前面化する。
   *
   * @param tty 参考情報として渡す TTY（tmux 切替後の値を含みうる）。best-effort のため未使用でもよい。
   * @returns フォーカス結果。
   */
  focus(tty: string | null): Promise<FocusResult>
}
