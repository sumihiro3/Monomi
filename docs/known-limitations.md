# 既知の制限（利用者向け）

Monomi を試す前に知っておくと良い制限をまとめる。開発の内部バックログ（レビュー所見・内部実装メモを含む詳細な課題管理）は `docs/known-issues.md` を参照（開発者・コントリビュータ向け）。

## 未実装の機能

- **状態変化時の OS 通知**: セッションの状態（権限待ち・放置など）が変わったタイミングでの OS 通知は未実装。ダッシュボードを開いて確認する運用が前提
- **異常終了・ライブネス検知**: Claude Code プロセスが `kill -9` 等で強制終了された場合、hub 側はそれを検知できない。しばらくの間「稼働中」と表示され続けることがある

## best-effort な機能

- **実行中の Workflow / Agent / Skill 名の検出**: 一覧・詳細に表示される実行中の作業名は best-effort。ネストした Workflow/Agent 呼び出しでは実際と異なる名前が表示される場合がある
- **ターミナルフォーカス（`f` キー）**: 対応ターミナルは Terminal.app・Ghostty・tmux・WezTerm、対応 OS は macOS・WSL2・Linux ネイティブ（WezTerm 利用時のみ）。macOS・Linux ネイティブの WezTerm は追加設定不要でペイン単位フォーカスに対応（macOS は実機検証済み）。WSL2 は WezTerm 検出時にペイン単位フォーカスを試行し、未検出時は Windows Terminal のウィンドウ前面化（タブ特定不可の best-effort）へフォールバックする。WSL2 で WezTerm フォーカスを使うには、WSL 側が `$WEZTERM_PANE` を参照できるよう Windows 側 `.wezterm.lua` に `WSLENV` へ `WEZTERM_PANE` を追記する設定が前提（自動設定はしない設計判断。詳細は README「Terminal Focus」節）。**WSL2 での既知の制約（実機検証で確認済み）**: WezTerm ペイン単位フォーカスは、Monomi CLI と対象セッションの WSL2 シェルの**両方が WezTerm のペイン内から起動されている場合にのみ確実に動作する**。どちらか一方でも別の Windows ターミナルアプリ（PowerShell・Windows Terminal 等）経由で WSL2 シェルを開いた場合、`wezterm.exe cli activate-pane` が WSL interop 経由での mux ソケット接続に失敗することがある（upstream の既知の制約、[wezterm/wezterm discussions #6964](https://github.com/wezterm/wezterm/discussions/6964)）。この場合 Monomi は失敗を検知し Windows Terminal フォールバックへ進むが、Windows Terminal を使っていなければどのウィンドウも前面化されない。iTerm2・VS Code 統合ターミナル・ネストした tmux/WezTerm・tmux と WezTerm の併用構成は未対応
- **PR レビュー待ちの自動取得**: GitHub（`github.com`）のリポジトリのみ対応。GitLab・Bitbucket 等は非対応。取得には `gh` CLI（`gh auth login` 済み）が必要で、未導入・未認証の場合は詳細ビューの PR 欄が常に `none` と表示される（既存動作へのフォールバック）

## 環境依存の注意事項

- **複数端末構成（マルチデバイス）**: LAN・Tailscale 経由の到達先フォールバックには対応しているが、ネットワーク環境によっては `~/.monomi/config.yml` の `hub_endpoints` を手動調整する必要がある場合がある
- **対応ロケール**: 表示言語は `ja`（日本語）・`en`（英語）の2言語のみ

## 今後変わりうるもの

- ダッシュボードの表示内容・日本語/英語の文言は今後のリリースで変更される可能性がある

---

上記以外の不具合報告・機能要望は [GitHub Issues](https://github.com/sumihiro3/Monomi/issues) へどうぞ。
