# Monomi 要件サマリー（機能軸）

> 本ドキュメントは Monomi が現状「何ができるか」を機能軸で要約するもの。決定の経緯・受け入れ基準（AC）の細部・未解決事項などは書かず、各機能から対応する `docs/releases/release-N/requirements.md`（表形式の要件定義書）へリンクする。設計・実装の権威仕様は `ARCHITECTURE.md`、既知の課題は `docs/known-issues.md` を参照。

Monomi は、複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード。以下の機能で構成される。

## 単機ダッシュボード（中核ループ）

ターミナルに `monomi` と打つと、そのマシンの全プロジェクト／セッションが状態付きで一覧表示される。`npx monomi-cli` でインストール不要に即座に試せる。

- `monomi install-hooks` / `uninstall-hooks` で Claude Code の 7 フックを `~/.claude/settings.json` へ冪等に登録・除去する（他ツール由来のフックは保持）。
- hub（素の Node.js + SQLite）が状態イベントを集約し、WAL モードの `~/.monomi/monomi.db` に保存する。
- 同一リポジトリの表記ゆれ（SSH / HTTPS 形式など）を hub 側の `ProjectKeyNormalizer` で一本化し、横断一覧で 1 リポジトリが複数行に割れないようにする。
- `monomi`（引数なし）実行時、hub が不在なら自己修復的に自動起動し、以後 detached で常駐する（pm2 等の外部プロセスマネージャは不要）。`monomi hub status` / `monomi hub stop` で常駐状態を確認・停止できる。フック未登録かつ対話端末での初回実行時は `install-hooks` の実行を確認するプロンプトが出る。

詳細: [release-1-single-machine-wedge](releases/release-1-single-machine-wedge/requirements.md) / [release-17-npm-distribution](releases/release-17-npm-distribution/requirements.md) / [release-18-npx-quickstart](releases/release-18-npx-quickstart/requirements.md)

## フック連携・reporter

Claude Code のフック発火時に、bash レポーターが instance／session 情報を hub へ POST する。

- `Notification` / `SessionStart` / `Stop` などのフックからイベントを送出し、reporter 側では `git remote get-url origin` の生出力をそのまま送る（正規化は hub 側）。
- hub 到達先を複数併記（LAN / Tailscale 等）し、上から順に試して最初に成功した先へ送る。全滅時のみ `~/.monomi/outbox/` へ退避し、次回発火でまとめて再送する。
- 恒久エラー（HTTP 4xx）のイベントは `outbox/rejected/` へ隔離し、キューを閉塞させない。

詳細: [release-1-single-machine-wedge](releases/release-1-single-machine-wedge/requirements.md) / [release-3-multi-device-pairing](releases/release-3-multi-device-pairing/requirements.md)

## status 導出

受信したイベント（イベント時刻ベース）から各セッションの状態を導出し、instance の代表ステータスを決める。

- `Notification(permission_prompt)` → 権限待ち、`Notification(idle_prompt)` → 次の指示待ち、といった raw_state をセッション単位で導出する。
- 状態が閾値（既定: active は 2 時間、config で上書き可）を超えて継続すると「放置（stale）」へ昇格する。
- instance 配下に複数セッションがある場合、優先度が最も高いセッションの状態を instance の代表ステータスとして返す（ロールアップ）。
- セッションが稼働中（`active`）の間、`tool_name`/`tool_summary` から「実行中の作業名（`running_work`）」（Workflow／Agent／Skill 名。Workflow を優先）を導出し、一覧・詳細の両 API に返す。稼働中でなくなったら消える。
- hub が `github.com` 上の instance のブランチを対象に GitHub の PR レビュー状態を定期ポーリング（既定 5 分間隔、`gh` CLI 経由）し、レビュー未着手であれば「PR レビュー待ち（`PR_WAIT`）」へ昇格させる。詳細ビューには PR 番号・状態・draft 注記を表示し、対応端末では PR 番号がクリック可能なリンクになる。

詳細: [release-1-single-machine-wedge](releases/release-1-single-machine-wedge/requirements.md) / [release-3-multi-device-pairing](releases/release-3-multi-device-pairing/requirements.md) / [release-16-running-work-display](releases/release-16-running-work-display/requirements.md) / [release-27-github-pr-poller](releases/release-27-github-pr-poller/requirements.md)

## マルチデバイスペアリング・認証

MacBook（child）で動くセッションの状態を、Mac mini（hub）のダッシュボードに横断表示できる。

- hub 側で `monomi hub pair` を実行すると 6 桁コード（TTL 5 分・5 回失敗で無効化）と到達先候補 URL を表示し、child 側で `monomi pair --code <code> --hub <url>` を実行してペアリングする。
- Bearer トークンを `tokens` テーブルに SHA-256 で保存し、リクエストはトークンから導出した `device_id` に束縛する（なりすまし書き込み防止）。無効・失効トークンは 401。
- `monomi hub devices list` / `devices revoke <id>` で登録デバイスとトークンの有効／失効を管理する。
- hub は既定で `0.0.0.0`（config `bind` で上書き可）に待受し、child の reporter／ダッシュボードは複数エンドポイントを順に試して到達する（LAN 断時は Tailscale へフォールバック）。

詳細: [release-1-single-machine-wedge](releases/release-1-single-machine-wedge/requirements.md)（認証の基盤: tokens テーブル・device_id 自動生成・ローカル token 自動発行） / [release-3-multi-device-pairing](releases/release-3-multi-device-pairing/requirements.md)（ペアリング・devices 管理・マルチエンドポイント）

## CLI ダッシュボード UX

Ink による TUI ダッシュボードで、Claude Code の Agent View に近い体験を提供する。

- instance 1 件をボーダー付きのカードとして描画し、ターミナル幅に応じて複数列へ自動折返しする（狭い端末では 1 列に縮退）。カードにはプロジェクト・デバイス（ターミナルアプリ名併記）・ブランチ・パス（中間省略表示）・状態・実行中の作業名を表示する。
- `monomi` 起動直後から watch（ポーリング）が常時 ON。`1`-`6` の状態フィルタ（既定では終了済みセッションは非表示）、`j`/`k`・`↑`/`↓` でのカーソル移動、`Enter` で詳細ビュー（Agent View Lv.1）を表示する。
- 詳細ビューは概要 BOX とスクロール可能なイベント履歴 BOX で構成し、表示中も一覧と同じ間隔で自動更新される。隣接プロジェクトへの移動（`←`/`→`）・イベント行の折り返し切替（`w`）に対応する。

詳細: [release-4-cli-dashboard-ux](releases/release-4-cli-dashboard-ux/requirements.md) / [release-6-detail-view-redesign](releases/release-6-detail-view-redesign/requirements.md) / [release-8-dashboard-freshness](releases/release-8-dashboard-freshness/requirements.md) / [release-24-dashboard-display-polish](releases/release-24-dashboard-display-polish/requirements.md)

## ターミナルフォーカス（`f` キー）

一覧・詳細ビューで instance を選択中に `f` キー 1 発で、そのセッションが実行中のターミナルタブ/ウィンドウへフォーカスを移す。

- 対応ターミナル: Terminal.app・Ghostty・tmux・WezTerm。別デバイスの行・closed 状態のセッション・ターミナル情報が取得できない行では実行されず理由が notice 表示される。
- WezTerm はペイン単位フォーカスに対応する（`wezterm cli activate-pane` + OS レベルのウィンドウ前面化）。macOS は追加設定不要。WSL2 は Windows 側 `.wezterm.lua` への `WSLENV=WEZTERM_PANE` 追記が前提で、未検出時は Windows Terminal のウィンドウ前面化（best-effort）へフォールバックする。ネイティブ Linux（X11/Wayland）は前面化手段が未検証のため対象外（既知課題 U21）。

詳細: [release-23-terminal-focus](releases/release-23-terminal-focus/requirements.md) / [release-28-wezterm-focus](releases/release-28-wezterm-focus/requirements.md)

## 表示言語（i18n）

CLI 表示文言を日本語・英語で切り替えられる。

- `config.yml` の `locale: ja|en` で明示指定できる。未設定時は OS の言語設定（macOS は `AppleLocale` を優先、それ以外は `LANG`）から自動判定し、判定できなければ英語（既定）になる。

詳細: [release-9-i18n](releases/release-9-i18n/requirements.md) / [release-19-session-status-and-locale-detection](releases/release-19-session-status-and-locale-detection/requirements.md)（OS ロケール自動判定の精度改善）

## 配布・自動更新

`npx monomi-cli` でインストール不要にすぐ試せ、hub・reporter は起動のたびに版照合され自動的に最新へ揃う。

- npm パッケージ `monomi-cli` として公開（`v*` タグ push で GitHub Actions が自動 publish・GitHub Release 作成）。
- `monomi`（引数なし）実行時、接続先 hub のバージョンを応答ヘッダで照合し、自版より古い・または不明なら hub を graceful 停止して新版を自動起動する。reporter も同様に配置済みスクリプトの版マーカーを照合し古ければ自動的に上書きする。`config.yml` の `auto_update: false` で自動更新（版ずれの通知のみ）を抑止できる。

詳細: [release-17-npm-distribution](releases/release-17-npm-distribution/requirements.md) / [release-25-auto-update](releases/release-25-auto-update/requirements.md)

## 補足: 機能以外のリリース

以下は機能追加ではないため機能軸には含めないが、リリースサイクルの一部として記録されている。

- [release-2-biome-migration](releases/release-2-biome-migration/requirements.md): Lint・フォーマットを Biome へ統一（Markdown のみ Prettier）する開発基盤の移行。
- [release-5-docs-restructure](releases/release-5-docs-restructure/requirements.md): 現状スナップショット（本ドキュメント・`ARCHITECTURE.md` 等）と設計経緯（`monomi-handoff.md` 凍結）の分離。
- [release-12-workflow-generalization](releases/release-12-workflow-generalization/requirements.md) / [release-14-pipeline-performance](releases/release-14-pipeline-performance/requirements.md) / [release-15-template-extraction](releases/release-15-template-extraction/requirements.md): リリース自動化ワークフロー（`run-release` エンジン）自体の汎用化・性能改善・テンプレート化。
- [release-22-github-releases-and-english-readme](releases/release-22-github-releases-and-english-readme/requirements.md): npm 公開運用の整備（GitHub Release 自動作成）と README の英語化。

開発ワークフロー（release-N の命名規則・known-issues.md の運用規約など）は `docs/development-workflow.md` を参照。
