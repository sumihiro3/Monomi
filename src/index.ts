/**
 * Monomi をライブラリとして programmatic に組み込むための公開 API バレル。
 *
 * `monomi` バイナリ自体のサブコマンドディスパッチは {@link "./cli.js"} を参照（そちらは
 * プロセス起動時の argv 解決に専念し、ライブラリとしての再利用はここを窓口にする）。
 * 内部実装（domain-model / status-engine の個々のクラス等）は意図的に再エクスポートしない。
 * ここで公開するのは各レイヤーの「入口」となる関数・クラスのみで、実装詳細の変更が
 * この面を通じて外部へ波及するのを防ぐ。
 */

/** パッケージのバージョン文字列（`monomi --version` が表示する値）。 */
export const MONOMI_VERSION = '0.0.1'

// hub-api: hub の起動（DB 初期化 + bootstrap + HTTP サーバ、FR-03）。
export { serve, type ServeOptions, type HubHandle } from './hub/serve.js'

// install-hooks: Claude Code の settings.json への冪等フック登録（FR-01）。
export {
  installHooks,
  uninstallHooks,
  type InstallHooksOptions,
  type InstallHooksResult,
} from './install-hooks/install-hooks.js'

// cli-ink: hub への読み取りクライアントと Ink ダッシュボードの入口（FR-05）。
export { HubApiClient, createHubApiClient } from './cli/hub-api-client.js'
export { AppView, type AppViewProps } from './cli/components/app-view.js'

// config: `~/.monomi` のパス解決と設定読み込み（外部ツールから参照したいケース向け）。
export { loadConfig, type MonomiConfig } from './config/config.js'
export { resolvePaths, type MonomiPaths } from './config/paths.js'
