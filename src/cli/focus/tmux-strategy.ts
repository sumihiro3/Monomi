import { execFile as nodeExecFile } from 'node:child_process'
import type { FocusTarget, TmuxStrategy, TmuxSwitchOutcome } from './types.js'

/**
 * tmux 越しのフォーカス切替に使う `execFile` の最小 signature（release-23-terminal-focus FR-04c）。
 *
 * `hub-autostart.ts` の `SpawnFn` 注入パターンを踏襲する。実行はすべて `execFile`（非 shell）で
 * 行い、コマンド文字列の shell 解釈を経由させない（三段防御のうち execFile 非 shell 部分）。
 * テストでは実 `tmux` を起動しないモックに差し替える。
 */
export type ExecFileFn = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>

/**
 * `node:child_process.execFile` を Promise 化した既定実装。
 *
 * `util.promisify` ではなく明示的な `Promise` ラップにしているのは、`execFile` のコールバック
 * オーバーロード解決に依存せず戻り値の型（`{ stdout: string; stderr: string }`）を固定するため。
 */
function defaultExecFile(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** `tmux list-clients -F` の出力 1 行分（{@link parseTmuxClients} の解析結果）。 */
export interface TmuxClientInfo {
  /** クライアントの外側 TTY（例 `/dev/ttys005`）。 */
  tty: string
  /** `client_activity`（tmux が返す unix epoch 秒）。複数クライアントの代表選定に使う。 */
  activity: number
}

/** `tmux list-clients -F` へ渡すフォーマット文字列（tty と activity をタブ区切りで得る）。 */
const LIST_CLIENTS_FORMAT = '#{client_tty}\t#{client_activity}'

/**
 * `tmux list-clients -F '#{client_tty}\t#{client_activity}'` の stdout を解析する（純粋関数）。
 *
 * 空行は無視する。行末の `\r`（CRLF 環境向け）のみ除去し、内部のタブ区切りはそのまま尊重する
 * （行全体を trim すると、例えば tty フィールドが空の行 `"\t1000"` の意味のある先頭タブまで
 * 失われるため）。`activity` が数値化できない行は 0 として扱う（tmux が想定外フォーマットを
 * 返した場合の安全側フォールバックで、例外にはしない）。tty が空の行は破棄する。
 *
 * @param stdout `list-clients` の生 stdout。
 * @returns 解析できたクライアント一覧（0 件もあり得る）。
 */
export function parseTmuxClients(stdout: string): TmuxClientInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => {
      const [tty = '', activityRaw] = line.split('\t')
      const activity = Number.parseInt(activityRaw ?? '', 10)
      return { tty, activity: Number.isNaN(activity) ? 0 : activity }
    })
    .filter((client) => client.tty.length > 0)
}

/**
 * `client_activity` が最大のクライアントを選ぶ（複数クライアント時の代表決定、AC-5）。
 * 同値の場合は `list-clients` の出力順で先に現れたものを採用する（安定的な決定性のため）。
 *
 * @param clients 1 件以上のクライアント一覧（呼び出し側で 0 件チェック済みであること）。
 */
function pickMostActiveClient(clients: TmuxClientInfo[]): TmuxClientInfo {
  return clients.reduce((best, current) => (current.activity > best.activity ? current : best))
}

/** {@link TmuxFocusStrategy} の依存差し替え（テスト用）。 */
export interface TmuxFocusStrategyOptions {
  /** `execFile` の差し替え。省略時は実 `tmux` を起動する既定実装。 */
  execFile?: ExecFileFn
}

/**
 * tmux 経由でセッション実行中ターミナルへフォーカスする strategy（release-23-terminal-focus
 * FR-04c、`types.ts` の {@link TmuxStrategy} 実装）。
 *
 * フックから見える TTY は tmux ペインの pts であり外側ターミナル（Terminal.app/Ghostty/Windows
 * Terminal）の TTY ではないため、本 strategy は「ペインへ切り替えて、切替対象になった外側
 * クライアントの TTY を返す」役割に徹する。`focus-service.ts`（FR-04d）はこの TTY を使って
 * darwin/WSL 側の strategy へフォーカス処理を引き継ぐ。
 *
 * 入力の `tmuxPane`/`tmuxSocket` は `focus-target.ts`（FR-04a）が既に厳格検証済みの値である
 * ことを前提とし、本 strategy では再検証しない。
 */
export class TmuxFocusStrategy implements TmuxStrategy {
  private readonly execFile: ExecFileFn

  /** @param options `execFile` の差し替え（{@link TmuxFocusStrategyOptions}、省略可）。 */
  constructor(options: TmuxFocusStrategyOptions = {}) {
    this.execFile = options.execFile ?? defaultExecFile
  }

  /**
   * tmux ペインへ切り替えてクライアント TTY を解決する（AC-5）。
   *
   * 1. `tmux -S <socket> list-clients -F '<format>'` でアタッチ中クライアントを列挙する。
   *    `tmuxPane`/`tmuxSocket` が検証不合格（`null`）で本 strategy に渡ってきた場合や、
   *    `execFile` が失敗した場合（サーバー未起動・ソケット不在など）は `tmux_detached` として
   *    扱う（安全側: どちらも「今すぐ切り替えられる attach 済みクライアントが無い」という
   *    ユーザー向けの結論は同じになるため）。
   * 2. stdout が 0 件なら `tmux_detached`。
   * 3. 複数件なら `client_activity` 最大のクライアントを採用する（AC-5）。
   * 4. `switch-client -c <client-tty> -t <pane>` → `select-window -t <pane>` →
   *    `select-pane -t <pane>` の順で実行する。tmux はペイン ID から所属ウィンドウ/セッションを
   *    解決できるため、ウィンドウ番号やセッション名を別途問い合わせる必要はない。
   * 5. 成功したら解決済みクライアント TTY を返す。切替コマンドのいずれかが失敗したら `error`。
   *
   * @param target 検証済みフォーカス対象（`tmuxPane`/`tmuxSocket` を使う）。
   * @returns 切替結果（{@link TmuxSwitchOutcome}）。
   */
  async switchClient(target: FocusTarget): Promise<TmuxSwitchOutcome> {
    const { tmuxPane, tmuxSocket } = target
    if (tmuxPane === null || tmuxSocket === null) {
      return { result: 'tmux_detached' }
    }

    let stdout: string
    try {
      const listed = await this.execFile('tmux', [
        '-S',
        tmuxSocket,
        'list-clients',
        '-F',
        LIST_CLIENTS_FORMAT,
      ])
      stdout = listed.stdout
    } catch {
      // サーバー未起動・ソケット不在などは「detach 中」として扱う（安全側）。
      return { result: 'tmux_detached' }
    }

    const clients = parseTmuxClients(stdout)
    if (clients.length === 0) {
      return { result: 'tmux_detached' }
    }

    const chosen = pickMostActiveClient(clients)

    try {
      await this.execFile('tmux', [
        '-S',
        tmuxSocket,
        'switch-client',
        '-c',
        chosen.tty,
        '-t',
        tmuxPane,
      ])
      await this.execFile('tmux', ['-S', tmuxSocket, 'select-window', '-t', tmuxPane])
      await this.execFile('tmux', ['-S', tmuxSocket, 'select-pane', '-t', tmuxPane])
    } catch {
      return { result: 'error' }
    }

    return { result: 'ok', tty: chosen.tty }
  }
}
