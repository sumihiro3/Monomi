# 既知の課題（レビュー由来のバックログ）

release-1 の `review-changes`（敵対的検証済み15件）と release-2/3 での追加検出をここで一元管理する。
解決済みの項目は下部の「解決済みログ」へ移動している。

## 未解決（バックログ）

### U5. プロジェクトの状態が変わったら通知を出したい（例:「Monomi」が次の指示待ちになりました）

- 場所: 該当なし（未実装機能）。関連: `src/status/status-deriver.ts`（status導出）、`src/cli/components/app-view.tsx`（ポーリング更新の受け口）
- instance の `status.display` が変化した瞬間に OS 通知（macOS なら `osascript`/`terminal-notifier` 等）を出したい（ユーザー要望）。変化検知を CLI 側のポーリング差分（前回取得値との比較）で行うか、hub 側に購読/webhook 機構を設けるかは設計判断が必要。対応方針は未検討、要壁打ち。

### U7. PR 状態が常に `none` のまま変わらない（GitHub poller が未実装）

- 場所: `src/hub/instance-status-service.ts:47`（`const HAS_PR_WAITING = false` のハードコード）、`src/db/repositories/pr-status-repository.ts`（`upsert()` は定義されているが本番コードから一度も呼ばれていない）
- PR レビュー待ちはフックでは拾えないため別系統（GitHub poller）で `pr_status` テーブルへ書き込む設計だが、release-1 の時点でこの poller 自体がスコープ外（fast-follow 扱い）とされ、release-7 時点でも未着手のまま。結果として `pr_status` に行が一切増えず、instance 詳細の PR 欄は常に `none` になる。`ARCHITECTURE.md` の「現状スコープ外／未実装」リストには記載済みだが、known-issues.md には項目化されていなかった。
- 実例: 2026-07-03、Monomi 自身のリポジトリで `docs-release-branch-workflow-policy` ブランチの PR #1 をマージしても、Monomi のダッシュボード上で PR 状態（マージ済み等）が反映されない（`pr: none` のまま）ことをユーザーが確認。
- 対応方針: GitHub API（`gh api` または REST/GraphQL）で対象 branch の PR 状態を定期取得し `PrStatusRepository.upsert()` へ書き込む poller を新規実装する。ポーリング間隔・認証（`gh` CLI の既存ログインを使うか token を config に持たせるか）は要壁打ち。

### D1. インストール／アンインストールの一気通貫ガイドが無い

- 場所: 該当なし（新規ドキュメント）。関連: `README.md`、`ARCHITECTURE.md` §3.1（install-hooks）・§2.3（pm2常駐）・§9（ペアリング）
- セットアップ手順（`monomi install-hooks`、pm2常駐化 `pm2 startup && pm2 save`、ペアリング）やアンインストール手順（`monomi uninstall-hooks`、pm2プロセス停止、`~/.monomi` 削除等）が各ドキュメントに散在しており、導入から日常運用・撤去までを一気通貫でまとめたガイドが無い（ユーザー要望）。対応方針は未検討（例: `docs/installation.md` 新設）。要壁打ち。

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

### N1. CLI ダッシュボードの Biome 残警告（noNonNullAssertion 等 22件）

- Biome recommended が warn 報告するが ESLint 時代に未強制だったルール由来のノイズ。方針判断（off にするか解消するか）は未決。

### S4. ensureMonomiHome の mkdir-then-chmod に微小な TOCTOU 窓がある

- severity: low（review:security 由来、起票日: 2026-07-06）
- 場所: src/config/paths.ts:73
- 現象: `ensureMonomiHome` が `mkdirSync` を mode 引数なしで呼び出した後に `chmodSync(0o700)` を実行しているため、ディレクトリが初回作成される瞬間に umask 既定のパーミッション（通常 0o755）で一瞬だけ存在する TOCTOU 窓がある。この窓は実質的にナノ秒〜マイクロ秒オーダーであり、ディレクトリ作成直後は中身が空のため実害は極めて限定的。
- 対応方針: `mkdirSync` の第2引数にも `mode: 0o700` を渡しておけば umask 由来の最悪ケースでも 0o755 にならず 0o700 から開始できる（umask がそれ以上に制限する分には問題ない）。既存の `chmodSync` は既存ディレクトリの修復用として引き続き必要。

### S5. Gate2 再レビューのスコープファイル一覧が LLM 経由のため部分的な欠落があり得る

- severity: low（review:security 由来、起票日: 2026-07-06）
- 場所: .claude/workflows/run-release.js
- 現象: release-14 のレビューで検出。Gate2 の再レビュースコープ（`reReviewScope`）は haiku エージェントが `git diff --name-only` / `git ls-files` の出力を返す自由形式タスクで算出され、空配列のときのみ全差分へフォールバックする。エージェントが一覧を不完全に返した場合（一部ファイルの欠落）、部分リストがそのまま採用され、欠落ファイルは次イテレーションの全次元レビュー（security 含む）のスコープ外になる。Gate2 以降に全差分レビューは走らないため、見逃しはそのまま PR 作成まで到達し得る。Workflow スクリプトは fs/exec 不可で決定的なファイル列挙手段がなく、完全な対策には構造的工夫が要る。
- 対応方針: (a) フォールバック条件を「期待ファイル数との大幅乖離」にも拡張する、(b) security 次元のみ常に全差分でレビューする、(c) スコープ一覧を fix エージェントの変更報告と突合して欠落を検知する、のいずれか（または組み合わせ）を検討する。

### P8. ACTIVE インスタンスごとに代表セッションのイベントを二重読みしている

- severity: low（review:perf 由来、起票日: 2026-07-07）
- 場所: src/hub/instance-status-service.ts:188
- 現象: `buildRow` 内で、代表セッションのイベントは `loadEventsForCurrentRun`（L151）で既に DB から読み込まれ status 導出に使用された後に破棄される。その直後、代表が ACTIVE の場合に `loadRunningWorkForCurrentRun`（L188）が同じセッションに対して再度 `recentPageForSession` を発行し、概ね同じイベント群を DB から再読み込みする。コメントが説明するとおり `permission_prompt` 境界が raw_state 境界と running-work 境界で異なるため単純な再利用はできないが、一般的なケース（`permission_prompt` が稼働区間内にない場合）では `loadEventsForCurrentRun` が返した既読イベントを先に `scanForRunningWork` へ渡し、Workflow 確定または running-work 境界検出で打ち切れば追加の DB クエリは不要になる。ポーリング間隔 ~2s に対して1クエリ ~1ms のため現状の実害は軽微だが、インスタンス数が増えるとポーリング1サイクルあたりの累積遅延が線形に伸びる N+1 隣接パターン。
- 対応方針: `loadEventsForCurrentRun` が返した既読イベントを先に `scanForRunningWork` へ渡し、Workflow 確定または running-work 境界検出で打ち切れば追加の DB クエリを回避できる。`permission_prompt` 境界で既読イベントが不足する場合にのみ `loadRunningWorkForCurrentRun` の DB ページングにフォールバックする二段構成にする。
- 追記(2026-07-07, severity: low, review:arch 由来): ARCHITECTURE.md §8.4 の更新は「非 ACTIVE の instance では追加のイベント読み取りが発生しない」「P3 を悪化させない」と記述するが、ACTIVE な instance では追加読み取りが発生する事実を十分に記述していない。区切り集合が異なるため `loadEventsForCurrentRun` の結果をそのまま再利用できないケースがある（`permission_prompt` を跨ぐ走査が必要）のは理解できるが、最初のロード結果をキャッシュして渡し、不足分のみ追加ページングする最適化の余地がある。

### A6. dto.ts が status レイヤーの RunningWork 型を直接 wire DTO として露出（DTO 変換ステップの省略）

- severity: low（review:arch 由来、起票日: 2026-07-07）
- 場所: src/hub/dto.ts:4
- 現象: 既存パターンでは status レイヤーの `StatusResult` を hub レイヤーの `StatusDto` に変換する `toStatusDto()` ステップがある（instance-status-service.ts L309）。一方 `RunningWork` は status レイヤーで定義した型を `dto.ts` で import し、変換なしに wire DTO（`InstanceStatusRow.running_work`）にそのまま使っている。ARCHITECTURE.md の更新でこれを「`StatusDto`/`StatusResult` の関係と同様に hub->status の既存の依存方向を保つため」の明示的例外と文書化しているが、`StatusDto`/`StatusResult` の関係は型を分離し変換ステップを持つ点で実は逆のパターンである。現在は `RunningWork` の kind が既に小文字（`workflow`/`agent`/`skill`）で wire 互換なため実害はないが、将来 kind の追加や wire 表現の変更時に、ドメイン型と wire 型が直結していることで変更影響が拡大する。
- 対応方針: `RunningWorkDto` を dto.ts に定義し薄い変換を挟むか、少なくとも ARCHITECTURE.md の正当化根拠を「StatusDto/StatusResult と同様」ではなく「変換不要なため省略」へ修正する。

### S6. running_work.kind の未知値フォールバックが sanitizeDisplayText を経由せず端末に描画される (CWE-150)

- severity: low（review:security 由来、起票日: 2026-07-07）
- 場所: src/cli/components/detail-view.tsx:487
- 現象: `runningWorkKindLabel()` は `RUNNING_WORK_KIND_KEYS` に一致しない未知の `kind` 値をそのまま返す（`return key ? t(key) : kind`）。`formatRunningWork()` はこの戻り値を `sanitizeDisplayText()` を通さずに表示文字列へ埋め込む（505行目: `(${runningWorkKindLabel(work.kind)})`）。コメント自身が明言するとおり hub と CLI は別プロセス・別バージョンで動きうるため、将来 hub が未知の `kind` を返す、あるいは hub とのネットワーク通信が改竄された場合に、ANSI エスケープシーケンスや制御文字を含む文字列がそのまま端末へ書き出される。同じファイル内で `running_work.name` にはサニタイズが適用されているのに `kind` のフォールバックだけ抜けている。
- 対応方針: フォールバックパスを `sanitizeDisplayText(kind)` に変更する。

## 解決済みログ

| ID  | 内容                                                                                                                                               | 解決リリース                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 恒久 4xx が outbox キュー全体を閉塞                                                                                                                | release-3（FR-07: `outbox/rejected/` 隔離＋上限掃除）                                                                                                                                                                                                                                                                                                                                                    |
| B2  | bash `json_escape` の制御文字未エスケープ（poison-pill）                                                                                           | release-3（FR-07: U+0000〜U+001F を `\uXXXX` 化）                                                                                                                                                                                                                                                                                                                                                        |
| P1  | status 導出で SQL 済みソートの再実行・複数回走査                                                                                                   | release-3（FR-08: 既ソート前提の単一パス化）                                                                                                                                                                                                                                                                                                                                                             |
| P2  | Repository が毎回 `db.prepare()` で再コンパイル                                                                                                    | release-3（FR-08: prepared statement をフィールドキャッシュ）                                                                                                                                                                                                                                                                                                                                            |
| L1  | `AppView` の `useEffect` 依存欠落                                                                                                                  | release-3（FR-09。biome 緩和も撤去）                                                                                                                                                                                                                                                                                                                                                                     |
| L2  | リストキーに配列インデックス使用                                                                                                                   | release-3（FR-09。biome 緩和も撤去）                                                                                                                                                                                                                                                                                                                                                                     |
| S2  | 読み取りエンドポイントのデバイス単位認可なし                                                                                                       | release-3（FR-06 AC-2: 「任意の有効トークンで全デバイス閲覧可」を仕様として明文化・テストで固定）                                                                                                                                                                                                                                                                                                        |
| S3  | `decodeURIComponent` が認証前に URIError → 500                                                                                                     | release-3（レビュー修正 #10: try/catch で 404 化）                                                                                                                                                                                                                                                                                                                                                       |
| B7  | 異常終了で `SessionEnd` を受け取れなかった孤立セッションが、稼働中セッションの表示を覆い隠す（OSSRadar実例）                                       | release-7（FR-01: instance内の最新イベントから15分以上古いsessionをrollup対象から除外）                                                                                                                                                                                                                                                                                                                  |
| B6  | セッション終了（正常終了含む）後も instance が一覧に残り続け、消す手段が無い                                                                       | release-8（FR-01: `filtered()` がフィルタ未選択時に `closed` を既定除外、`6` キーでトグル表示可能）                                                                                                                                                                                                                                                                                                      |
| B8  | セッション再開時、より優先度の高い古い session に覆い隠され instance が「稼働中」にならない                                                        | release-8（FR-02: `InstanceStatusRollup` を完全recency優先化、`STALE_SESSION_THRESHOLD_MS` 削除。加えてreview-changesで、recency優先化がイベント0件の縮退sessionの `lastEventAt=now` フォールバックと組み合わさり closed/生きているsessionを覆い隠す新規回帰2件を検出・修正）                                                                                                                            |
| I1  | UI 文言・エラーメッセージが日本語ハードコードで国際化（i18n）未対応                                                                                | release-9（`src/i18n/`（en.ts を基準に ja.ts を `satisfies` で網羅性チェック）へキー化。CLI 表示層のみが対象（hub 側等に実行時の日本語文字列は無いと確認済み）。既定表示言語が日本語→英語に変わる仕様変更を伴う。加えてreview-changesで、`--help`/`--version` が locale と無関係な config.yml の不正値に巻き込まれて失敗する回帰を検出・修正）                                                           |
| —   | 高: 一覧/詳細 API の全イベント履歴フルロード                                                                                                       | release-1 レビュー修正（keyset ページング）                                                                                                                                                                                                                                                                                                                                                              |
| —   | 中: outbox 再送の TOCTOU 二重送信                                                                                                                  | release-1 レビュー修正（mkdir ロック）                                                                                                                                                                                                                                                                                                                                                                   |
| —   | 中: Bearer token の curl 引数露出（ps で可視）                                                                                                     | release-1 レビュー修正（`-K` 設定ファイル化）                                                                                                                                                                                                                                                                                                                                                            |
| —   | 高: devices list/revoke が任意 token で実行可能                                                                                                    | release-3 レビュー修正（loopback 限定ガード）                                                                                                                                                                                                                                                                                                                                                            |
| —   | 中: pair/claim の device 乗っ取り                                                                                                                  | release-3 レビュー修正（有効 token 保持 device への claim を 409 拒否）                                                                                                                                                                                                                                                                                                                                  |
| —   | 中: `--hub` 複数指定が未実装（FR-02 AC-3 不一致）                                                                                                  | release-3 レビュー修正（配列化＋正規化）                                                                                                                                                                                                                                                                                                                                                                 |
| —   | 低: CLI watch 中のエンドポイント再解決なし／config 由来 URL 正規化非対称／devices list N+1／run 境界判定のレイヤ越境／claim 入力長・文字種検証なし | release-3 レビュー修正（全件）                                                                                                                                                                                                                                                                                                                                                                           |
| —   | 中: 非TTY環境（`stdout.columns` 未取得）でカードグリッドが1列フォールバックできず横並びしてしまう（FR-02 AC-4 違反）                               | release-4 レビュー修正（`flexDirection="column"` で構造的に保証、実非TTYを再現する回帰テスト追加）                                                                                                                                                                                                                                                                                                       |
| —   | 低: 新規CLIファイルの `import { type X }` が biome `useImportType` 警告                                                                            | release-4 レビュー修正（`import type` へ統一）                                                                                                                                                                                                                                                                                                                                                           |
| —   | 中: `instance-card.tsx`（`device.name`・`branch`）・`detail-view.tsx`（`device.name`）が未サニタイズで端末エスケープ注入（CWE-150）を許す          | release-10 レビュー修正（`sanitize-display-text.ts` を適用。`detail-view.tsx` の `branch` は release-6 で対応済みだったが `device.name` が漏れており、`instance-card.tsx` は両方とも未対応だった）                                                                                                                                                                                                       |
| U1  | ヘッダータイトルが「Claude Code Status」のままで、目立たない                                                                                       | release-10（FR-01: 「Monomi」へ変更し `backgroundColor="blue"` + `bold` でバッジ化）                                                                                                                                                                                                                                                                                                                     |
| U2  | 「● watching」インジケータが点滅しない                                                                                                             | release-10（FR-02: 点滅ロジックを専用コンポーネント `WatchingIndicator` に分離し1000ms間隔で点滅化（実機確認でのユーザーフィードバックにより当初の500msから倍へ変更）。P4「無条件再レンダー」を悪化させないことを負のコントロールテストで確認済み。FR-03で表示文言も `WATCHING` へ大文字化・i18nキー化）                                                                                                 |
| U3  | ダッシュボードで選択中カードの強調が `borderColor` のみで弱い                                                                                      | release-10（FR-04: `borderStyle="double"` + `borderColor="cyan"` へ変更。実機確認でのユーザーフィードバックにより当初の `borderStyle="bold"` から二重線へ変更）                                                                                                                                                                                                                                          |
| U4  | フィルタリング（`[1]稼働中` 等）とカードグリッドの連動が分かりにくい                                                                               | release-10（FR-05: 有効フィルタのバッジを `inverse` 反転から `backgroundColor` 強調へ変更。壁打ちの結果、「非該当カードの完全グレーアウト」は `filtered()` の除外方式・release-8 の closed 既定非表示との再設計を要する大きめの変更と判明したため見送り、視覚的連動の強化のみで対応）                                                                                                                    |
| A5  | implement-feature の設計フェーズが StructuredOutput のペイロード切断でジャンク設計を確定し得る                                                     | release-12（FR-14: 設計出力のサニティ検査＋不合格時の再設計1回・再度不合格なら明示エラーで停止するガードを実装。ペイロード切断そのものへの構造対応は次リリース以降の検討課題として残す）                                                                                                                                                                                                                 |
| S1  | SQLite DB と `~/.monomi` ディレクトリが既定パーミッションで作られ、機密データが他ローカルユーザーに読める                                          | release-13（FR-01/FR-02: home を 0o700、DB ファイルを 0o600 に固定）                                                                                                                                                                                                                                                                                                                                     |
| P5  | run-release の Gate2 再レビューが修正の増分に関係なく全差分×全次元を再実行する                                                                     | release-14（FR-01・FR-02: review-changes に diffPathScope 実装＋Gate2 再レビューのスコープ縮小）                                                                                                                                                                                                                                                                                                         |
| P6  | 実装エージェントが整形を自走せず、md 整形漏れで Gate1 修正ループが定型発火する                                                                     | release-14（FR-03: 実装エージェントの format/lint 自走）                                                                                                                                                                                                                                                                                                                                                 |
| P7  | sync-docs が差分に無関係な文書にも全文整合パスを実行する                                                                                           | release-14（FR-04: sync-docs 関連性トリアージ）                                                                                                                                                                                                                                                                                                                                                          |
| N2  | run-release の meta.phases にエージェントが割り当てられない空フェーズが表示される                                                                  | release-14（FR-05: meta.phases 空フェーズ整理）                                                                                                                                                                                                                                                                                                                                                          |
| U6  | `Workflow`/`Agent` ツール呼び出しのイベントで、どのワークフロー/エージェントが実行中か分からない                                                   | release-16（FR-01: reporter `extract_tool_summary()` が `Workflow`/`Task`(Agent)/`Skill` の表示名を抽出。FR-02: hub `RunningWorkResolver` が代表 session の `raw_state=active` のときのみ専用境界（`Stop`/`Notification(idle_prompt)`/`SessionEnd`/`UserPromptSubmit`）でスキャンし `running_work` を一覧・詳細 API に追加（DB スキーマ変更なし）。FR-03: CLI 一覧カード・詳細ビューに `▶ <name>` 表示） |
