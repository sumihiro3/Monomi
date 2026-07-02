# 既知の課題（レビュー由来のバックログ）

release-1 の `review-changes`（敵対的検証済み15件）と release-2/3 での追加検出をここで一元管理する。
解決済みの項目は下部の「解決済みログ」へ移動している。

## 未解決（バックログ）

### B4. 詳細ビューに reresolve が無く、一覧側のエンドポイント failover 後も死んだ接続を叩き続ける

- 場所: `src/cli/components/detail-view.tsx`
- `DetailView` は `reresolve` なしで固定 `client`（AppView マウント時の初期解決済みクライアント）を使う。一覧側 `PollingLoop` は取得失敗時に内部の `this.client` を別エンドポイント（LAN→Tailscale 等）へ差し替えるが、この差し替えは一覧ループ内部に閉じており、AppView が保持する `client` 変数自体には反映されない。よって failover 発生後に詳細ビューを開くと、死んだ初期エンドポイントを叩き続け、更新が止まったまま（直前表示は保持されるので実害は限定的）。
- 対応方針: 詳細ビューにも `reresolve` を配線するか、AppView 側で「現行の解決済み client」を共有可能な形（ref 化 等）にする。

### B5. 詳細ビュー表示中も一覧側のポーリングが止まらず、二重ポーリング + 非表示一覧の無駄な再描画が発生

- 場所: `src/cli/components/app-view.tsx`
- 一覧用 `PollingLoop` は詳細ビューに入っても停止せず、詳細ビュー自身のポーリングと合わせて interval ごとに `listInstances()`/`getInstanceDetail()` の2本が常時走る。一覧側の `onUpdate` は非表示中でも `store.setInstances()`+`bump()` を呼ぶため、隠れた一覧のための再計算・再描画が続く。件数や低速回線（Tailscale等）に比例してコストが増える継続的な無駄。
- 対応方針: 詳細ビューに入る際に一覧ループを `stop()` し、戻る際に `start()` する。または一覧側 `onUpdate` を `viewMode==='list'` のときだけ反映する。

### P4. `AppView` が毎レンダー `store.filtered()` を2回計算し、集計系もメモ化なしで無条件に再計算される

- 場所: `src/cli/components/app-view.tsx`
- `filteredRows = store.filtered()` と `projectRows()`（内部で再度 `filtered()` を呼ぶ）で2重計算。`countByDisplay`/`deviceCount`/`rollupByProject` も毎レンダー無条件に全件走査する。`useInput` は無効キー入力でも毎回 `bump()` して強制再レンダーする。`useMemo`/`React.memo` は一切未使用。
- 対応方針: `filtered()` の結果をレンダー内で使い回す、集計を `useMemo` 化、`bump()` はアクションが実際に状態変更したときだけに絞る。

### A4. `InstanceTable` が presentational 規約を逸脱し、命名が実体（カードグリッド）と不一致

- 場所: `src/cli/components/instance-table.tsx`
- class-diagram.md は `InstanceTable` を「presentational（描画のみ）」と定義しているが、実装は `useStdout()` と列数・幅の計算（レイアウトロジック）を保持しており、コード自身のコメントも「container 兼 presentational」と認めている。加えて描画実体はテーブルではなくカードグリッドになったため、名前が実体と不一致（misnomer）。
- 対応方針: `InstanceCardGrid` 等への改名、またはレイアウト計算を `card-grid.ts` 側へさらに寄せて presentational 純度を高める。呼び出し側（`app-view.tsx`）の import 変更を伴うため、まとまった作業として別途行う。

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

### I1. UI 文言・エラーメッセージが日本語ハードコードで国際化（i18n）未対応

- 場所: `src/cli/status-display.ts`（状態ラベル: 稼働中/権限待ち/次の指示待ち/放置/PRレビュー待ち）、`src/cli/components/*.tsx`（フィルタバー・ヘルプ・テーブル/カードの見出し）、`src/cli.ts`（USAGE・サブコマンドのログ/エラーメッセージ）、hub 側のエラーメッセージの一部
- `monomi-handoff.md` §2 に「OSS公開、将来的に商用化も視野」とある通り、非日本語話者のユーザーも想定される。現状は文言が日本語決め打ちで、英語等への切替手段が無い
- 対応方針: 表示文言をキー化し、ロケール別の文言テーブル（例: `src/i18n/ja.ts` / `src/i18n/en.ts`）へ切り出す。ロケール選択は `config.yml` の `locale:` または `LANG` 環境変数から解決。まずは日本語・英語の2ロケールで足りる。status-display.ts の状態ラベルが最優先（最も露出面が広い）

## 解決済みログ

| ID  | 内容                                                                                                                                               | 解決リリース                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| B1  | 恒久 4xx が outbox キュー全体を閉塞                                                                                                                | release-3（FR-07: `outbox/rejected/` 隔離＋上限掃除）                                              |
| B2  | bash `json_escape` の制御文字未エスケープ（poison-pill）                                                                                           | release-3（FR-07: U+0000〜U+001F を `\uXXXX` 化）                                                  |
| P1  | status 導出で SQL 済みソートの再実行・複数回走査                                                                                                   | release-3（FR-08: 既ソート前提の単一パス化）                                                       |
| P2  | Repository が毎回 `db.prepare()` で再コンパイル                                                                                                    | release-3（FR-08: prepared statement をフィールドキャッシュ）                                      |
| L1  | `AppView` の `useEffect` 依存欠落                                                                                                                  | release-3（FR-09。biome 緩和も撤去）                                                               |
| L2  | リストキーに配列インデックス使用                                                                                                                   | release-3（FR-09。biome 緩和も撤去）                                                               |
| S2  | 読み取りエンドポイントのデバイス単位認可なし                                                                                                       | release-3（FR-06 AC-2: 「任意の有効トークンで全デバイス閲覧可」を仕様として明文化・テストで固定）  |
| S3  | `decodeURIComponent` が認証前に URIError → 500                                                                                                     | release-3（レビュー修正 #10: try/catch で 404 化）                                                 |
| —   | 高: 一覧/詳細 API の全イベント履歴フルロード                                                                                                       | release-1 レビュー修正（keyset ページング）                                                        |
| —   | 中: outbox 再送の TOCTOU 二重送信                                                                                                                  | release-1 レビュー修正（mkdir ロック）                                                             |
| —   | 中: Bearer token の curl 引数露出（ps で可視）                                                                                                     | release-1 レビュー修正（`-K` 設定ファイル化）                                                      |
| —   | 高: devices list/revoke が任意 token で実行可能                                                                                                    | release-3 レビュー修正（loopback 限定ガード）                                                      |
| —   | 中: pair/claim の device 乗っ取り                                                                                                                  | release-3 レビュー修正（有効 token 保持 device への claim を 409 拒否）                            |
| —   | 中: `--hub` 複数指定が未実装（FR-02 AC-3 不一致）                                                                                                  | release-3 レビュー修正（配列化＋正規化）                                                           |
| —   | 低: CLI watch 中のエンドポイント再解決なし／config 由来 URL 正規化非対称／devices list N+1／run 境界判定のレイヤ越境／claim 入力長・文字種検証なし | release-3 レビュー修正（全件）                                                                     |
| —   | 中: 非TTY環境（`stdout.columns` 未取得）でカードグリッドが1列フォールバックできず横並びしてしまう（FR-02 AC-4 違反）                               | release-4 レビュー修正（`flexDirection="column"` で構造的に保証、実非TTYを再現する回帰テスト追加） |
| —   | 低: 新規CLIファイルの `import { type X }` が biome `useImportType` 警告                                                                            | release-4 レビュー修正（`import type` へ統一）                                                     |
