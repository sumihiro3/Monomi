# release-3-multi-device-pairing — 要件定義

- リリース識別子: `release-3-multi-device-pairing`
- ステータス: 確定
- 作成日: 2026-07-02
- 対応する設計: `monomi-handoff.md` §0.2 / §0.3 / §3.1 / §9、`docs/design/class-diagram.md`
- 前提: release-1（単機ウェッジ）・release-2（Biome 移行）完了済み

## 背景と目的

release-1 で単機の中核ループ（フック→hub→ダッシュボード）が完成した。本リリースは Monomi の主目的である**マルチデバイス対応**を実現する: MacBook（child）で動く Claude Code セッションの状態が、Mac mini（hub）の `monomi` ダッシュボードに横断表示される状態にする。

成功基準: **MacBook で権限待ちになったセッションが、Mac mini のターミナルの `monomi` 一覧に「権限待ち」として表示される**（LAN 断時は Tailscale 経由に自動フォールバック）。

あわせて、ネットワーク越し運用で実害確率が上がる known-issues（outbox 閉塞・ホットパス・lint 指摘）を同梱して解消する。

## スコープの確定（壁打ちでの決定事項）

| 論点               | 決定                                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同梱範囲           | コア（child・ペアリング・devices 管理・マルチエンドポイント）に加え、**B1+B2（outbox 閉塞）・P1+P2（ホットパス）・L1+L2（lint 指摘）をすべて同梱**                                                                                                                      |
| S2（読み取り認可） | **「任意の有効トークンで全デバイスの instance/イベントを閲覧できる」ことを仕様として明文化**し S2 を close。横断閲覧はダッシュボードの中核価値そのもので、自己所有端末＋私設網の脅威モデルでは十分。書き込みは既に token 由来 device_id で束縛済み                      |
| hub の待受         | **既定 `0.0.0.0`**（config `bind:` で上書き可、`127.0.0.1` に戻せる）。※`0.0.0.0` は Tailscale 含む全インターフェースを含むため追加バインドは不要。**LAN/Tailscale の IP 検出は「ペアリング時の到達先候補の表示・child への自動設定」に使う**（壁打ち回答の意図を反映） |
| 受け入れ検証       | **実2台（MacBook→Mac mini）**。フォールバック（LAN を落として Tailscale へ）も実機で検証                                                                                                                                                                                |

## 機能要件

### FR-01: child ロール（優先度: 必須）

`~/.monomi/config.yml` の `role: child` と hub 到達先の複数併記をサポートする。

- AC-1: config に `role: child` と `hub_endpoints:`（URL のリスト、例: LAN `http://192.168.x.x:47632` と Tailscale `http://100.x.x.x:47632`）を記述できる
- AC-2: child では `monomi hub` を実行するとエラーメッセージ（role が child である旨）で終了する
- AC-3: config.yml は `chmod 600` で書き込まれる（§0.3。token を含むため）

### FR-02: 6桁コードペアリング（優先度: 必須）

- AC-1: hub 側で `monomi hub pair` を実行すると、稼働中の hub API に localhost 宛でリクエストし、6桁コード（TTL 5分・メモリ保持）と**到達先候補 URL**（検出した LAN IP / Tailscale 100.x の各 `http://IP:port`）が表示される
- AC-2: `POST /api/v1/pair/start` は `socket.remoteAddress` が loopback の場合のみ受け付け、`X-Forwarded-For` は無視する（§0.3）
- AC-3: child 側で `monomi pair --code XXXXXX --hub <url> [--hub <url2>...]` を実行すると、到達できた hub でコードを照合し、発行された token と `role: child` / `hub_endpoints` / 自動生成 device_id（hostname ベース）が config.yml / token ファイルに保存される
- AC-4: `pair/claim` はコード照合失敗5回で当該コードを即無効化し、成功時は単発で破棄する（総当り無力化、§0.3）
- AC-5: TTL 切れ・無効化済みコードでの claim は「コード無効。hub 側で `monomi hub pair` を再実行」という導線付きエラーになる

### FR-03: devices 管理（優先度: 必須）

- AC-1: `monomi hub devices list` で登録デバイス一覧（id・name・role・last_seen_at・token 有効/失効）が表示される
- AC-2: `monomi hub devices revoke <device_id>` で該当デバイスの token が失効し、以後そのトークンでの書き込み・読み取りが 401 になる（失効は即時反映）

### FR-04: reporter のマルチエンドポイントフォールバック（優先度: 必須）

- AC-1: reporter は config.yml の `hub_endpoints` を上から順に試し、最初に成功した先へ POST する（§0.2）
- AC-2: **全エンドポイント全滅時のみ** outbox へ退避する（1つでも成功したら退避しない）
- AC-3: `MONOMI_HUB_URL` 環境変数指定時は従来通り最優先で単一エンドポイントとして扱う（テスト互換）

### FR-05: CLI のリモート hub 接続（優先度: 必須）

- AC-1: child マシンの `monomi`（ダッシュボード）は config の `hub_endpoints` を順に試し、到達できた hub から一覧・詳細を取得する
- AC-2: 全エンドポイント不達時は「hub に到達できない」旨と試した URL 一覧を表示して終了する（無限リトライしない。watch 中は次回ポーリングで再試行）

### FR-06: hub の外部待受（優先度: 必須）

- AC-1: hub は既定で `0.0.0.0` にバインドする。config `bind:` で `127.0.0.1` 等に上書きできる
- AC-2: 読み取り API は「任意の有効トークンで全デバイスの instance/イベントを閲覧できる」ことを仕様とし、その旨をテストで固定する（他デバイスの instance が読めることを検証する = S2 の close）
- AC-3: 無効/失効トークンは従来通り全エンドポイントで 401

### FR-07: outbox 閉塞の解消 — B1+B2（優先度: 必須）

- AC-1: reporter は HTTP 4xx（恒久エラー）を受けたイベントを `~/.monomi/outbox/rejected/` へ隔離し、キューを閉塞させない（5xx・接続エラーは従来通り再試行対象として残す）
- AC-2: bash フォールバックの `json_escape` が U+0000〜U+001F を `\uXXXX` にエスケープする（poison-pill の発生源を断つ）
- AC-3: 「先頭に恒久 4xx イベント＋後続に正常イベント」の状態から、正常イベントが配信され rejected に隔離ファイルが残ることをシェルテストで検証

### FR-08: ホットパス最適化 — P1+P2（優先度: 推奨）

- AC-1: `StateTransitionFinder` 等が SQL 済みソートを再実行しない（既ソート前提の1パス処理へ）
- AC-2: Repository が prepared statement をフィールドにキャッシュし、呼び出しごとの `prepare()` を排除する
- AC-3: 既存の status 導出テスト（正確性）が全て green のまま

### FR-09: lint 指摘の解消 — L1+L2（優先度: 推奨）

- AC-1: `AppView` の `useEffect` 依存欠落と `detail-view.tsx` の配列インデックスキーをコード側で解消する
- AC-2: `biome.jsonc` の `useExhaustiveDependencies` / `noArrayIndexKey` の warn 緩和を外し、recommended の error に戻して lint が green

## 非機能要件

- **検証環境**: 実2台（MacBook child → Mac mini hub）。ペアリング→イベント送信→ダッシュボード表示→**LAN 断で Tailscale へのフォールバック**まで実機確認
- **セキュリティ姿勢**: Bearer 必須は継続。TLS なし（Tailscale=WireGuard 経路の暗号化に依存、LAN は平文＝§0.4 の v1 方針通り）。config/token は 600
- **後方互換**: release-1 の単機構成（config 無指定・localhost）がそのまま動き続けること（既存テスト全 green）

## スコープ外（release-3 では実装しない）

- mDNS 探索/アドバタイズ（手動 URL 指定で足りる）
- フル TLS/HTTPS
- ライブネス検知（常駐ハートビート／session_lost）— 引き続き fast-follow 判断
- PR レビュー待ち（GitHub 連携）
- Windows ネイティブ／PowerShell レポーター
- known-issues の B3（session 再バインド）・S1（ファイルパーミッション）— バックログ継続。※S3（decodeURIComponent 500）は当初スコープ外としたが、release-3 の差分レビュー修正（router.ts の変更で再検出されたため）で解消済み
- 残警告22件（noNonNullAssertion 等）の方針判断

## 未解決事項（実装中に判断）

- LAN/Tailscale IP の検出方法（`ifconfig`/`en0` 列挙か、Tailscale は `tailscale ip -4` CLI があれば利用か、100.64.0.0/10 のインターフェース走査か）
- config.yml の `hub_endpoints` 記法（bash reporter が sed で読める素朴な形式にする必要がある。例: `hub_endpoints:` 配下に `- http://...` を1行ずつ）
- `monomi pair` 実行時に既存 config がある場合のマージ規則（role/hub_endpoints/device_id の上書き範囲）
- rejected 隔離ファイルの上限・掃除（無限に溜めない工夫。実データを見てからでも可）

## 次のステップ

```
Workflow({name: "implement-feature", args: {release: "release-3-multi-device-pairing"}})
```
