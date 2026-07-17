import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { PrStatusRepository } from '../db/repositories/pr-status-repository.js'
import type { ProjectRepository } from '../db/repositories/project-repository.js'
import type { InstanceRepository } from '../db/repositories/instance-repository.js'
import { type GhReviewDecision, mapPrToStatus } from '../domain/pr-status-mapper.js'
import { epochMsNow, type EpochMs } from '../domain/time.js'

/**
 * `gh` CLI 呼び出しに使う `execFile` の最小 signature（`tmux-strategy.ts`/`osascript.ts` と同じ
 * DI パターン。release-27 FR-01a）。
 *
 * `gh` の引数（`--repo`/`--head`/`--json` 等の値、特に branch 名や owner/repo 文字列）は配列要素
 * として渡す非 shell 実行のため、シェルメタ文字による注入を構造的に防ぐ（既存 `tmux-strategy.ts`
 * 等と同じ三段防御方針、requirements.md 非機能要件）。テストでは実 `gh` を起動しないモックに
 * 差し替える。第 3 引数 `options.signal` は任意（省略可）で、`stop()`/サイクル打ち切り時に
 * 進行中の子プロセスを中断するために使う（review-changes 修正: 無期限ハング防止）。
 */
export type ExecFileFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>

/**
 * `gh` 呼び出し 1 回あたりの既定タイムアウト（review-changes 修正: `gh auth status`/`gh pr list` に
 * タイムアウトが無く、認証プロンプトや GitHub 側の停止で hub 起動・ポーリングが無期限にハング
 * していた高 severity 所見への対応）。GitHub API 通信を伴うため、他モジュールの疎通確認用
 * timeout（`hub-endpoint-resolver.ts` 等の 2000ms）より長めの 15 秒にする。
 */
const GH_EXEC_TIMEOUT_MS = 15_000

/**
 * `node:child_process.execFile` の promisify 版（既定の {@link ExecFileFn} 実装）。
 *
 * 既定で `timeout: GH_EXEC_TIMEOUT_MS` を指定し、`gh` が応答しないケース（認証プロンプト待ち・
 * ネットワーク停止等）でも一定時間で必ず reject させる。`options.signal` が渡された場合は
 * 追加で `AbortSignal` も渡し、`stop()` からの明示的なキャンセルにも応じられるようにする
 * （`timeout`/`signal` は node:child_process.execFile で併用可能）。
 */
const defaultExecFile: ExecFileFn = (command, args, options) =>
  (
    promisify(nodeExecFile) as (
      file: string,
      fileArgs: string[],
      execOptions: { timeout: number; signal?: AbortSignal }
    ) => Promise<{ stdout: string; stderr: string }>
  )(command, args, { timeout: GH_EXEC_TIMEOUT_MS, signal: options?.signal })

/** GitHub リモートの `project_key`（`host/owner/repo`）が満たすべき host 接頭辞。 */
const GITHUB_HOST_PREFIX = 'github.com/'

/** ポーリング間隔の既定値（5分、requirements.md AC-5 の既定値と一致）。 */
export const DEFAULT_INTERVAL_MS = 5 * 60_000

/**
 * ログ出力前に C0/C1 制御文字（改行・ESC・BEL 含む）を除去する。
 *
 * `target.branch`/`owner`/`repo` や `gh` の例外メッセージは reporter 由来の値を経由しうる
 * （「認証済みだが信頼しない」既存の脅威モデル、S9/S12 と同種）。`sanitizeDisplayText`
 * （`src/cli/sanitize-display-text.ts`）は複数行表示を壊さないよう改行・タブを意図的に残すが、
 * ここは単一行のログ行そのものなので改行も含めて全除去し、偽装ログ行・端末エスケープ注入の
 * 双方を防ぐ（review-changes 修正）。
 *
 * @param value ログに埋め込む未検証の文字列。
 * @returns 制御文字を除去した文字列。
 */
function sanitizeForLog(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の除去が目的そのもの
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

/** `gh pr list --json reviewDecision` が空欄を返す場合があるため `''` も受理して `null` へ正規化する。 */
const ghReviewDecisionSchema = z
  .union([z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']), z.literal(''), z.null()])
  .transform((value): GhReviewDecision => (value === '' ? null : value))

/** `gh pr list --json number,state,reviewDecision,isDraft,url` の 1 要素分のスキーマ。 */
const ghPrListItemSchema = z.object({
  number: z.number().int(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  reviewDecision: ghReviewDecisionSchema,
  isDraft: z.boolean(),
  url: z.string(),
})

/** {@link ghPrListItemSchema} の検証済み形状。 */
type GhPrListItem = z.infer<typeof ghPrListItemSchema>

/** `gh pr list` の JSON 出力全体（配列）のスキーマ。 */
const ghPrListSchema = z.array(ghPrListItemSchema)

/**
 * `gh pr list --json ...` の stdout を検証・パースする。
 *
 * JSON として解釈できない、または期待するフィールド形状でない場合は例外を投げる
 * （呼び出し側 {@link GithubPrPoller.pollOnce} が branch 単位で catch し、他 branch へ波及させない）。
 *
 * @param stdout `gh pr list` の生 stdout。
 * @returns 検証済みの PR 一覧（0 件もあり得る）。
 * @throws {Error} JSON として解釈できない場合。
 * @throws {z.ZodError} 期待するフィールド形状に一致しない場合。
 */
function parseGhPrListOutput(stdout: string): GhPrListItem[] {
  const raw: unknown = JSON.parse(stdout)
  return ghPrListSchema.parse(raw)
}

/**
 * 同一 branch に複数 PR が存在する場合、OPEN の PR を優先し、その中で番号最大（＝最新）を採用する
 * （requirements.md 未解決事項の実装時決定: fork からの重複 PR 等）。
 *
 * `--state all` は MERGED 検出のために全 state を取得するが、番号だけで最新を選ぶと
 * 「OPEN #50 -> main」「CLOSED #51 -> develop」のように base 違いの重複 PR が存在する場合、
 * 番号の大きい CLOSED #51 が選ばれてしまい `state:'none'` に写像され、本来検出すべき OPEN PR が
 * PR_WAIT 判定から隠れてしまう（review 所見対応）。OPEN が 1 件以上あればその中の番号最大を、
 * OPEN が無い場合のみ全件（CLOSED/MERGED）の中の番号最大を採用する。
 *
 * @param items 対象 branch の PR 一覧。
 * @returns 採用する PR。`items` が空なら null（PR 自体が存在しない）。
 */
function pickLatestPr(items: GhPrListItem[]): GhPrListItem | null {
  if (items.length === 0) {
    return null
  }
  const openItems = items.filter((item) => item.state === 'OPEN')
  const candidates = openItems.length > 0 ? openItems : items
  return candidates.reduce((latest, item) => (item.number > latest.number ? item : latest))
}

/** 例外を人間可読な文字列へ変換する（`Error` でない値が投げられる場合にも対応）。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 1 ポーリングサイクルで処理する対象（`(project_id, branch)` の重複排除後の 1 件）。 */
interface PollTarget {
  projectId: string
  branch: string
  owner: string
  repo: string
}

/** {@link GithubPrPoller} の依存差し替え（テスト用）。 */
export interface GithubPrPollerOptions {
  /** `gh` 実行の差し替え。省略時は実 `gh` CLI を起動する既定実装。 */
  execFile?: ExecFileFn
  /** ポーリング間隔（ミリ秒）。省略時 {@link DEFAULT_INTERVAL_MS}（config `github_pr_poll.interval` の既定と一致）。 */
  intervalMs?: number
  /** ポーリングを有効にするか。`false` なら {@link GithubPrPoller.start} は完全 no-op（AC-5）。省略時 `true`。 */
  enabled?: boolean
  /** 権威時刻の供給関数（`checked_at` に使う）。省略時 {@link epochMsNow}。 */
  now?: () => EpochMs
  /** 警告・エラーログの出力先。省略時 `console.error`。 */
  logger?: (message: string) => void
  /** 定期実行タイマーの差し替え（テスト用）。省略時は実 `setInterval`。 */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  /** タイマー停止の差し替え（テスト用）。省略時は実 `clearInterval`。 */
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void
  /**
   * ポーリング対象を `owner/repo`（大文字小文字を区別）の allowlist に制限する
   * （review-changes 修正: reporter が任意の `remote_url`/branch を申告でき、hub 自身の `gh`
   * 認証情報でそれを問い合わせてしまう confused-deputy 所見への対応）。省略・空配列は「制限なし」
   * （既存の全対象ポーリング動作を維持、後方互換）。運用者が config.yml
   * `github_pr_poll.allowed_repos` で明示的に許可した repo だけに限定したい場合に指定する。
   *
   * 未設定のまま対象が複数 owner/org にまたがる場合、`start()` は confused-deputy リスクに
   * 気付けるよう起動時に 1 回警告を出す（{@link GithubPrPoller.warnIfAllowedReposUnrestricted}、
   * review 所見対応: 既定が「制限なし」であること自体は後方互換のため維持するが、無警告のまま
   * 気付かれずに運用され続けることを防ぐ）。
   */
  allowedRepos?: readonly string[]
}

/**
 * GitHub PR ポーラー（既知課題 U7 対応、release-27 FR-01a）。
 *
 * `InstanceRepository.listActive()` から GitHub リモートを持つ `(project_id, branch)` の
 * ユニーク組を洗い出し、`gh` CLI（`execFile` 非 shell）で各 branch の PR 情報を取得、
 * {@link mapPrToStatus}（FR-02）で写した結果を `PrStatusRepository.upsert()`（FR-03）へ
 * 永続化する。`MemoryWatchdog`/`PollingLoop` と同じ「DI 可能な timer + start()/stop()」構造を
 * 踏襲し、timer は `unref()` してプロセスの自然な終了を妨げない。
 */
export class GithubPrPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  /** `gh` 未導入・未認証と判定済みで、ポーリングを無効化したかどうか（AC-4: 警告は 1 回のみ）。 */
  private disabledDueToGh = false
  /**
   * 進行中サイクルの中断用 `AbortController`（review-changes 修正）。`pollOnce()` 実行中のみ
   * 非 null。`stop()` から abort し、`gh` の子プロセスを起動途中含めて打ち切る。同時に「実行中
   * サイクルがあるか」の判定（重複起動防止）にも使う。
   */
  private inFlightController: AbortController | null = null

  private readonly execFile: ExecFileFn
  private readonly intervalMs: number
  private readonly enabled: boolean
  private readonly now: () => EpochMs
  private readonly logger: (message: string) => void
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setInterval>
  private readonly clearIntervalFn: (timer: ReturnType<typeof setInterval>) => void
  /** {@link GithubPrPollerOptions.allowedRepos} の Set 化（`null` は制限なし）。 */
  private readonly allowedRepos: Set<string> | null

  /**
   * @param instances instance Repository（`listActive` で対象 branch を洗い出す）。
   * @param projects project Repository（`projectId` から `projectKey` を解決する）。
   * @param prStatus PR 状態 Repository（写像結果の upsert 先）。
   * @param options 依存の差し替え（省略可、テスト用）。
   */
  constructor(
    private readonly instances: InstanceRepository,
    private readonly projects: ProjectRepository,
    private readonly prStatus: PrStatusRepository,
    options: GithubPrPollerOptions = {}
  ) {
    this.execFile = options.execFile ?? defaultExecFile
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.enabled = options.enabled ?? true
    this.now = options.now ?? epochMsNow
    this.logger = options.logger ?? ((message: string) => console.error(message))
    this.setIntervalFn = options.setIntervalFn ?? setInterval
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval
    this.allowedRepos =
      options.allowedRepos && options.allowedRepos.length > 0 ? new Set(options.allowedRepos) : null
  }

  /**
   * ポーリングを開始する（AC-4/AC-5/AC-6）。
   *
   * `enabled: false`（config `github_pr_poll.enabled: false`）の場合は `gh` の可用性チェックすら
   * 行わず完全 no-op にする（AC-5）。既に稼働中、または過去に `gh` 未導入・未認証と判定済みの
   * 場合も何もしない（冪等・警告の重複防止）。`gh auth status` の成否で「導入済みかつ認証済みか」
   * を 1 回のコマンドで判定する（未導入なら `ENOENT` で reject、未認証なら非 0 終了で reject、
   * どちらも同じ「縮退」扱いになる、AC-4。この呼び出しは {@link defaultExecFile} の
   * `GH_EXEC_TIMEOUT_MS` で打ち切られるため無期限にハングしない、review-changes 修正）。
   *
   * 判定に成功したら timer を即座にスケジュールしてから（`isRunning()` が同期的に true になる）、
   * 初回ポーリングは `await` せずバックグラウンドで開始する。対象 branch 数分の `gh pr list` を
   * 逐次実行する初回サイクルの完了を待たずに `start()`（ひいては `serve()`）が戻ることで、
   * hub 起動が対象 branch 数や GitHub 側の遅延に比例して長時間ブロックされる事態を防ぐ
   * （review-changes 修正: hub 起動クリティカルパスからの分離）。timer は `unref()` し、
   * プロセスの終了を妨げない（AC-6）。
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      return
    }
    if (this.timer !== null || this.disabledDueToGh) {
      return
    }

    const ghAvailable = await this.isGhAvailable()
    if (!ghAvailable) {
      this.disabledDueToGh = true
      this.logger(
        'monomi: gh CLI が見つからないか未認証のため GitHub PR ポーリングを無効化しました' +
          '（`gh auth login` を実行し、PR 状態表示を有効にするには hub を再起動してください）'
      )
      return
    }

    this.warnIfAllowedReposUnrestricted()

    this.timer = this.setIntervalFn(() => {
      void this.pollOnce().catch((err) => this.logUnhandledPollError(err))
    }, this.intervalMs)
    this.timer.unref?.()
    void this.pollOnce().catch((err) => this.logUnhandledPollError(err))
  }

  /**
   * `pollOnce()` の fire-and-forget 呼び出し（`setInterval` コールバック・`start()` 直後の初回実行）
   * 用の最終防波堤（既知課題 B15）。
   *
   * `pollOnce()` 内の `collectTargets()` は個別 branch の try/catch の外側にあるため、DB が
   * シャットダウン中に閉じられる等で同期例外を投げると、この catch が無ければ未処理の Promise
   * rejection となり、Node.js のデフォルト挙動（unhandledRejection を uncaught exception 相当に
   * 扱う）により hub プロセス全体が終了しうる。ログのみ残し、次回 tick に委ねる（AC-3 と同じ
   * log-and-continue 方針）。
   */
  private logUnhandledPollError(err: unknown): void {
    this.logger(`monomi: GitHub PR ポーリングサイクルが失敗しました: ${errorMessage(err)}`)
  }

  /**
   * ポーリングを停止する（AC-6）。停止済みなら何もしない。
   *
   * timer 停止に加え、進行中サイクルがあれば {@link inFlightController} を abort し、
   * `gh` の子プロセスを起動途中のものも含めて打ち切る（review-changes 修正: `stop()` が進行中の
   * 子プロセスを中断しない所見への対応）。abort された呼び出しは `pollOnce()` 側の per-branch
   * try/catch でログされるのみで、DB クローズ等の後続処理をブロックしない。
   */
  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
    this.inFlightController?.abort()
  }

  /**
   * ポーリング中かどうか。
   *
   * @returns 稼働中（timer 稼働中）なら true。
   */
  isRunning(): boolean {
    return this.timer !== null
  }

  /**
   * 1 ポーリングサイクルを実行する（`start()` の内部 tick から呼ばれるほか、テストで直接呼ぶ）。
   *
   * 対象 `(project_id, branch)` を重複排除して洗い出し（AC-1）、各 branch を順に処理する。
   * 個別 branch の失敗は catch してログに残すのみで、他 branch の処理や本サイクル自体を止めない
   * （AC-3）。
   *
   * 前サイクルが完了していない間は即座に return し、`gh` 呼び出しを一切行わない
   * （review-changes 修正: `setInterval` は前回 tick の完了を待たないため、`gh` 呼び出しが
   * `intervalMs` を超えると複数サイクルが並行実行され、後発サイクルが upsert した新しい状態を
   * 先発サイクルの遅延応答が古い値で上書きしうる高 severity 所見への対応。直列化により
   * 「開始順ではなく完了順」による巻き戻りを構造的に防ぐ）。
   */
  async pollOnce(): Promise<void> {
    if (this.inFlightController !== null) {
      return
    }
    const controller = new AbortController()
    this.inFlightController = controller
    try {
      const targets = this.collectTargets()
      let failureCount = 0
      for (const target of targets.values()) {
        if (controller.signal.aborted) {
          break
        }
        try {
          await this.pollBranch(target, controller.signal)
        } catch (err) {
          failureCount += 1
          this.logger(
            `monomi: GitHub PR ポーリングに失敗しました（project=${target.projectId} branch=${sanitizeForLog(target.branch)} repo=${sanitizeForLog(target.owner)}/${sanitizeForLog(target.repo)}）: ${sanitizeForLog(errorMessage(err))}`
          )
          // 前回値を保持するため upsert を呼ばない（AC-3）。
        }
      }
      // 対象が 1 件以上あり、かつ「全件」失敗した場合のみ認証失効を疑い再確認する（review-changes
      // 修正: 起動時にしか gh 可用性を判定しない契約だと、稼働中のトークン失効・権限剥奪後も
      // stale な PR_WAIT が無期限に残り続けるという medium severity 所見への対応。個別 branch の
      // 孤立した障害（該当リポジトリ未検出等）まで無効化対象にしないよう「全件失敗」時のみ判定する）。
      if (
        targets.size > 0 &&
        failureCount === targets.size &&
        !controller.signal.aborted &&
        !this.disabledDueToGh
      ) {
        await this.checkRuntimeAuthRevocation()
      }
    } finally {
      this.inFlightController = null
    }
  }

  /**
   * `gh auth status` の成否で `gh` の可用性（導入済み・認証済み）を判定する。
   *
   * @returns 実行でき、かつ非 0 終了しなければ true。
   */
  private async isGhAvailable(): Promise<boolean> {
    try {
      await this.execFile('gh', ['auth', 'status'])
      return true
    } catch {
      return false
    }
  }

  /**
   * `allowedRepos`（`github_pr_poll.allowed_repos`）が未設定（＝制限なし）のまま、対象 branch が
   * 複数 owner/org にまたがっている場合に `start()` から 1 回だけ警告を出す
   * （review 所見対応: 既定が「制限なし」であること自体は既存要件どおり後方互換のため維持するが、
   * reporter が申告した任意の `owner/repo` を hub 自身の `gh` 認証情報で無条件に問い合わせてしまう
   * confused-deputy 構造に運用者が気付けるようにする）。
   *
   * 対象が単一 owner のみ（個人利用で自分のリポジトリしか無い等）の場合は偽陽性を避けるため警告
   * しない。他 owner の repo が紛れ込むリスクが実際に存在する構成（複数 owner/org が対象になって
   * いる）でのみ警告する。
   */
  private warnIfAllowedReposUnrestricted(): void {
    if (this.allowedRepos !== null) {
      return
    }
    const owners = new Set(Array.from(this.collectTargets().values()).map((target) => target.owner))
    if (owners.size <= 1) {
      return
    }
    this.logger(
      'monomi: GitHub PR ポーリング対象が複数の owner/org にまたがっていますが、' +
        'github_pr_poll.allowed_repos が未設定のためポーリング対象を制限していません。' +
        'reporter が申告した任意の owner/repo を hub 自身の gh 認証情報で問い合わせてしまう' +
        'おそれがあるため、config.yml の github_pr_poll.allowed_repos で対象 owner/repo を' +
        '明示的に許可することを推奨します。'
    )
  }

  /**
   * 稼働中に 1 サイクル分の対象が全件失敗した場合、`gh auth status` を再確認し、認証失効
   * （またはバイナリの消失）であれば起動時と同じ「無効化 + 1 回警告」へ倒す
   * （requirements.md AC-4 の運用時拡張。review-changes 修正）。
   *
   * 個別 branch のリポジトリ未検出・レート制限等、`gh` 自体は健全な一時的障害と区別するため、
   * `pollOnce()` 側で「全件失敗」を確認した後にのみ呼ばれる。
   */
  private async checkRuntimeAuthRevocation(): Promise<void> {
    const stillAvailable = await this.isGhAvailable()
    if (stillAvailable) {
      return
    }
    this.disabledDueToGh = true
    this.stop()
    this.logger(
      'monomi: GitHub 認証が失効したため GitHub PR ポーリングを無効化しました' +
        '（`gh auth login` を実行し、PR 状態表示を再開するには hub を再起動してください）'
    )
  }

  /**
   * `instances.listActive()` から GitHub リモートを持つ `(project_id, branch)` のユニーク組を
   * 洗い出す（AC-1）。
   *
   * 対象化の条件: `instance.branch !== null` かつ、所属 project の `projectKey.kind ===
   * 'GIT_REMOTE'` かつ `projectKey.value` が `github.com/` から始まること（GitHub 以外のホスト
   * はスコープ外）。`projectKey.value` は正規化済み `host/owner/repo` 形式（
   * `ProjectKeyNormalizer` 出力）なので、`/` 分割の 2 番目が owner、3 番目以降を join したものが
   * repo になる。{@link allowedRepos} が設定されている場合はさらに `owner/repo` がその allowlist
   * に含まれるものだけへ絞り込む（review-changes 修正: confused-deputy 対応。reporter が申告した
   * project_key を無条件に信頼して hub 自身の `gh` 認証情報で問い合わせることを防ぐ）。
   *
   * @returns `(project_id, branch)` をキーにした重複排除済みの {@link PollTarget} 集合。
   */
  private collectTargets(): Map<string, PollTarget> {
    const targets = new Map<string, PollTarget>()
    for (const instance of this.instances.listActive()) {
      if (instance.branch === null) {
        continue
      }
      const project = this.projects.findById(instance.projectId)
      if (project === null) {
        continue
      }
      if (project.projectKey.kind !== 'GIT_REMOTE') {
        continue
      }
      if (!project.projectKey.value.startsWith(GITHUB_HOST_PREFIX)) {
        continue
      }

      const parts = project.projectKey.value.split('/')
      const owner = parts[1]
      const repo = parts.slice(2).join('/')
      if (!owner || !repo) {
        continue
      }
      if (this.allowedRepos !== null && !this.allowedRepos.has(`${owner}/${repo}`)) {
        continue
      }

      const key = JSON.stringify([instance.projectId, instance.branch])
      if (!targets.has(key)) {
        targets.set(key, { projectId: instance.projectId, branch: instance.branch, owner, repo })
      }
    }
    return targets
  }

  /**
   * 1 branch 分の PR 情報を取得し {@link PrStatusRepository} へ upsert する。
   *
   * `--state all` で open/closed/merged いずれも取得し（FR-02 のマッピングが CLOSED/MERGED も
   * 扱うため）、複数件あれば {@link pickLatestPr} で番号最大を採用する。PR が 1 件も無ければ
   * `mapPrToStatus(null)`（`state: 'none'`）を upsert し、以前 `PR_WAIT` だった instance を
   * 解除する（AC-2）。
   *
   * @param target 対象 `(project_id, branch)` と owner/repo。
   * @param signal `stop()`/サイクル打ち切り時に `gh` 子プロセスを中断するための `AbortSignal`。
   * @throws `execFile` の失敗、または stdout が期待形状でない場合（呼び出し側 {@link pollOnce} が catch する）。
   */
  private async pollBranch(target: PollTarget, signal: AbortSignal): Promise<void> {
    const { stdout } = await this.execFile(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        `${target.owner}/${target.repo}`,
        '--head',
        target.branch,
        '--state',
        'all',
        '--json',
        'number,state,reviewDecision,isDraft,url',
      ],
      { signal }
    )

    const items = parseGhPrListOutput(stdout)
    const latest = pickLatestPr(items)
    const mapped = mapPrToStatus(
      latest === null
        ? null
        : { state: latest.state, reviewDecision: latest.reviewDecision, isDraft: latest.isDraft }
    )

    this.prStatus.upsert({
      projectId: target.projectId,
      branch: target.branch,
      prNumber: latest?.number ?? null,
      state: mapped.state,
      isDraft: mapped.isDraft,
      url: latest?.url ?? null,
      checkedAt: this.now(),
    })
  }
}
