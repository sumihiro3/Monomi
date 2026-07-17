# Changelog

このプロジェクトの注目すべき変更はすべてこのファイルに記載する。

フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) にもとづき、[Semantic Versioning](https://semver.org/lang/ja/) に準拠する。

## [Unreleased]

### Fixed

- README／README.ja.md の Uninstalling 節にあった事実誤認（`monomi hub stop` が launchd 常駐時に `launchctl unload` も行うという、実装に存在しない挙動の記述）を削除。launchd で hub を常駐化している場合は `monomi hub stop` の前に手動で `launchctl unload ~/Library/LaunchAgents/com.monomi.hub.plist` を実行し、plist ファイルも削除する必要がある旨と、省略すると `KeepAlive: true` により launchd が hub を自動再起動し「止まった」と誤認したままアンインストールが進んでしまう理由を追記（手順は4ステップ→6ステップに変更）
- README／README.ja.md の Updating 節に、`npx monomi-cli@latest` での更新手段と、`npm update -g` 後も稼働中の hub・配置済み reporter は次回の引数なし `monomi` 起動時まで自動更新されない旨（「Automatic updates (hub & reporter)」節への相互参照）を追記
- README／README.ja.md の Automatic updates 節冒頭の文言を、毎回の `monomi` 起動で版照合されるかのように読めた表現から、引数なし起動時に限定されることが伝わる表現に修正

## [0.3.0] - 2026-07-17

### Added

- 新キー `f`: 一覧・詳細どちらの画面でも、選択中セッションが実行されているターミナルタブへ OS レベルでフォーカスを移動できるようになった。対応ターミナルは Terminal.app / Ghostty / tmux、対応 OS は macOS・WSL2（WSL2 はウィンドウ前面化までの best-effort）。同一デバイスのセッションを選択している場合のみフッターに `f focus` のヒントを表示し、別デバイスの行・closed 状態のセッション・ターミナル情報が取得できない行では実行されず理由が notice 表示される
- ヘルプオーバーレイ（`?`）に `f`（ターミナルへフォーカス）の説明を追加
- README／README.ja.md に「Terminal Focus」節を新設。有効化に必要な権限（システム設定 → アクセシビリティで `monomi` と `System Events` を許可）、Ghostty 利用時に `~/.claude/settings.json` へ `env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE` を手動追記する手順、Linux/WSL2 での対応範囲を明記
- 一覧カードの `device` 行に、検出できた場合はターミナルアプリ名を `device-name (Ghostty)` のように括弧付きで併記するようになった（対応: Terminal.app・Ghostty・iTerm2・VS Code・tmux。検出できない行は従来通り device 名のみ表示し、カードの行数は変わらない）
- 詳細ビューの `path` 行の直後に新規 `terminal` 行を追加し、ターミナルアプリ名（検出できない場合は `-`）を表示するようになった
- 一覧カードに `path` 行を追加（`branch` 行の直後・カードは5行→6行に）。ホームディレクトリは `~/...` に短縮したうえで、長い場合は先頭と末尾を残して中間を省略して表示する
- バージョン自動更新機能を追加（npm 配布後の版混在問題への対応）。`monomi`（引数なし）起動時、接続先の hub が旧版であれば自動的に再起動して新版に更新し、reporter（`monomi-report.sh`）も旧版であれば自動的に再配置される。既定でオプトインなしに有効。更新結果・警告はダッシュボード上部の黄色い永続 notice 領域に表示される（更新成功／更新失敗のため旧版のまま継続／CLI 側が旧版／版ずれ抑止中、のいずれか）
- `monomi hub status` の稼働中表示に hub の版番号が追加された（例: `hub は稼働中です（pid 123, port 47632, version 0.2.0）`）。旧版の hub（バージョンヘッダ未対応）に対しては「不明」と表示される
- child ロールで接続中のリモート hub が旧版の場合、hub デバイス側での更新を促す notice が常時表示されるようになった（同一内容が重複増殖することはない）
- `config.yml` に新設定項目 `auto_update`（既定 `true`）を追加。`false` に設定すると自動更新を停止し、通知のみの表示に変更できる

### Fixed

- 自動作成される GitHub Release のタイトル（name フィールド）が空になっていたのを修正（タグ名を明示指定するように変更）
- `f` キーでのフォーカス実行時、対象が Terminal.app や Ghostty 以外のセッションであっても Terminal.app が未起動なら誤って自動起動してしまう不具合を修正。あわせて、Ghostty が未起動の場合に対象外ターミナルのタブタイトルが一瞬変化してしまう副作用も解消

## [0.2.0] - 2026-07-14

### Added

- npm 公開（`v*` タグの push）時に GitHub Release を自動作成するようになった。リリースノートには CHANGELOG の該当バージョン節がそのまま転記される

### Changed

- README を全面英語化し、日本語版を `README.ja.md` として分離（情報量は同等を維持し、相互リンクで行き来できる）
- README（英語・日本語版共通）の対応環境の説明に、npm 10.8.2 等の環境では `npm install -g monomi-cli` が `Exit handler never called!` で失敗する場合がある旨と、npm 自体を更新すれば解消する旨の注記を追加
- LICENSE の著作権表記からメールアドレスを削除（`sumihiro3 <sumihiro@gmail.com>` → `sumihiro3`）

## [0.1.2] - 2026-07-14

### Added

- ダッシュボード起動のたびに診断用ログファイル `~/.monomi/cli.log` を追加生成するようになった（メモリ使用量と出力バッファ長を既定60秒間隔で記録。既存の `hub.log`／`config.yml`／`monomi.db` の形式・挙動は変更なし）

### Changed

- 詳細ビュー表示中は一覧のバックグラウンドポーリングを停止するようになり、詳細ビューを開いている間の帯域・CPU使用を削減（一覧の表示自体は変わらない）
- ターミナルへの出力が詰まる状況（バックグラウンドタブ・接続が不安定な SSH 等）では、稼働中インジケータの点滅や一覧の更新が一時的に止まって見えることがある（描画が追いつき次第、自動的に再開する）
- 診断用ログファイル `~/.monomi/cli.log` にログローテーションを追加。10MB に達すると直近分を `cli.log.old` へ退避してから新規追記するようになり、長期稼働時のディスク使用量が最大約20MBで頭打ちになる（従来は無制限に肥大化していた）

### Security

- 一覧カード・詳細ビューでの `project.name` 表示を、同画面内の `device.name` 等と同様にサニタイズしてから描画するよう修正。制御文字・ANSI エスケープシーケンスが混入した値が端末にそのまま出力される問題を解消

## [0.1.1] - 2026-07-10

### Changed

- CLI の表示言語判定に OS 設定からの自動判定を追加。`config.yml` に `locale:` を明示しない場合、macOS ではシステムの言語設定（`AppleLocale`）を優先し、取得できない場合のみ `LANG` 環境変数（例: `ja_JP.UTF-8`）から日本語/英語を自動判定するようになった（macOS 以外は `LANG` のみ。`config.yml` の明示設定は引き続き最優先で、後方互換）

### Fixed

- セッションが正常終了した直後に、無関係な孤立セッションの「放置」表示が代表として浮上する不具合を修正

## [0.1.0] - 2026-07-09

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

## [0.0.1] - 2026-07-07

Monomi の初回公開リリース。`monomi-cli` として npm 公開レジストリへ配布を開始した。0.1.0 より前（release-1〜16）は公開前の内部イテレーションであり、本ファイルには記載しない。

### Added

- 複数デバイス・複数プロジェクトの Claude Code セッション状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード（`monomi`）
- 状態を集約する hub（`monomi hub`）: Node.js + SQLite（`node:sqlite`）による常駐 API サーバ
- 複数デバイスのペアリング（`monomi hub pair` / `monomi pair`）: Mac mini 上の hub と MacBook 等の child を LAN／Tailscale 経由で接続し、child 側のセッション状態も横断表示
- Claude Code フック連携（`monomi install-hooks` / `monomi uninstall-hooks`）: SessionStart・UserPromptSubmit・PreToolUse・PostToolUse・Notification・Stop・SessionEnd の各フックから hub へ状態を報告
- npm 公開レジストリへの配布整備（`monomi-cli`）: `npm install -g monomi-cli` による導入、reporter の同梱・自動配置、起動時 Node バージョン検査
