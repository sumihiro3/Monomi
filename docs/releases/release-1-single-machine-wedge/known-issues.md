# release-1-single-machine-wedge — 既知の課題（review-changes 由来、未修正）

`Workflow({name: "review-changes"})`（敵対的検証込み、20エージェント）で確定した15件のうち、
high/medium の3件（全履歴フルロード・outbox 排他制御なし・token の ps 露出）は release-1 で
修正済み。残る **low 12件はここに記録し、release-2 以降で対応判断する**（今回は未修正）。

## bugs

### B1. 4xx を含む全非2xx応答を再送対象扱いし、恒久エラーが outbox キュー全体を無期限に閉塞させる

- 場所: `reporter/monomi-report.sh` `post_json`/`flush_outbox`
- `post_json` は curl 失敗も HTTP 非2xx（400/401/413 等）も一律失敗扱いにし、`flush_outbox` は最初の失敗で中断する。恒久的に拒否される4xx（無効 token・不正 event_type 等）がキュー先頭に居座ると、それより新しい正常イベントが以後すべて配信されなくなる。
- 対応方針: HTTP status を見て 5xx/接続エラー（再試行対象）と 4xx（隔離・破棄対象）を区別する。4xx は `outbox/rejected/` 等へ隔離しキューを閉塞させない。
- 関連: B2（原因が同根）

### B2. reporter の bash フォールバック `json_escape` が JSON 制御文字を未エスケープで、outbox の poison-pill を招く

- 場所: `reporter/monomi-report.sh:51`
- `\`/`"`/改行/CR/タブのみエスケープし、他の制御文字（U+0000〜U+001F）を素通しする。`jq` 不在時（`MONOMI_DISABLE_JQ` 設定時含む）のみ顕在化。不正 JSON は hub 側で 400 になり、B1 の閉塞問題と組み合わさって outbox が無限に増える。
- 対応方針: `json_escape` で 0x00-0x1F を `\uXXXX` エスケープする。B1 の隔離対応とセットで直すと再発防止になる。

### B3. session の再バインド不可により、同一 session_id が別 path から報告されるとイベントが新 instance 配下から欠落する

- 場所: `src/db/repositories/session-repository.ts:57`
- `upsertStarted` は `ON CONFLICT(id) DO NOTHING` で `instance_id` を更新しない。同一 session が別 path（例: git worktree 切替）から報告されると、event は新 instance に記録されるが session 行の `instance_id` は古いまま残り、新 instance の一覧・詳細（404 相当）から欠落しうる。
- 対応方針: `EventIngestionService.ingest` で instance が変わったことを検知したら `sessions` の `instance_id` を更新する（再バインド）。release-1 は worktree 運用を主要シナリオに含めていないため low。

## perf

### P1. status 導出で SQL 済みのソートを再実行し、全イベント配列を複数回走査している

- 場所: `src/status/state-transition-finder.ts:52`
- `allForSession`（本修正では `recentPageForSession`）は既に received_at/id 順で返るのに `StateTransitionFinder.find` が再ソートする。加えて `StatusDeriver`/`RawStateResolver`/`StateTransitionFinder` が同じイベント配列を複数回フルスキャンする。
- 対応方針: 既ソート前提で再ソートを止める。3クラスの filter を1パスに統合するか、共通の「関連イベントのみ」配列を1回だけ作って渡す。

### P2. Repository が毎回 `db.prepare()` で SQL を再コンパイルする（ホットパスで反復）

- 場所: `src/db/repositories/event-repository.ts:89` ほか全 Repository
- prepared statement を再利用せず、呼び出しのたびに `prepare()` する。個人利用規模では軽微だが、P1 のホットパス最適化と合わせて対応する価値がある。
- 対応方針: `StatementSync` を Repository のフィールドにキャッシュする。

### P3. 一覧生成で instance ごとに project/device/PR を個別クエリする N+1

- 場所: `src/hub/instance-status-service.ts:142`
- `buildRow` が instance ごとに `projects.findById`/`devices.findById`/`prStatus.findByProjectBranch` を個別発行する。件数が小さいため実害は限定的。
- 対応方針: `listActive` 後に必要な project_id/device_id をまとめて1回引く、またはリクエストスコープの Map でメモ化する。

## arch

### A1. cli-ink レイヤーが hub-api の内部モジュール `hub/dto.ts` に型依存している（レイヤー境界の越境）

- 場所: `src/cli/hub-api-client.ts:4` ほか CLI 側7ファイル
- wire 型（`InstanceStatusRow`/`InstanceDetail` 等）を `hub/dto.ts` から直接 import。`import type` のみで実行時結合は無いが、class-diagram のレイヤー分離の意図としては境界が弱い。
- 対応方針: wire 契約を中立な共有モジュール（例: `src/api-contract/`）へ切り出す。

### A2. wire DTO の列挙フィールドが bare string 型でコンパイル時網羅チェックが効かない

- 場所: `src/hub/dto.ts:62`
- `StatusDto.display`/`raw_state`、`PrDto.state` 等が素の `string`。ドメイン層は branded/union 型で厳密なのに API 境界だけ緩い非対称がある。
- 対応方針: domain の `DisplayStatus`/`RawState` 由来のリテラル union を wire 型に反映する。

### A3. `serve()` 起動時に同一 `config.yml` を3回読み込んでいる（責務重複/DRY）

- 場所: `src/hub/serve.ts:83`
- `serve()`・`bootstrap()`・`thresholdsFromConfig()` がそれぞれ `loadConfig` を呼ぶ。動作上の不具合はなく効率・保守性の観点。
- 対応方針: config 読み込みを1回に集約し、`MonomiConfig` を各所へ渡す。

## security

### S1. SQLite DB と `~/.monomi` ディレクトリが既定パーミッションで作られ、機密データが他ローカルユーザーに読める

- 場所: `src/hub/serve.ts:82`、`src/db/database.ts:36`
- token ファイルのみ `0o600` 固定だが、`~/.monomi` ディレクトリと DB ファイル（`tool_summary`・全プロジェクトパス・稼働履歴・`token_hash` を含む）は絞られていない。マルチユーザーホストでは他ユーザーが読める。単一ユーザー前提の release-1 では実害小。
- 対応方針: home を `0o700` で作成、DB ファイルも `0o600` に chmod する。

### S2. 読み取りエンドポイントにデバイス単位の認可がなく、任意の有効トークンで全 instance/イベントを閲覧できる

- 場所: `src/hub/controllers/instances-controller.ts:48`
- Bearer 認証はするが、device と instance の所有関係を突き合わせる認可チェックがない。release-1 は device が hub 1台のみのため実害なし（by design）。**release-2 で child device が増える前に設計判断として対応要否を決めること。**
- 対応方針: device 単位の認可チェックを追加するか、「read-only なので全デバイス閲覧可を仕様として許容する」と明示的に決める。

### S3. `Router.match` の `decodeURIComponent` が認証前に `URIError` を投げ、不正 path で 500 を返す

- 場所: `src/hub/router.ts:121`
- 不正なパーセントエンコーディングの path（例: `/api/v1/instances/%ZZ`）で認証前に例外が発生し 500 になる（本来は 404/401 が妥当）。情報漏えいや認証バイパスには至らない。
- 対応方針: `decodeURIComponent` を try/catch し、不正 path は `not_found` 扱いにする。

## 優先度の目安（release-2 着手時の参考）

1. **B1 + B2**（同根、outbox の可用性劣化）— 直すなら同時に
2. **P1 + P2**（同じホットパス、release-2 で child device が増えるとポーリング頻度・instance 数が増し影響が拡大）
3. **S2**（release-2 の pairing 実装前に設計判断が必要）
4. 残り（A1-A3, S1, S3, B3）は保守性・堅牢性の改善として随時
