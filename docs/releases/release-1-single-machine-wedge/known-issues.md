# 既知の課題（レビュー由来のバックログ）

release-1 の `review-changes`（敵対的検証済み15件）と release-2/3 での追加検出をここで一元管理する。
解決済みの項目は下部の「解決済みログ」へ移動している。

## 未解決（バックログ）

### B3. session の再バインド不可により、同一 session_id が別 path から報告されるとイベントが新 instance 配下から欠落する

- 場所: `src/db/repositories/session-repository.ts` `upsertStarted`
- `ON CONFLICT(id) DO NOTHING` で `instance_id` を更新しない。同一 session が別 path（例: git worktree 切替）から報告されると、event は新 instance に記録されるが session 行の `instance_id` は古いまま残り、新 instance の一覧・詳細から欠落しうる。
- 対応方針: `EventIngestionService.ingest` で instance が変わったことを検知したら `sessions` の `instance_id` を更新する（再バインド）。

### P3. 一覧生成で instance ごとに project/device/PR を個別クエリする N+1

- 場所: `src/hub/instance-status-service.ts` `buildRow`
- instance ごとに `projects.findById`/`devices.findById`/`prStatus.findByProjectBranch` を個別発行。件数が小さいため実害は限定的。
- 対応方針: `listActive` 後に必要 id をまとめて1回引くか、リクエストスコープの Map でメモ化。
- 備考: release-3 で devices list 側の N+1 は解消済み（`TokenRepository` の1クエリ化）。本項は instances 側。

### A1. cli-ink レイヤーが hub-api の内部モジュール `hub/dto.ts` に型依存している（レイヤー境界の越境）

- 場所: `src/cli/hub-api-client.ts` ほか CLI 側ファイル
- wire 型を `hub/dto.ts` から直接 import。`import type` のみで実行時結合は無い。
- 対応方針: wire 契約を中立な共有モジュール（例: `src/api-contract/`）へ切り出す。

### A2. wire DTO の列挙フィールドが bare string 型でコンパイル時網羅チェックが効かない

- 場所: `src/hub/dto.ts`
- `StatusDto.display`/`raw_state`、`PrDto.state` 等が素の `string`。
- 対応方針: domain の `DisplayStatus`/`RawState` 由来のリテラル union を wire 型に反映する。

### A3. `serve()` 起動時に同一 `config.yml` を複数回読み込んでいる（責務重複/DRY）

- 場所: `src/hub/serve.ts`
- 対応方針: config 読み込みを1回に集約し、`MonomiConfig` を各所へ渡す。

### S1. SQLite DB と `~/.monomi` ディレクトリが既定パーミッションで作られ、機密データが他ローカルユーザーに読める

- 場所: `src/hub/serve.ts`、`src/db/database.ts`
- token/config は `0o600` 固定済みだが、`~/.monomi` ディレクトリと DB ファイルは絞られていない。単一ユーザー前提では実害小。
- 対応方針: home を `0o700` で作成、DB ファイルも `0o600` に chmod。

### N1. CLI ダッシュボードの Biome 残警告（noNonNullAssertion 等 22件）

- Biome recommended が warn 報告するが ESLint 時代に未強制だったルール由来のノイズ。方針判断（off にするか解消するか）は未決。

## 解決済みログ

| ID  | 内容                                                                                                                                               | 解決リリース                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| B1  | 恒久 4xx が outbox キュー全体を閉塞                                                                                                                | release-3（FR-07: `outbox/rejected/` 隔離＋上限掃除）                                             |
| B2  | bash `json_escape` の制御文字未エスケープ（poison-pill）                                                                                           | release-3（FR-07: U+0000〜U+001F を `\uXXXX` 化）                                                 |
| P1  | status 導出で SQL 済みソートの再実行・複数回走査                                                                                                   | release-3（FR-08: 既ソート前提の単一パス化）                                                      |
| P2  | Repository が毎回 `db.prepare()` で再コンパイル                                                                                                    | release-3（FR-08: prepared statement をフィールドキャッシュ）                                     |
| L1  | `AppView` の `useEffect` 依存欠落                                                                                                                  | release-3（FR-09。biome 緩和も撤去）                                                              |
| L2  | リストキーに配列インデックス使用                                                                                                                   | release-3（FR-09。biome 緩和も撤去）                                                              |
| S2  | 読み取りエンドポイントのデバイス単位認可なし                                                                                                       | release-3（FR-06 AC-2: 「任意の有効トークンで全デバイス閲覧可」を仕様として明文化・テストで固定） |
| S3  | `decodeURIComponent` が認証前に URIError → 500                                                                                                     | release-3（レビュー修正 #10: try/catch で 404 化）                                                |
| —   | 高: 一覧/詳細 API の全イベント履歴フルロード                                                                                                       | release-1 レビュー修正（keyset ページング）                                                       |
| —   | 中: outbox 再送の TOCTOU 二重送信                                                                                                                  | release-1 レビュー修正（mkdir ロック）                                                            |
| —   | 中: Bearer token の curl 引数露出（ps で可視）                                                                                                     | release-1 レビュー修正（`-K` 設定ファイル化）                                                     |
| —   | 高: devices list/revoke が任意 token で実行可能                                                                                                    | release-3 レビュー修正（loopback 限定ガード）                                                     |
| —   | 中: pair/claim の device 乗っ取り                                                                                                                  | release-3 レビュー修正（有効 token 保持 device への claim を 409 拒否）                           |
| —   | 中: `--hub` 複数指定が未実装（FR-02 AC-3 不一致）                                                                                                  | release-3 レビュー修正（配列化＋正規化）                                                          |
| —   | 低: CLI watch 中のエンドポイント再解決なし／config 由来 URL 正規化非対称／devices list N+1／run 境界判定のレイヤ越境／claim 入力長・文字種検証なし | release-3 レビュー修正（全件）                                                                    |
