import fs from 'node:fs'
import { ensureMonomiHome, type MonomiPaths } from '../config/paths.js'

/**
 * `MemoryWatchdog` のサンプリング既定間隔（ミリ秒, release-20-dashboard-heap-guard FR-01 AC-2）。
 *
 * 60秒ごとに `process.memoryUsage()` と `stdout.writableLength` を記録する。長時間稼働（実運用で
 * 1週間程度、FR-01 AC-7）でもログ量が肥大化しすぎない粒度として選定した初期値。
 */
export const DEFAULT_SAMPLE_INTERVAL_MS = 60_000

/**
 * stdout バックプレッシャー判定の既定閾値（バイト, FR-02 AC-1）。
 *
 * `stdout.writableLength`（カーネルへ渡せず Node 側バッファに滞留しているバイト数）がこの値以上の
 * とき「バックプレッシャー中」とみなす。64KiB は初期値であり、実運用ログでの調整対象（未解決事項）。
 */
export const DEFAULT_BACKPRESSURE_THRESHOLD_BYTES = 64 * 1024

/**
 * バックプレッシャー閾値超過が何回連続したら WARN 相当行を出すか（既定値, FR-01 AC-3）。
 *
 * 1回の瞬間的な超過（ターミナルの一時的な描画遅延など）で誤検知しないよう、連続超過を要求する。
 */
export const DEFAULT_BACKPRESSURE_WARN_CONSECUTIVE_COUNT = 3

/**
 * `cli.log` ローテーションの既定サイズ閾値（バイト, release-21-known-issues-cleanup FR-01 AC-1）。
 *
 * `paths.cliLogFile` のサイズがこの値以上になったら、追記前に `paths.cliLogOldFile` へリネーム退避
 * してから新規 `cli.log` への追記を再開する（known-issues S10）。10MB は初期値であり、長時間稼働
 * （FR-01 AC-7）でもディスクを圧迫しすぎず、直近ログを追える粒度として選定した。
 */
export const DEFAULT_LOG_ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024

/**
 * {@link isStdoutBackpressured} が読む最小 signature（`process.stdout` 互換）。
 *
 * テストでは実ストリームを使わず `{ writableLength }` だけを持つオブジェクトに差し替える。
 */
export interface WritableLengthSource {
  /** Node 側バッファに滞留中のバイト数（`net.Socket`/`tty.WriteStream` 共通のプロパティ）。 */
  writableLength: number
}

/**
 * stdout が現在バックプレッシャー状態かどうかを判定する純粋関数（FR-02 AC-1）。
 *
 * I/O を一切行わない同期関数。`app-view.tsx`（再描画間引き）・`watching-indicator.tsx`（点滅間引き）・
 * {@link MemoryWatchdog}（WARN 判定）の全箇所がこの1関数を共有し、判定基準を1箇所に集約する。
 *
 * @param stdout `writableLength` を持つ書き込みストリーム（通常 `process.stdout`）。
 * @param thresholdBytes 閾値（省略時 {@link DEFAULT_BACKPRESSURE_THRESHOLD_BYTES}）。
 * @returns `writableLength >= thresholdBytes` なら true。
 */
export function isStdoutBackpressured(
  stdout: WritableLengthSource,
  thresholdBytes: number = DEFAULT_BACKPRESSURE_THRESHOLD_BYTES
): boolean {
  return stdout.writableLength >= thresholdBytes
}

/** {@link MemoryWatchdog} の依存差し替え（テスト用）。 */
export interface MemoryWatchdogOptions {
  /** サンプリング間隔（ミリ秒）。省略時 {@link DEFAULT_SAMPLE_INTERVAL_MS}。 */
  intervalMs?: number
  /** バックプレッシャー判定の閾値（バイト）。省略時 {@link DEFAULT_BACKPRESSURE_THRESHOLD_BYTES}。 */
  thresholdBytes?: number
  /** WARN 行を出すまでの連続超過回数。省略時 {@link DEFAULT_BACKPRESSURE_WARN_CONSECUTIVE_COUNT}。 */
  warnConsecutiveCount?: number
  /** メモリ使用量の取得実装。省略時は実 `process.memoryUsage`。 */
  memoryUsage?: () => NodeJS.MemoryUsage
  /** `writableLength` の取得元。省略時は実 `process.stdout`。 */
  stdout?: WritableLengthSource
  /** ログ追記の実装。省略時は実 `fs.appendFileSync`。 */
  appendFile?: (filePath: string, line: string) => void
  /** タイムスタンプ取得の差し替え（テスト用）。省略時は実 `Date`。 */
  now?: () => Date
  /** 定期実行タイマーの差し替え（テスト用）。省略時は実 `setInterval`。 */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  /** タイマー停止の差し替え（テスト用）。省略時は実 `clearInterval`。 */
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void
}

/**
 * 1件のサンプル行を組み立てる（FR-01 AC-2/AC-6）。
 *
 * 常に1行1サンプル（改行区切り）。`level` は通常は `INFO`、連続超過検出時のみ呼び出し側が
 * `WARN` を渡し、`thresholdBytes`/`consecutiveOverThreshold` を追記する（{@link formatSampleLine}
 * 自体はどちらの形式も返せる共通実装。通常行との書式差分を最小にし、grep で両方拾えるようにする）。
 */
function formatSampleLine(
  level: 'INFO' | 'WARN',
  timestamp: string,
  usage: NodeJS.MemoryUsage,
  writableLength: number,
  warnDetail?: { thresholdBytes: number; consecutiveOverThreshold: number }
): string {
  const fields = [
    `rss=${usage.rss}`,
    `heapTotal=${usage.heapTotal}`,
    `heapUsed=${usage.heapUsed}`,
    `external=${usage.external}`,
    `arrayBuffers=${usage.arrayBuffers}`,
    `writableLength=${writableLength}`,
  ]
  if (warnDetail !== undefined) {
    fields.push(
      `thresholdBytes=${warnDetail.thresholdBytes}`,
      `consecutiveOverThreshold=${warnDetail.consecutiveOverThreshold}`
    )
  }
  return `${timestamp} ${level} ${fields.join(' ')}\n`
}

/**
 * 稼働監視ログ（メモリ・stdoutバックプレッシャー計測）を記録するウォッチドッグ（FR-01）。
 *
 * ダッシュボード起動経路（引数なし、`cli.ts`）から起動される（AC-5、配線は別ファイル）。既定
 * {@link DEFAULT_SAMPLE_INTERVAL_MS} 間隔で `process.memoryUsage()` と `stdout.writableLength` を
 * 1行1サンプルで `paths.cliLogFile` へ `fs.appendFileSync` 追記する。`writableLength` が
 * {@link DEFAULT_BACKPRESSURE_THRESHOLD_BYTES} 超過を {@link DEFAULT_BACKPRESSURE_WARN_CONSECUTIVE_COUNT}
 * 回連続で検出したら、その回のサンプル行を通常行と区別可能な `WARN` 行として出力する（AC-3。
 * 追加の行を差し込むのではなく、その tick 1行を WARN 形式に置き換える — 「1行1サンプル」を保つ）。
 *
 * `process.exit` は一切呼ばない（ログ記録専用、AC-4。ハードクラッシュ回避はスコープ外）。
 *
 * `hub-autostart.ts`/`polling-loop.ts` の規約を踏襲し、timer/writer/clock を DI 可能にして実タイマー
 * 非依存でテストできる `start()`/`stop()` 構造にする。timer は `unref()` し、プロセスの自然な終了を
 * 妨げない。
 */
export class MemoryWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 直近から現在までの「閾値超過」連続回数。超過が途切れたら 0 へリセットする。 */
  private consecutiveOverThreshold = 0

  private readonly intervalMs: number
  private readonly thresholdBytes: number
  private readonly warnConsecutiveCount: number
  private readonly memoryUsage: () => NodeJS.MemoryUsage
  private readonly stdoutSource: WritableLengthSource
  private readonly appendFile: (filePath: string, line: string) => void
  private readonly now: () => Date
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setInterval>
  private readonly clearIntervalFn: (timer: ReturnType<typeof setInterval>) => void

  /**
   * @param paths `~/.monomi` パス集合（`cliLogFile` を書き込み先として使う）。
   * @param options 依存の差し替え（省略可、テスト用）。
   */
  constructor(
    private readonly paths: MonomiPaths,
    options: MemoryWatchdogOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
    this.thresholdBytes = options.thresholdBytes ?? DEFAULT_BACKPRESSURE_THRESHOLD_BYTES
    this.warnConsecutiveCount =
      options.warnConsecutiveCount ?? DEFAULT_BACKPRESSURE_WARN_CONSECUTIVE_COUNT
    this.memoryUsage = options.memoryUsage ?? process.memoryUsage
    this.stdoutSource = options.stdout ?? process.stdout
    this.appendFile = options.appendFile ?? ((filePath, line) => fs.appendFileSync(filePath, line))
    this.now = options.now ?? (() => new Date())
    this.setIntervalFn = options.setIntervalFn ?? setInterval
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval
  }

  /**
   * 1回サンプリングしてログへ1行追記する（`start()` の内部 tick から呼ばれるほか、テストで直接
   * 呼び出す）。
   *
   * 書き込み前に {@link ensureMonomiHome} を呼ぶ（`hub-autostart.ts` の `spawnHub` と同じ規約。
   * 稼働中に `~/.monomi` が消えても次回サンプルで自己修復する）。
   *
   * 本体は try/catch で囲む（AC-4）。`ensureMonomiHome`/`appendFileSync` はディスクフル
   * （ENOSPC）・権限エラー（EACCES）等で例外を投げうるが、ここは診断ログの記録専用であり、
   * ログ書き込みの失敗でダッシュボード本体（初回 `start()` 呼び出し・以後の `setInterval` tick の
   * どちらも）をクラッシュ／起動失敗させてはならない。失敗は静かに無視する。
   *
   * 追記の直前に `cli.log` のサイズを確認し、{@link DEFAULT_LOG_ROTATION_THRESHOLD_BYTES} 以上なら
   * `cli.log.old` へリネーム退避してから新規 `cli.log` へ追記する（release-21-known-issues-cleanup
   * FR-01、known-issues S10）。`cli.log` が未存在（初回 tick）の場合は `existsSync` で先にガードし、
   * `statSync` の ENOENT 例外で追記そのものがスキップされないようにする。ローテーション
   * （`renameSync`）が失敗した場合もこの外側の try/catch がその tick の追記ごと吸収するが、次 tick
   * で改めてローテーションを試みるため自己修復する（AC-4 の趣旨に沿い、専用の内側 try/catch は
   * 設けない）。
   */
  sample(): void {
    try {
      ensureMonomiHome(this.paths)

      const usage = this.memoryUsage()
      const writableLength = this.stdoutSource.writableLength
      const backpressured = isStdoutBackpressured(this.stdoutSource, this.thresholdBytes)
      this.consecutiveOverThreshold = backpressured ? this.consecutiveOverThreshold + 1 : 0

      const timestamp = this.now().toISOString()
      const isWarn = this.consecutiveOverThreshold >= this.warnConsecutiveCount
      const line = isWarn
        ? formatSampleLine('WARN', timestamp, usage, writableLength, {
            thresholdBytes: this.thresholdBytes,
            consecutiveOverThreshold: this.consecutiveOverThreshold,
          })
        : formatSampleLine('INFO', timestamp, usage, writableLength)

      if (fs.existsSync(this.paths.cliLogFile)) {
        const { size } = fs.statSync(this.paths.cliLogFile)
        if (size >= DEFAULT_LOG_ROTATION_THRESHOLD_BYTES) {
          fs.renameSync(this.paths.cliLogFile, this.paths.cliLogOldFile)
        }
      }

      this.appendFile(this.paths.cliLogFile, line)
    } catch {
      // 診断ログの欠落は許容する（AC-4: いかなる条件でもプロセスを終了させない）。
    }
  }

  /**
   * サンプリングを開始する。開始時に即1回サンプリングし、以後 `intervalMs` ごとに繰り返す
   * （`PollingLoop.start()` と同じ規約）。既に稼働中なら何もしない（冪等）。
   *
   * timer は `unref()` する（プロセスの終了を妨げない、AC-4 の趣旨）。
   */
  start(): void {
    if (this.timer !== null) {
      return
    }
    this.sample()
    this.timer = this.setIntervalFn(() => this.sample(), this.intervalMs)
    this.timer.unref?.()
  }

  /**
   * サンプリングを停止する。停止済みなら何もしない。
   */
  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
  }

  /**
   * サンプリング中かどうか。
   *
   * @returns 稼働中なら true。
   */
  isRunning(): boolean {
    return this.timer !== null
  }
}
