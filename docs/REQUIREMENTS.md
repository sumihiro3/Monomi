# Monomi 要件サマリー（機能軸）

> 本ドキュメントは Monomi が現状「何ができるか」を機能軸で要約するもの。決定の経緯・受け入れ基準（AC）の細部・未解決事項などは書かず、各機能から対応する `docs/releases/release-N/requirements.md`（表形式の要件定義書）へリンクする。設計・実装の権威仕様は `ARCHITECTURE.md`、既知の課題は `docs/known-issues.md` を参照。

Monomi は、複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード。以下の機能で構成される。

## 単機ダッシュボード（中核ループ）

Mac mini 1 台・hub 単体で「ターミナルに `monomi` と打つと、そのマシンの全プロジェクト／セッションが状態付きで一覧表示される」中核ループ（フック → hub → ダッシュボード）が動作する。

- `monomi install-hooks` / `uninstall-hooks` で Claude Code の 7 フックを `~/.claude/settings.json` へ冪等に登録・除去する（他ツール由来のフックは保持）。
- hub（素の Node.js + SQLite）が状態イベントを集約し、WAL モードの `~/.monomi/monomi.db` に保存する。
- 同一リポジトリの表記ゆれ（SSH / HTTPS 形式など）を hub 側の `ProjectKeyNormalizer` で一本化し、横断一覧で 1 リポジトリが複数行に割れないようにする。

詳細: [release-1-single-machine-wedge](releases/release-1-single-machine-wedge/requirements.md)

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

詳細: [release-1-single-machine-wedge](releases/release-1-single-machine-wedge/requirements.md) / [release-3-multi-device-pairing](releases/release-3-multi-device-pairing/requirements.md) / [release-16-running-work-display](releases/release-16-running-work-display/requirements.md)

## マルチデバイスペアリング・認証

MacBook（child）で動くセッションの状態を、Mac mini（hub）のダッシュボードに横断表示できる。

- hub 側で `monomi hub pair` を実行すると 6 桁コード（TTL 5 分・5 回失敗で無効化）と到達先候補 URL を表示し、child 側で `monomi pair --code <code> --hub <url>` を実行してペアリングする。
- Bearer トークンを `tokens` テーブルに SHA-256 で保存し、リクエストはトークンから導出した `device_id` に束縛する（なりすまし書き込み防止）。無効・失効トークンは 401。
- `monomi hub devices list` / `devices revoke <id>` で登録デバイスとトークンの有効／失効を管理する。
- hub は既定で `0.0.0.0`（config `bind` で上書き可）に待受し、child の reporter／ダッシュボードは複数エンドポイントを順に試して到達する（LAN 断時は Tailscale へフォールバック）。

詳細: [release-1-single-machine-wedge](releases/release-1-single-machine-wedge/requirements.md)（認証の基盤: tokens テーブル・device_id 自動生成・ローカル token 自動発行） / [release-3-multi-device-pairing](releases/release-3-multi-device-pairing/requirements.md)（ペアリング・devices 管理・マルチエンドポイント）

## CLI ダッシュボード UX

Ink による TUI ダッシュボードで、Claude Code の Agent View に近い体験を提供する。

- instance 1 件をボーダー付きのカードとして描画し、ターミナル幅に応じて複数列へ自動折返しする（狭い端末では 1 列に縮退）。
- `monomi` 起動直後から watch（ポーリング）が常時 ON。`1`-`5` の状態フィルタ、`j`/`k`・`↑`/`↓` でのカーソル移動、`Enter` で詳細ビュー（Agent View Lv.1）を表示する。
- 詳細ビューは表示中も一覧と同じ間隔で自動更新され、閉じると更新を停止する。ビューに応じてフッターのショートカットヒントを切り替える。

詳細: [release-4-cli-dashboard-ux](releases/release-4-cli-dashboard-ux/requirements.md)

## 補足: 機能以外のリリース

以下は機能追加ではないため機能軸には含めないが、リリースサイクルの一部として記録されている。

- [release-2-biome-migration](releases/release-2-biome-migration/requirements.md): Lint・フォーマットを Biome へ統一（Markdown のみ Prettier）する開発基盤の移行。
- [release-5-docs-restructure](releases/release-5-docs-restructure/requirements.md): 現状スナップショット（本ドキュメント・`ARCHITECTURE.md` 等）と設計経緯（`monomi-handoff.md` 凍結）の分離。

開発ワークフロー（release-N の命名規則・known-issues.md の運用規約など）は `docs/development-workflow.md` を参照。
