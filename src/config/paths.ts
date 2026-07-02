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
  /** ローカル用 device token の保存ファイル (`~/.monomi/token`, §0.3/§9)。 */
  tokenFile: string
}

/**
 * `~/.monomi/` のルートを上書きするための環境変数名。
 *
 * テストや複数構成の切り替えで使う。未設定時は `~/.monomi` を使う。
 */
export const MONOMI_HOME_ENV = 'MONOMI_HOME'

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
    tokenFile: path.join(base, 'token'),
  }
}
