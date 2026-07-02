# release-1-single-machine-wedge — 要件定義

- リリース識別子: `release-1-single-machine-wedge`
- ステータス: 確定
- 作成日: 2026-07-02
- 対応する設計: `monomi-handoff.md` §0（確定仕様）、`docs/design/class-diagram.md`

## 背景と目的

複数デバイス・複数プロジェクトで Claude Code を並行運用していると、どのプロジェクトがどんな状態かを見失う。Monomi はこれを横断確認できる CLI ダッシュボードにする。

本リリースの目的は、**Mac mini 1台・hub 単体構成で「ターミナルに `monomi` と打つと、そのマシンの全プロジェクト/セッションが状態付きで一覧表示される」** という中核ループを完成させること（v1 スコープ決定における MVP ウェッジ）。ここが動けば「使える」と言える最小単位であり、2台目以降の複雑性（ペアリング・マルチエンドポイント・fast-follow 機能）はこの上に段階的に積む。

## スコープの確定（壁打ちでの決定事項）

| 論点    | 決定                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 認証    | **実装する**。ただし中身は「Bearer 検証 + `tokens` テーブル + 起動時のホスト名ベース `device_id` 自動生成 + ローカル用 token 自動発行」（§9 の単機フロー）に限定する。**6桁コードのペアリング HTTP エンドポイント（`pair/start`/`pair/claim`）は複数デバイスが前提の機能のため release-2 に回す**。`tokens` テーブル自体は release-1 で作成済みにするため、release-2 での手戻りはない。 |
| CLI     | **一覧表示 + watch + detail（Agent View Lv.1）まで release-1 でフルに作る**（§10 の Ink 間引き版）。MVP ウェッジの「使える」体験を最初から実現する。                                                                                                                                                                                                                                    |
| 対象 OS | **macOS のみ**で動作確認する。bash レポーターは Linux/WSL2 でも原理上動くはずだが、release-1 では検証しない。                                                                                                                                                                                                                                                                           |
| outbox  | **実装する**。単機構成でも hub が pm2 再起動等で瞬断する間、reporter→hub の POST が失敗しうる。低コストなので release-1 から入れる。                                                                                                                                                                                                                                                    |

## 機能要件

### FR-01: install-hooks コマンド（優先度: 必須）

Claude Code の該当フックを `~/.claude/settings.json` へ冪等に登録する。

- AC-1: `monomi install-hooks` 実行後、`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Notification` / `Stop` / `SessionEnd` の7フックが Monomi 起因のマーカー付きで登録されている
- AC-2: 実行前から存在する他ツール由来のフックエントリ（例: 別プロジェクトの `PermissionRequest` フック）が消えずに残っている
- AC-3: 同コマンドを2回実行しても、Monomi 起因のフックが重複登録されない（冪等）
- AC-4: `monomi uninstall-hooks` で Monomi 起因のフックのみ除去され、他のフックは残る

### FR-02: bash レポーター（優先度: 必須）

フック発火時に instance/session 情報を hub へ POST する。

- AC-1: `Notification`(matcher `idle_prompt` または `permission_prompt`) 発火時、reporter がイベントを hub へ POST し `events` テーブルに1行追加される
- AC-2: reporter は `git remote get-url origin` の生出力をそのまま `project_key` 候補として送る（reporter 側では正規化しない、§0.1）
- AC-3: hub が応答不能な間（hub プロセスを止めて POST を試す）、イベントが `~/.monomi/outbox/*.json` に退避される
- AC-4: hub 復旧後、次回フック発火時に outbox 内の未送信イベントがまとめて再送され、`occurred_at` 順で hub に記録される

### FR-03: Hub API + SQLite（優先度: 必須）

- AC-1: `POST /api/v1/events` に生 remote を含むペイロードを送ると、hub 側の `ProjectKeyNormalizer` が正規化し `projects.project_key` に正規化済みの値が保存される
- AC-2: 同一リポジトリを SSH 形式と HTTPS 形式の remote で2回登録しても `projects` テーブルは1行のみ（正規化のゴールデンテスト10件で検証、§0.1）
- AC-3: 起動時、`config.yml` に `device_id` が無ければ hostname ベースで自動生成され `devices` テーブルに登録される
- AC-4: 起動時、対応する token が未発行ならローカル用 token が自動発行され `tokens` テーブルに SHA-256 ハッシュで保存される（§0.3）
- AC-5: Bearer token なし、または無効な token でのリクエストは 401 で拒否される
- AC-6: SQLite は `journal_mode=WAL` / `synchronous=NORMAL` で初期化される

### FR-04: event-time status 導出（優先度: 必須）

`docs/design/class-diagram.md` のレイヤー2（status-engine）に対応。

- AC-1: `Notification(permission_prompt)` を受けた session は `raw_state=approval_wait` と導出される
- AC-2: `Notification(idle_prompt)` を受けた session は `raw_state=next_wait` と導出される
- AC-3: `active` 状態が2時間（config で上書き可能）経過すると `display=stale`（放置）に昇格する。`occurred_at` を人為的に過去へずらしたテストイベントで検証する
- AC-4: `idle_prompt` が複数回発火しても、放置への昇格時計はリセットされない（現在の raw_state 連続区間の最初のイベント時刻を起点にする、§0.5）
- AC-5: instance 配下に複数 session がある場合、優先順位が最も高い session の状態が instance の代表ステータスとして返る（`InstanceStatusRollup`）

### FR-05: CLI（優先度: 必須）

- AC-1: `monomi`（引数なし）実行で、稼働中の全 instance が状態付き一覧表示される
- AC-2: `1`-`5` キーで状態フィルタが切り替わる（複数選択可）
- AC-3: `w` キーで watch モードがオン/オフでき、オン時は数秒おきに一覧が更新される
- AC-4: instance を選択して `Enter` すると、直近のイベントタイムライン（Agent View Lv.1）が表示される
- AC-5: ファジー検索・ソート循環・デバイスフィルタ循環は本リリースに含めない（§10.3 のうち release-1 対象外）

## 非機能要件

- **動作対象**: macOS のみ（bash + curl + git 前提）
- **単機前提**: `config.yml` の `role` は `hub` 固定。`role: child` の解決ロジックは release-1 では実装しない
- **DB ファイルパス**: `~/.monomi/monomi.db`
- **config ファイルパス**: `~/.monomi/config.yml`
- **hub の待受**: `localhost` バインド（release-1 は同一マシン内通信のみ）
- **ポーリング間隔**: watch モードのデフォルトは3秒（config で上書き可能）

## スコープ外（release-1 では実装しない）

- child / 2台目デバイス、`pair/start`・`pair/claim` の6桁コードペアリングフロー
- マルチエンドポイント（LAN IP / Tailscale IP のフォールバック、§0.2）— release-1 は endpoint が1つ（localhost）のみ
- mDNS 探索/アドバタイズ
- PR レビュー待ち（GitHub 連携、fast-follow）
- ライブネス検知（常駐ハートビート／`session_lost`）
- Windows ネイティブ・PowerShell レポーター
- フル TLS/HTTPS
- CLI のファジー検索・ソート循環・デバイスフィルタ循環

## 未解決事項

- hub の待受ポート番号のデフォルト値（実装時に決定し config で上書き可能にする）
- `EscalationThresholds` の config 上書き用 YAML 具体形式
- `install-hooks` の冪等マージにおける「既存フックとの共存」判定基準（マーカーコメント方式か、コマンド文字列の完全一致か）

## 次のステップ

要件確定後、以下で実装フェーズへ進む:

```
Workflow({name: "implement-feature", args: {release: "release-1-single-machine-wedge"}})
```
