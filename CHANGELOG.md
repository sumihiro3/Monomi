# Changelog

このプロジェクトの注目すべき変更はすべてこのファイルに記載する。

フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) にもとづき、[Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

## [Unreleased]

### Added

- `npx monomi-cli`（または `monomi`）一発起動: hub 自動起動 → 初回セットアップ確認 → ダッシュボード表示までを1コマンドで完結
- hub の自己修復自動起動: `monomi` 実行時に hub への疎通が無ければ自パッケージ内の hub を自動起動してからダッシュボードを表示（`role: child` のマシンでは行わない）
- `monomi hub status` / `monomi hub stop` コマンド: hub の稼働状態（稼働中／停止中／stale pid）の確認と、安全な停止（SIGTERM・終了確認・pid ファイル削除）
- 初回起動時、Claude Code フックが未登録の場合に `install-hooks` 実行の確認プロンプトを表示（拒否した場合は再確認しない。非 TTY 環境では案内表示のみ）
- 一覧カード・詳細ビューに稼働中の Workflow／Skill／Agent の経過時間を表示（例: `▶ run-release (12m)`）

### Fixed

- バックグラウンド Workflow 稼働中に稼働中作業の表示が消灯したり別の Skill 名に化けたりする不具合を修正

### Security

- 稼働中作業の種別（kind）が未知の値の場合、表示前にサニタイズするよう修正し、想定外の文字列がそのまま描画される問題を解消

## [0.1.0] - 2026-07-07

Monomi の初回公開リリース。`monomi-cli` として npm 公開レジストリへ配布を開始した。0.1.0 より前（release-1〜16）は公開前の内部イテレーションであり、本ファイルには記載しない。

### Added

- 複数デバイス・複数プロジェクトの Claude Code セッション状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード（`monomi`）
- 状態を集約する hub（`monomi hub`）: Node.js + SQLite（`node:sqlite`）による常駐 API サーバ
- 複数デバイスのペアリング（`monomi hub pair` / `monomi pair`）: Mac mini 上の hub と MacBook 等の child を LAN／Tailscale 経由で接続し、child 側のセッション状態も横断表示
- Claude Code フック連携（`monomi install-hooks` / `monomi uninstall-hooks`）: SessionStart・UserPromptSubmit・PreToolUse・PostToolUse・Notification・Stop・SessionEnd の各フックから hub へ状態を報告
- npm 公開レジストリへの配布整備（`monomi-cli`）: `npm install -g monomi-cli` による導入、reporter の同梱・自動配置、起動時 Node バージョン検査
