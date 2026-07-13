import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `~/.monomi/` 配下の各種ファイル/ディレクトリの絶対パス集合。
 *
 * hub / CLI / reporter の全レイヤーがここを唯一のパス解決の入口として使い、
 * `~/.monomi/...` の文字列連結をコード各所に散らさないための値オブジェクト。
 */
export interface MonomiPaths {
  /** ルートディレクトリ (`~/.monomi`)。 */
  home: string
  /** 設定ファイル (`~/.monomi/config.yml`)。 */
  configFile: string
  /** SQLite DB ファイル (`~/.monomi/monomi.db`)。 */
  dbFile: string
  /** 送信失敗イベントの退避先ディレクトリ (`~/.monomi/outbox`, §0.2)。 */
  outboxDir: string
  /** 4xx で恒久的に拒否されたイベントの隔離先 (`~/.monomi/outbox/rejected`, FR-07)。 */
  rejectedDir: string
  /** ローカル用 device token の保存ファイル (`~/.monomi/token`, §0.3/§9)。 */
  tokenFile: string
  /** hub プロセスの pid ファイル (`~/.monomi/hub.pid`, FR-02)。自動起動・stop/status の管理に使う。 */
  hubPidFile: string
  /** hub の起動ログ追記先 (`~/.monomi/hub.log`, FR-01/FR-02)。detached spawn の stdout/stderr 受け皿。 */
  hubLogFile: string
  /** CLI プロセスの稼働監視ログ追記先 (`~/.monomi/cli.log`, release-20-dashboard-heap-guard FR-01)。メモリ・stdoutバックプレッシャー計測記録。 */
  cliLogFile: string
  /**
   * 初回セットアップ確認プロンプト（install-hooks）の拒否を永続化するマーカーファイル
   * (`~/.monomi/setup-prompt-declined`, release-18-npx-quickstart FR-03)。
   *
   * 存在すれば「過去に拒否済み」を意味する（内容は見ない。空ファイルで足りる）。`config.yml` の
   * キーにはしない — config.yml は bash reporter が行単位で読むため、無関係なキーを増やして
   * その読み取りに影響を与えないようにする（設計判断）。
   */
  setupPromptStateFile: string
}

/**
 * `~/.monomi/` のルートを上書きするための環境変数名。
 *
 * テストや複数構成の切り替えで使う。未設定時は `~/.monomi` を使う。
 */
export const MONOMI_HOME_ENV = 'MONOMI_HOME'

/**
 * `~/.monomi` ルートディレクトリのパーミッション（`0o700`）。
 *
 * device token・config.yml・SQLite DB など機微ファイルの格納先であるため、所有者以外から
 * 一切アクセスできないよう固定する（known-issues S1）。
 */
export const HOME_DIR_MODE = 0o700

/**
 * Monomi のパス集合を解決する。
 *
 * 優先順位は `home` 引数 → 環境変数 `MONOMI_HOME` → `os.homedir()/.monomi`。
 * 環境変数を毎回読み直すため、テストで `process.env.MONOMI_HOME` を差し替えると即座に反映される。
 *
 * @param home ルートディレクトリを明示指定する場合のパス（省略可）。
 * @returns 解決済みの {@link MonomiPaths}。
 */
export function resolvePaths(home?: string): MonomiPaths {
  const base = home ?? process.env[MONOMI_HOME_ENV] ?? path.join(os.homedir(), '.monomi')
  return {
    home: base,
    configFile: path.join(base, 'config.yml'),
    dbFile: path.join(base, 'monomi.db'),
    outboxDir: path.join(base, 'outbox'),
    rejectedDir: path.join(base, 'outbox', 'rejected'),
    tokenFile: path.join(base, 'token'),
    hubPidFile: path.join(base, 'hub.pid'),
    hubLogFile: path.join(base, 'hub.log'),
    cliLogFile: path.join(base, 'cli.log'),
    setupPromptStateFile: path.join(base, 'setup-prompt-declined'),
  }
}

/**
 * `~/.monomi` ルートディレクトリを作成し、パーミッションを `0o700` に固定する。
 *
 * hub / bootstrap / pairing-client など `~/.monomi` を作る全箇所が使う共通ヘルパー（known-issues S1）。
 * `mkdirSync` の `mode` オプションは umask でマスクされ既存ディレクトリには適用されないため、
 * 新規・既存いずれの場合も呼び出し後に明示的な `chmodSync` で `0o700` へ揃える
 * （{@link HOME_DIR_MODE}。bootstrap の `writeTokenFile` と同趣旨）。
 *
 * @param paths {@link resolvePaths} で解決したパス集合。
 */
export function ensureMonomiHome(paths: MonomiPaths): void {
  fs.mkdirSync(paths.home, { recursive: true })
  fs.chmodSync(paths.home, HOME_DIR_MODE)
}
