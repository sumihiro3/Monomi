import { execFile as nodeExecFile } from 'node:child_process'
import type { FocusResult, FocusTarget, Strategy } from './types.js'

/**
 * WezTerm 公式 CLI 実行に使う `execFile` の最小 signature（release-28-wezterm-focus FR-03b）。
 *
 * `wsl-strategy.ts` の `ExecFileFn` と同じ形（`hub-autostart.ts` の `SpawnFn` 注入パターンを踏襲）。
 * `options.timeout` は review-changes 修正（下記 {@link WEZTERM_EXEC_TIMEOUT_MS}）で追加した任意
 * 引数で、`github-pr-poller.ts` の `ExecFileFn` が `options.signal` を持つのと同じ「テストから
 * 呼び出しパラメータを検証できるようにする」動機で公開している。
 */
export type ExecFileFn = (
  command: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>

/**
 * WezTerm CLI 呼び出し 1 回あたりの既定タイムアウト（review-changes 修正: `execFile` に timeout が
 * 無く、`wezterm`/`wezterm.exe` がハング（WSL interop 劣化時等）すると `focus()` の Promise が
 * 永久に解決せず、`f` キー連打のたびに子プロセスが蓄積し続けていた medium severity 所見への対応）。
 * `github-pr-poller.ts` の `GH_EXEC_TIMEOUT_MS`（15秒、GitHub API 往復を含む）と異なり、こちらは
 * ローカル/WSL interop 経由の CLI 呼び出しでネットワーク往復を伴わないため短めの 5 秒にする。
 */
const WEZTERM_EXEC_TIMEOUT_MS = 5_000

/**
 * `node:child_process.execFile` を Promise 化した既定実装。
 *
 * `wsl-strategy.ts` の `defaultExecFile` と同じ理由（`execFile` のコールバックオーバーロード解決に
 * 依存せず戻り値の型を固定するため）で `util.promisify` ではなく明示的な `Promise` ラップにする。
 * `options.timeout` を `node:child_process` の `timeout`（既定 {@link WEZTERM_EXEC_TIMEOUT_MS}）へ
 * そのまま渡す。Node はこの値を超えて子プロセスが生存していると `killSignal`（既定 `SIGTERM`）で
 * 自動的に kill したうえで callback を `error` 付きで呼ぶため、呼び出し側で個別に kill 処理を
 * 実装する必要はない。
 */
function defaultExecFile(
  command: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      command,
      args,
      { encoding: 'utf8', timeout: options?.timeout ?? WEZTERM_EXEC_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

/** WezTerm が設定する `$TERM_PROGRAM` の値（darwin での strategy 順序ヒント、FR-03b）。 */
export const WEZTERM_TERM_PROGRAM = 'WezTerm'

/** {@link WeztermFocusStrategy} の依存差し替え（テスト用）。 */
export interface WeztermFocusStrategyOptions {
  /** `execFile` の差し替え。省略時は実 `command` を起動する既定実装。 */
  execFile?: ExecFileFn
  /**
   * `activate-pane` が exit 0 で終わった後、`<command> cli list --format json` で対象 pane id が
   * 実在するかを追加確認するかどうか（既定 `false`）。
   *
   * review-changes 修正: WSL interop 経由の `wezterm.exe cli` 呼び出しは、upstream の議論
   * （wezterm/wezterm discussions #6964）で類似操作がサイレント失敗する報告があり、exit 0 が実際の
   * pane 前面化を保証しない（`docs/releases/release-28-wezterm-focus/requirements.md` 未解決事項）。
   * `true` のとき、`activate-pane` 成功後に一覧を取得し対象 pane id が見つからなければ `ok` を返さず
   * `error` に丸める（`FocusService.focusWsl` の既存 Windows Terminal フォールバックへ進めるため）。
   * 一覧取得自体が失敗・不正な形式だった場合も「検証できない」とみなし同様に `error` を返す
   * （検証手段が信頼できないときは exit 0 を無条件の最終成功にしない設計）。
   *
   * この検証は「前面化が実際に効いたか」までは確認できず、対象 pane がまだ mux 上に存在するかの
   * 確認に留まる（upstream 挙動の完全な確証は実機検証でのみ得られる、requirements.md 未解決事項）。
   * darwin/ネイティブ Linux は直接実行でこの種のサイレント失敗の懸念が無いため既定 `false` のまま
   * にし、`cli.ts` の WSL 用インスタンス（`command: 'wezterm.exe'`）でのみ `true` を渡す。
   */
  verifyActivation?: boolean
}

/** {@link WeztermFocusStrategy.verifyPaneExists} が期待する `cli list --format json` の1要素分。 */
interface WeztermPaneListEntry {
  pane_id?: unknown
}

/**
 * `error` が「コマンドが見つからない」（`ENOENT`、PATH 上に `wezterm`/`wezterm.exe` が無い）ことを
 * 表すかを判定する。`execFile` が spawn 失敗時に reject する値は `NodeJS.ErrnoException` だが、
 * ここでは型に依存せず `code` プロパティの値だけを見る（テストのプレーンな `Error` にも対応するため）。
 *
 * @param error `execFile` が reject した値。
 * @returns `error.code === 'ENOENT'` なら true。
 */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * WezTerm 公式 CLI（`wezterm cli activate-pane`）でペイン単位フォーカスを行う strategy
 * （release-28-wezterm-focus FR-03b、`types.ts` の {@link Strategy} 実装）。
 *
 * `command` はコンストラクタ引数で受け取る。呼び出し側（`focus-service.ts`、FR-04）が
 * darwin/ネイティブ Linux では `'wezterm'`、WSL2 interop 経由では `'wezterm.exe'` を注入することで、
 * 同一の strategy 実装を両環境で使い回せるようにする。
 *
 * `target.weztermPane` は `focus-target.ts` の `sanitizeWeztermPane`（`/^\d+$/`）で既に検証済みだが、
 * ここでも `execFile`（非 shell）に pane id を引数配列の要素として渡すことで二段目の防御とする
 * （shell を経由しないため、たとえ検証をすり抜けた値が来てもシェルメタ文字が展開されることはない）。
 */
export class WeztermFocusStrategy implements Strategy {
  private readonly command: string
  private readonly execFile: ExecFileFn
  private readonly verifyActivation: boolean
  /**
   * 実行中の `focus()` 呼び出し（review-changes 修正: in-flight ガード）。`null` でなければ
   * 前回呼び出しが未完了であることを表し、新規の `execFile` は起動せずこの Promise を共有する。
   * `wezterm`/`wezterm.exe` がハングした場合に `f` キー連打で子プロセスが際限なく蓄積するのを防ぐ。
   */
  private inFlight: Promise<FocusResult> | null = null

  /**
   * @param command 実行する `wezterm` バイナリ名/パス（例 `'wezterm'` / `'wezterm.exe'`）。
   * @param options `execFile` の差し替え・{@link WeztermFocusStrategyOptions.verifyActivation}
   *   の指定（{@link WeztermFocusStrategyOptions}、省略可）。
   */
  constructor(command: string, options: WeztermFocusStrategyOptions = {}) {
    this.command = command
    this.execFile = options.execFile ?? defaultExecFile
    this.verifyActivation = options.verifyActivation ?? false
  }

  /**
   * darwin での strategy 並べ替えヒント: `term_program` が WezTerm のものと一致するか。
   *
   * @param target 検証済みフォーカス対象。
   * @returns 一致すれば true。
   */
  matchesHint(target: FocusTarget): boolean {
    return target.termProgram === WEZTERM_TERM_PROGRAM
  }

  /**
   * `target.weztermPane` が指すペインを前面化する。
   *
   * pane id が無ければ（`null`）`execFile` を呼ばずに `not_found` を返す。ある場合は
   * `<command> cli activate-pane --pane-id <weztermPane>` を pane id を引数配列の要素として渡して
   * 実行する（shell を経由しないため文字列インジェクションの経路が無い）。前回呼び出しが未完了
   * （{@link inFlight}）なら新規に `execFile` を起動せず、その結果を共有する（review-changes 修正:
   * in-flight ガード）。
   *
   * @param target 検証済みフォーカス対象（`weztermPane` を使う）。
   * @returns 例外なく終了（exit 0）し、かつ {@link verifyActivation} が無効/検証成功なら `ok`。
   *   `error.code === 'ENOENT'`（PATH 上に `command` が見つからない）なら `not_found`。それ以外の
   *   例外（タイムアウト含む、{@link WEZTERM_EXEC_TIMEOUT_MS}）や `verifyActivation` の検証失敗は
   *   `error` に丸める。
   */
  async focus(target: FocusTarget): Promise<FocusResult> {
    if (target.weztermPane === null) {
      return 'not_found'
    }
    if (this.inFlight !== null) {
      return this.inFlight
    }

    const paneId = target.weztermPane
    const run = this.runFocus(paneId).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  /** {@link focus} の実処理（in-flight ガードで包む対象、review-changes 修正）。 */
  private async runFocus(paneId: string): Promise<FocusResult> {
    try {
      await this.execFile(this.command, ['cli', 'activate-pane', '--pane-id', paneId], {
        timeout: WEZTERM_EXEC_TIMEOUT_MS,
      })
    } catch (error) {
      return isEnoent(error) ? 'not_found' : 'error'
    }

    if (!this.verifyActivation) {
      return 'ok'
    }
    return this.verifyPaneExists(paneId)
  }

  /**
   * `<command> cli list --format json` を実行し、`paneId` が結果に実在するかを確認する
   * （{@link WeztermFocusStrategyOptions.verifyActivation}、review-changes 修正）。
   *
   * 一覧取得自体の失敗・JSON 解析失敗・対象 pane 不在のいずれも「検証できない/失敗」とみなし
   * `error` を返す（検証手段が信頼できない場合に exit 0 を無条件の最終成功にしない設計）。
   *
   * @param paneId 直前に `activate-pane` を実行した pane id。
   * @returns 一覧中に `pane_id === paneId`（文字列比較）の要素が見つかれば `ok`、それ以外は `error`。
   */
  private async verifyPaneExists(paneId: string): Promise<FocusResult> {
    try {
      const { stdout } = await this.execFile(this.command, ['cli', 'list', '--format', 'json'], {
        timeout: WEZTERM_EXEC_TIMEOUT_MS,
      })
      const panes: unknown = JSON.parse(stdout)
      if (!Array.isArray(panes)) {
        return 'error'
      }
      const found = (panes as WeztermPaneListEntry[]).some(
        (pane) => pane !== null && typeof pane === 'object' && String(pane.pane_id) === paneId
      )
      return found ? 'ok' : 'error'
    } catch {
      return 'error'
    }
  }
}
