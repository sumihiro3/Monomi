# Changelog

このプロジェクトの注目すべき変更はすべてこのファイルに記載する。

フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) にもとづき、[Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

## [Unreleased]

## [0.1.0] - 2026-07-07

Monomi の初回公開リリース。`monomi-cli` として npm 公開レジストリへ配布を開始した。0.1.0 より前（release-1〜16）は公開前の内部イテレーションであり、本ファイルには記載しない。

### Added

- 複数デバイス・複数プロジェクトの Claude Code セッション状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード（`monomi`）
- 状態を集約する hub（`monomi hub`）: Node.js + SQLite（`node:sqlite`）による常駐 API サーバ
- 複数デバイスのペアリング（`monomi hub pair` / `monomi pair`）: Mac mini 上の hub と MacBook 等の child を LAN／Tailscale 経由で接続し、child 側のセッション状態も横断表示
- Claude Code フック連携（`monomi install-hooks` / `monomi uninstall-hooks`）: SessionStart・UserPromptSubmit・PreToolUse・PostToolUse・Notification・Stop・SessionEnd の各フックから hub へ状態を報告
- npm 公開レジストリへの配布整備（`monomi-cli`）: `npm install -g monomi-cli` による導入、reporter の同梱・自動配置、起動時 Node バージョン検査
