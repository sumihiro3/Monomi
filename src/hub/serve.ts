import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config/config.js'
import { ensureMonomiHome, type MonomiPaths, resolvePaths } from '../config/paths.js'
import { type Database, openDatabase } from '../db/database.js'
import type { EpochMs } from '../domain/time.js'
import { EscalationThresholds } from '../status/escalation.js'
import { bootstrap } from './bootstrap.js'
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
  /** サーバ停止 + DB クローズ。 */
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
 * hub をブートストラップして API サーバを起動する（`monomi hub` の実体 / FR-03）。
 *
 * 手順:
 * 1. `~/.monomi` を用意し config を読み込む。
 * 2. DB を開き（WAL/NORMAL、DDL 冪等適用）、{@link bootstrap} で device_id 自動生成・
 *    ローカルトークン発行（FR-03 AC-3/AC-4）を冪等に済ませる。
 * 3. config 由来の閾値で DI 配線した {@link HttpServer} を待ち受ける。バインド先は
 *    `options.host` > config `bind:` > 既定 `0.0.0.0` の優先順で解決する（FR-06 AC-1）。
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

  log(`Monomi hub listening on http://${host}:${port} (device: ${boot.deviceId})`)

  return {
    server,
    db,
    port,
    deviceId: boot.deviceId,
    rawToken: boot.rawToken,
    close: async () => {
      await server.close()
      db.close()
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
