import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config/config.js'
import { ensureMonomiHome, type MonomiPaths, resolvePaths } from '../config/paths.js'
import { type Database, openDatabase } from '../db/database.js'
import { InstanceRepository } from '../db/repositories/instance-repository.js'
import { PrStatusRepository } from '../db/repositories/pr-status-repository.js'
import { ProjectRepository } from '../db/repositories/project-repository.js'
import type { EpochMs } from '../domain/time.js'
import { EscalationThresholds } from '../status/escalation.js'
import { MONOMI_VERSION } from '../version.js'
import { bootstrap } from './bootstrap.js'
import { GithubPrPoller, type ExecFileFn } from './github-pr-poller.js'
import { removeHubPidFile, writeHubPidFile } from './hub-lifecycle.js'
import { createHubServer, type HttpServer } from './http-server.js'

/**
 * 既定の待受バインドアドレス（FR-06 AC-1）。`options.host` > config `bind:` > 本既定の順で解決する。
 */
const DEFAULT_HOST = '0.0.0.0'

/** {@link serve} の任意依存（テストや複数構成の切り替え用）。 */
export interface ServeOptions {
  /** `~/.monomi` パス集合の上書き（省略時は {@link resolvePaths}）。 */
  paths?: MonomiPaths
  /** 待受ポートの上書き（省略時は config.port。テストは `0` でエフェメラル）。 */
  port?: number
  /** バインド先ホストの上書き（省略時は config `bind:`、それも無ければ `0.0.0.0`、FR-06 AC-1）。 */
  host?: string
  /** bootstrap の device 生成に使う hostname（省略時は `os.hostname()`）。 */
  hostname?: string
  /** 権威時刻の供給関数（省略時は実クロック）。 */
  now?: () => EpochMs
  /** 起動ログの出力先（省略時は `console.log`）。テストで抑止できる。 */
  logger?: (message: string) => void
  /**
   * GitHub PR ポーラー（{@link GithubPrPoller}）の `gh` 実行差し替え（テスト用 / release-27 FR-01b）。
   * 省略時は実 `gh` CLI を `execFile`（非 shell）で起動する既定実装。
   */
  githubPrPollExecFile?: ExecFileFn
}

/** 起動済み hub の操作ハンドル（テスト・グレースフルシャットダウン用）。 */
export interface HubHandle {
  /** 待受中の HTTP サーバ。 */
  server: HttpServer
  /** hub の DB ハンドル（同一プロセス内での検証・停止に使う）。 */
  db: Database
  /** 実際に待ち受けているポート番号。 */
  port: number
  /** 確定した device_id（bootstrap 由来）。 */
  deviceId: string
  /** ローカル用の生トークン（reporter/CLI へ渡す値。§0.3/§9）。 */
  rawToken: string
  /**
   * GitHub PR ポーラー（release-27 FR-01b）。`close()` が確実に `stop()` するので通常は直接操作
   * 不要だが、テスト・診断用に稼働状態（{@link GithubPrPoller.isRunning}）を確認できるよう公開する。
   */
  githubPrPoller: GithubPrPoller
  /** サーバ停止 + DB クローズ + `~/.monomi/hub.pid` 削除（FR-02。SIGINT/SIGTERM 経路で呼ばれる正常終了）。 */
  close(): Promise<void>
}

/**
 * config の放置昇格閾値から status-engine の {@link EscalationThresholds} を組み立てる。
 *
 * config レイヤーは status-engine の下流なので、既定の実体は status-engine に置き、config は
 * その上書き値を運ぶだけにする（class-diagram 未解決点の確定: 閾値の DI は HttpServer 起動時）。
 *
 * @param paths config を読む `~/.monomi` パス集合。
 * @returns config を反映した閾値。
 */
function thresholdsFromConfig(paths: MonomiPaths): EscalationThresholds {
  const config = loadConfig(paths)
  return new EscalationThresholds({
    active: config.escalationThresholds.active,
    approvalWait: config.escalationThresholds.approvalWait,
    nextWait: config.escalationThresholds.nextWait,
    prWait: config.escalationThresholds.prWait,
  })
}

/**
 * config の `github_pr_poll` 設定から {@link GithubPrPoller} を組み立てる（release-27 FR-01b）。
 *
 * {@link thresholdsFromConfig} と同型（config レイヤーは下流の一機構という位置づけを保つため、
 * ここでも独立して `loadConfig(paths)` を読む）。`HttpServer`/`createHubServer` は
 * {@link PrStatusRepository} を外部公開していないため、serve 側で同一 `db` から
 * `InstanceRepository`/`ProjectRepository`/`PrStatusRepository` を別途 `new` して poller と共有する
 * （補足の設計判断: repository のインスタンスは HttpServer 側と poller 側で別々に持つが、いずれも
 * 同じ `db` ハンドルを介するため整合する）。
 *
 * @param db 初期化済みの hub データベース（`createHubServer` に渡したものと同一インスタンス）。
 * @param paths config を読む `~/.monomi` パス集合。
 * @param options `now`/`githubPrPollExecFile` を poller へ伝播するための serve 依存。
 * @returns 未 `start()` の {@link GithubPrPoller}。
 */
function githubPrPollerFromConfig(
  db: Database,
  paths: MonomiPaths,
  options: ServeOptions
): GithubPrPoller {
  const config = loadConfig(paths)
  return new GithubPrPoller(
    new InstanceRepository(db),
    new ProjectRepository(db),
    new PrStatusRepository(db),
    {
      enabled: config.githubPrPoll.enabled,
      intervalMs: config.githubPrPoll.intervalMs,
      allowedRepos: config.githubPrPoll.allowedRepos,
      now: options.now,
      execFile: options.githubPrPollExecFile,
    }
  )
}

/**
 * hub をブートストラップして API サーバを起動する（`monomi hub` の実体 / FR-03）。
 *
 * 手順:
 * 1. `~/.monomi` を用意し config を読み込む。
 * 2. DB を開き（WAL/NORMAL、DDL 冪等適用）、{@link bootstrap} で device_id 自動生成・
 *    ローカルトークン発行（FR-03 AC-3/AC-4）を冪等に済ませる。
 * 3. config 由来の閾値で DI 配線した {@link HttpServer} を待ち受ける。バインド先は
 *    `options.host` > config `bind:` > 既定 `0.0.0.0` の優先順で解決する（FR-06 AC-1）。
 * 4. 待受成功後、自 pid を `~/.monomi/hub.pid` へ書き込む（FR-02。`monomi hub status`/`stop` の
 *    管理対象になる。既存ファイルがあっても無条件に上書きし stale pid を自己回復する）。
 * 5. config の `github_pr_poll` 設定から {@link GithubPrPoller} を組み立てて起動する（release-27
 *    FR-01b）。`enabled: false`、または `gh` CLI 未導入・未認証のときはポーラー内部で無効化される
 *    だけで、いずれの場合も hub 本体の起動は成功させる（既存ダッシュボード動作に影響しない）。
 *
 * @param options 依存の上書き（省略可）。
 * @returns 起動済み hub の {@link HubHandle}。
 */
export async function serve(options: ServeOptions = {}): Promise<HubHandle> {
  const paths = options.paths ?? resolvePaths()
  const log = options.logger ?? ((message: string) => console.log(message))

  ensureMonomiHome(paths)
  const config = loadConfig(paths)
  const host = options.host ?? config.bind ?? DEFAULT_HOST

  const db = openDatabase(paths.dbFile)
  const boot = bootstrap(db, paths, { hostname: options.hostname, now: options.now })

  const server = createHubServer(db, {
    now: options.now,
    thresholds: thresholdsFromConfig(paths),
  })
  const port = await server.listen(options.port ?? config.port, host)
  writeHubPidFile(paths, process.pid)

  log(
    `Monomi hub listening on http://${host}:${port} (device: ${boot.deviceId}, version: ${MONOMI_VERSION})`
  )

  // release-27 FR-01b: config の github_pr_poll に従い GitHub PR ポーラーを起動する。
  // enabled:false・gh 未導入/未認証はいずれも GithubPrPoller.start() 内部で縮退し、例外を投げない
  // ため、ここを待ち受けても hub 起動そのものを失敗させない。
  const githubPrPoller = githubPrPollerFromConfig(db, paths, options)
  await githubPrPoller.start()

  return {
    server,
    db,
    port,
    deviceId: boot.deviceId,
    rawToken: boot.rawToken,
    githubPrPoller,
    close: async () => {
      // AC-6: server.close()/db.close() より先にタイマーを止め、プロセス終了をブロックしない。
      githubPrPoller.stop()
      await server.close()
      db.close()
      removeHubPidFile(paths)
    },
  }
}

/**
 * `monomi hub`（serve）コマンドのエントリ。SIGINT/SIGTERM でグレースフルに停止する。
 *
 * bin の argv 配線（`monomi <subcommand>` の解決）は別項目の責務なので、ここでは hub の
 * 起動と終了処理だけを担う薄いラッパーにとどめる。
 *
 * @param options serve への依存（省略可）。
 */
export async function main(options: ServeOptions = {}): Promise<void> {
  const handle = await serve(options)
  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

// `node dist/hub/serve.js` で直接起動できるようにする（テスト import 時は発火しない）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
