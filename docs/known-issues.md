# 既知の課題（レビュー由来のバックログ）

release-1 の `review-changes`（敵対的検証済み15件）と release-2/3 での追加検出をここで一元管理する。
解決済みの項目は下部の「解決済みログ」へ移動している。

## 未解決（バックログ）

### B11. ダッシュボードが約65時間の連続稼働で OOM（JavaScript heap out of memory）によりクラッシュした（stdout バックプレッシャー仮説、対策実施済み・仮説は未確証）

- severity: high（起票日: 2026-07-13、release-20-dashboard-heap-guard の調査で判明）
- 場所: `node dist/cli.js`（ダッシュボード / Ink TUI プロセス。`hub` 常駐デーモンとは別プロセス）。関連: `src/cli/memory-watchdog.ts`（新規、稼働監視ログ）、`src/cli/components/app-view.tsx`・`src/cli/components/watching-indicator.tsx`（バックプレッシャー時の再描画間引き）
- 現象（原因分析）: ダッシュボードを約65時間起動したまま放置したところ、V8 の `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory` でクラッシュした。クラッシュ直前の GC ログは Mark-Compact で 4094.6MB→4091.4MB とほぼ回収できておらず（回収率0.1%未満）、GC で解放できないオブジェクトが保持され続ける「真性リーク」のシグネチャと判断した。3並行調査エージェントによる探索と主要ファイルの直接確認では、CLI 側の配列無限増殖・`fs.watch` 等の未解放リソース・Ink `<Static>`（追記専用でスクロールバックに永続する既知の落とし穴）の使用は見つからなかった。`monomi`（bin）は `dist/bin.js`→`dist/cli.js` の単一ディスパッチャでダッシュボードと `hub` サブコマンドの両方を扱うが、クラッシュ表示に `hub` 引数が付いておらずユーザー自身も「ダッシュボードを起動し放し」と説明していることから、クラッシュしたのはダッシュボード（Ink TUI）プロセスである可能性が高い（プロセス切り分け）。hub 側の既知課題 P8（`loadRunningWorkForCurrentRun` の無制限遡り読み）は実在するが、対象プロセスが hub でありダッシュボード側のヒープ増大の説明にはならないため除外した。最有力仮説は **stdout 書き込みバックプレッシャー未処理**: `watching-indicator.tsx` の1Hz点滅・一覧 `PollingLoop` の既定間隔ごとの再取得・任意のキー入力のいずれもが `bump()` を呼び Ink がほぼ絶え間なく `stdout.write()` するが、Ink パッケージには `stream.write()` の戻り値チェックや `'drain'` イベント待ちが一切無く（`node_modules/ink` を grep して確認済み）、ターミナル側が読み出しを止める状況（バックグラウンドのターミナルアプリ・固まった SSH セッション・detach された tmux 等）で未消費バイト列が Node の Writable ストリーム内部バッファ（ヒープ上）に溜まり続ける。これは GC ログの「ほぼ回収できない」挙動、および「65時間という長丁場でようやく顕在化する」時間スケールの双方と整合する。ただし heap snapshot 等の直接証拠は無く、上記はあくまで最有力仮説であり100%の確証ではない。
- 対策（release-20-dashboard-heap-guard で実施済み）: FR-01 で `MemoryWatchdog`（`src/cli/memory-watchdog.ts`）を新設し、ダッシュボード起動経路から60秒間隔で `process.memoryUsage()`/`stdout.writableLength` を `~/.monomi/cli.log` へ1行1サンプルで記録（`writableLength` が64KB超過を3回連続検出したら区別可能な WARN 行。プロセスは終了させない）。FR-02 で純粋関数 `isStdoutBackpressured()` を新設し、`app-view.tsx`（一覧ポーリング更新時の `bump()`）・`watching-indicator.tsx`（1秒点滅の `setVisible`）の双方に配線、バックプレッシャー中は再描画トリガーをスキップ（`store.setInstances()` 等のデータ更新自体は継続）することで stdout への書き込み量そのものを間引いた。
- 残存不確実性: stdout バックプレッシャー仮説は状況証拠（GC ログの回収率・時間スケールの整合・Ink の `drain` 未処理）からの推定であり、heap snapshot 等の直接証拠は無い。FR-01 AC-7（`~/.monomi/cli.log` を実運用で1週間程度観測し `heapUsed`/`writableLength` の推移が横ばいであることを確認する手動検証）が未実施のまま残っており、これが完了するまで仮説は最終確証されない。
- 対応方針: FR-01 AC-7 の実運用ログ確認を継続する。`~/.monomi/cli.log` で `heapUsed` の右肩上がり傾向や WARN 行の頻発が観測された場合は本項を再オープンし、閾値（`writableLength` 64KB・サンプリング間隔60秒・連続超過3回等はいずれも初期値）の再調整や追加対策（バックプレッシャー中の `PollingLoop` 間隔自体の延伸等）を検討する。再発時は `~/.monomi/cli.log` を第一の調査起点とする。

### U5. プロジェクトの状態が変わったら通知を出したい（例:「Monomi」が次の指示待ちになりました）

- 場所: 該当なし（未実装機能）。関連: `src/status/status-deriver.ts`（status導出）、`src/cli/components/app-view.tsx`（ポーリング更新の受け口）
- instance の `status.display` が変化した瞬間に OS 通知（macOS なら `osascript`/`terminal-notifier` 等）を出したい（ユーザー要望）。変化検知を CLI 側のポーリング差分（前回取得値との比較）で行うか、hub 側に購読/webhook 機構を設けるかは設計判断が必要。対応方針は未検討、要壁打ち。

### U7. PR 状態が常に `none` のまま変わらない（GitHub poller が未実装）

- 場所: `src/hub/instance-status-service.ts:47`（`const HAS_PR_WAITING = false` のハードコード）、`src/db/repositories/pr-status-repository.ts`（`upsert()` は定義されているが本番コードから一度も呼ばれていない）
- PR レビュー待ちはフックでは拾えないため別系統（GitHub poller）で `pr_status` テーブルへ書き込む設計だが、release-1 の時点でこの poller 自体がスコープ外（fast-follow 扱い）とされ、release-7 時点でも未着手のまま。結果として `pr_status` に行が一切増えず、instance 詳細の PR 欄は常に `none` になる。`ARCHITECTURE.md` の「現状スコープ外／未実装」リストには記載済みだが、known-issues.md には項目化されていなかった。
- 実例: 2026-07-03、Monomi 自身のリポジトリで `docs-release-branch-workflow-policy` ブランチの PR #1 をマージしても、Monomi のダッシュボード上で PR 状態（マージ済み等）が反映されない（`pr: none` のまま）ことをユーザーが確認。
- 対応方針: GitHub API（`gh api` または REST/GraphQL）で対象 branch の PR 状態を定期取得し `PrStatusRepository.upsert()` へ書き込む poller を新規実装する。ポーリング間隔・認証（`gh` CLI の既存ログインを使うか token を config に持たせるか）は要壁打ち。

### B4. 詳細ビューに reresolve が無く、一覧側のエンドポイント failover 後も死んだ接続を叩き続ける

- 場所: `src/cli/components/detail-view.tsx`
- `DetailView` は `reresolve` なしで固定 `client`（AppView マウント時の初期解決済みクライアント）を使う。一覧側 `PollingLoop` は取得失敗時に内部の `this.client` を別エンドポイント（LAN→Tailscale 等）へ差し替えるが、この差し替えは一覧ループ内部に閉じており、AppView が保持する `client` 変数自体には反映されない。よって failover 発生後に詳細ビューを開くと、死んだ初期エンドポイントを叩き続け、更新が止まったまま（直前表示は保持されるので実害は限定的）。
- 対応方針: 詳細ビューにも `reresolve` を配線するか、AppView 側で「現行の解決済み client」を共有可能な形（ref 化 等）にする。

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
- 追記(2026-07-08, severity: low→対応中に悪化を確認, release-18 FR-04 由来): FR-04（U8 修正）は Workflow 候補の消灯境界を `SessionEnd` のみに狭めたため、`loadRunningWorkForCurrentRun()` は `SessionEnd` を送らずに長時間 ACTIVE のまま稼働し続けるセッション（バックグラウンド Workflow 実行中はこれが通常のパターン）で、ポーリングのたびにセッション開始付近まで遡る＝履歴長に比例したイベント読み込みを行うようになった。従来の「1クエリ ~1ms の軽微な二重読み」から「履歴長 O(n) の読み取り」への悪化であり、上記の対応方針（`loadEventsForCurrentRun` の既読イベント再利用）の効果も限定的になる（Workflow 確定が `SessionEnd` まで届かない限り打ち切れないため）。「Workflow 名を稼働中ずっと表示し続ける」という機能要件と「P8 を悪化させない」という NFR が両立しないため、release-18 ではこのコスト増を意図的に受容する（`docs/ARCHITECTURE.md` §8.4 に同旨を記載）。将来、フック側に Workflow 完了通知イベントが追加されれば `SessionEnd` を待たずに打ち切れるようになり解消される可能性があるが、現行フックにはそのシグナルが無い（対応方針は本項に残す）。
- 追記(2026-07-08, severity: low, review:perf 由来): 別の性能レビューでも同事象を検出（`src/hub/instance-status-service.ts:288`）。release-18 FR-04 で Workflow 候補の消灯境界を `SessionEnd` のみに狭めた結果、`loadRunningWorkForCurrentRun()` のポーリング毎の DB 読取量が、従来の bounded（概ね1ページ・200件以内で打ち切り）から履歴長に比例した unbounded な走査へ質的に悪化している点を追加確認。ACTIVE インスタンスが複数あれば読み取り量は線形に加算される。根本対策はフック側に Workflow 完了通知イベントが追加されるまで待つ、という既存の対応方針に変更なし。
- 追記(2026-07-08, severity: low, review:perf 由来): さらに別の性能レビューでも同事象を検出（`src/hub/instance-status-service.ts:189`）。`loadRunningWorkForCurrentRun()` が `SessionEnd` を送らず長時間 ACTIVE のまま稼働するセッション（バックグラウンド Workflow 実行中の通常パターン）で、ポーリング（~2秒間隔）のたびにセッション開始付近まで全ページを遡る＝履歴長 O(n) × ACTIVE インスタンス数の DB 読み取りが発生することを確認。トリアージ時に本項（P8）と重複排除済み。
- 追記(2026-07-13, release-20-dashboard-heap-guard 由来、スコープ外注記): ダッシュボード（Ink TUI）プロセスの OOM クラッシュ調査（B11 参照）の際に P8 が再検討対象として挙がったが、P8 の対象プロセスは hub（常駐デーモン）であり、クラッシュしたダッシュボードプロセスとは別プロセスであるため、本リリースのスコープには含めない。上記の現象・対応方針は変更せずバックログに残す。

### S7. publish.yml のサードパーティ Actions が可変メジャータグで固定されている

- severity: low（review:security 由来、起票日: 2026-07-07）
- 場所: .github/workflows/publish.yml:15
- 現象: actions/checkout@v7, pnpm/action-setup@v6, actions/setup-node@v6 がメジャータグ（可変参照）で固定されている。このワークフローは NPM_TOKEN（npm 公開レジストリへの publish 権限を持つ credential）を扱うため、上流 Action リポジトリが侵害された場合にタグが書き換えられトークンが窃取されるサプライチェーンリスクがある。個人 private リポジトリであるため実害リスクは限定的だが、NPM_TOKEN を扱う publish ワークフローは特に hardening 対象として推奨される。
- 対応方針: GitHub の推奨に従い、各 Action を完全な commit SHA で固定する（例: actions/checkout@<sha>）ことで、上流の変更が自動的に反映されることを防げる。

### S8. ci.yml のサードパーティ Actions も同様に可変メジャータグで固定

- severity: low（review:security 由来、起票日: 2026-07-07）
- 場所: .github/workflows/ci.yml:20
- 現象: CI ワークフローでも actions/checkout@v7, pnpm/action-setup@v6, actions/setup-node@v6 が可変タグで固定されている。CI は secret を扱わない（pull_request トリガーかつ secret 参照なし）ため publish.yml より実害リスクは低い。ただし pull_request_target ではなく pull_request を使っている点、permissions: contents: read で最小権限になっている点は良好であり、fork PR からの secret 露出リスクはない。
- 対応方針: publish.yml と合わせて SHA pin へ統一すれば一貫した hardening になる。

### U11. running-work の Workflow/fallback 判別が subagent 由来イベントを識別できず、ネストした実行の精度に上限がある（U8 の精緻化）

- severity: low（起票日: 2026-07-08、release-18 FR-04 の対応中に副次的に判明）
- 場所: `src/status/running-work-resolver.ts`（`runningWorkCandidateOf`／`scanForRunningWork`）
- 現象: release-18 FR-04 で「Workflow 候補は `SessionEnd` のみで消灯」という非対称境界に変更したことで known-issues U8（バックグラウンド Workflow 実行中に表示が消灯する不具合）は解消したが、resolver は依然イベント列の `tool_name`/`event_type` だけで候補を判定しており、どのサブエージェント/フック呼び出しが「その Workflow 自身の内部処理」で、どれが「Workflow 完了後に始まった別の作業」かを区別できない。具体的には: (a) ネストした Workflow/Agent（Workflow の中で別の Workflow/Task/Skill を呼ぶ構成）は現行イベントでは階層を識別できず先頭が上書きされる（スコープ外として requirements.md に明記済み）、(b) reporter がフック実行元のプロセス/セッション系譜（subagent かどうか）を送っていないため、「Workflow 完了直後に始まった全く無関係な Skill」と「Workflow 内部で呼ばれた Skill」を区別する情報が resolver 側に無い。
- 対応方針: reporter（`monomi-report.sh`）がフック実行時に subagent 系譜（親 Workflow/Task の呼び出し ID 等）を捕捉してイベントスキーマに追加し、resolver がそれを使って「この Skill/Agent は今の Workflow の子か」を判定できるようにする。イベントスキーマ拡張が前提のため設計変更を伴う。要壁打ち（release-18 requirements.md のスコープ外事項として明記済み、将来リリースで対応）。

### U9. ダッシュボードから対象 instance の実行中ターミナルへフォーカスを移動したい（claude-code-monitor 参考）

- 場所: 該当なし（未実装機能）。関連: `reporter/monomi-report.sh`（TTY 等の捕捉追加が必要）、`src/cli/components/`（キーバインド）
- 内容: 類似ツール [claude-code-monitor](https://github.com/onikan27/claude-code-monitor) は AppleScript（osascript）で対象セッションのターミナルへフォーカスを移せる（macOS 専用。iTerm2/Terminal.app は TTY ベース、Ghostty はウィンドウタイトルベースで特定）。Monomi でも一覧カード選択中・詳細ビューからキー 1 発（例: `f`）で移動したい（ユーザー要望、2026-07-07）。
- 論点: reporter がフック実行時にターミナル特定情報（TTY 等）を捕捉して hub へ送る必要がある（イベントスキーマ拡張）。マルチデバイス構成ではダッシュボードと同一デバイスの instance に限定する（device_id 照合）。AppleScript 依存のため macOS 限定機能としてのオプション化も要検討。
- 対応方針: 未検討、要壁打ち。

### N3. workflow() の相対 scriptPath 解決規則が起動方法で揺れ、run-release の起票工程が file not found で停止した

- severity: low（エンジン由来、起票日: 2026-07-07。ローカル修正済み）
- 場所: `.claude/workflows/run-release.js`（`fileKnownIssues`。release-17 ブランチのコミット 6545756 で修正済み）。上流: claude-release-workflow テンプレート 0.1.1（d3cff89）
- 現象: Workflow ツールの `workflow()` における相対 scriptPath の解決基準が起動方法で異なることを実測（2026-07-07、release-17 パイプライン）。親を相対パスで起動した場合は親スクリプトのディレクトリ基準（旧コメントの前提）だが、親を絶対パスで resume 起動した場合は cwd 基準となり、`scriptPath: 'record-known-issues.js'` がリポジトリ直下に解決されて file not found → パイプラインが起票工程で停止した。
- 対応方針: ローカルは「`.claude/workflows/` からのフルパスを先に試し、not found のときのみファイル名単独へフォールバック」の両対応で修正済み。**上流テンプレート（claude-release-workflow）への同修正の反映が未対応**。`update-release-workflow` はエンジンを上書き更新するため、上流反映が済むまでテンプレート更新でローカル修正が失われるリスクがある（本項は上流反映の完了まで保持する）。

### S9. project.name が sanitizeDisplayText を経由せず直接描画されている

- severity: low（review:security 由来、起票日: 2026-07-08）
- 場所: src/cli/components/instance-card.tsx:66
- 現象: instance-card.tsx の L66-68 と detail-view.tsx の L289-291 で `project.name` を `sanitizeDisplayText` なしで直接描画している。`project.name` は `deriveProjectName`（dto.ts）が `project_key` の末尾セグメントから生成し、`project_key` は `ProjectKeyNormalizer` が `remote_url` や `cwd` から正規化するが文字種の制限は行わない。認証済み reporter が git remote URL や cwd に ANSI エスケープ/制御文字を含む値を送信すると、`project_key` にそのまま残り、`deriveProjectName` を経て `project.name` として CLI 端末に到達する。同じ表示コンポーネント内で `device.name`・`branch`・`session.id`・`path`・`running_work.name` は全て `sanitizeDisplayText` で除染されており、`project.name` だけが非対称に未対策（CWE-150）。この描画行は今回の差分で導入されたものではなく、差分以前から存在する既存コードである。
- 対応方針: instance-card.tsx・detail-view.tsx の `project.name` 描画箇所に `sanitizeDisplayText`（または `sanitizeNullableDisplayText`）を適用し、他フィールドと対策を揃える。

### U12. install-hooks が `~/.claude/settings.json` を変更する前にバックアップを取り、復元できるようにしたい

- 場所: `src/install-hooks/install-hooks.ts`（バックアップ機構は現在未実装）
- 内容: `install-hooks`/`uninstall-hooks` は Monomi 以外のフックを保持したまま冪等に追記・除去する設計だが、他ツールの設定も同居する `~/.claude/settings.json` を直接書き換えるため、万一の破損・想定外の書き換えに備えて**変更直前のスナップショットを自動保存**し、復元手段を提供したい（ユーザー要望、2026-07-09）。
- 設計方向: 変更前に `~/.monomi/backups/settings-<timestamp>.json` へコピー（直近 N 世代を保持、古いものは自動削除）。復元は `monomi hooks restore`（または `install-hooks --restore`）等のサブコマンドで最新スナップショットへ戻す。
- 注意点: 復元は「スナップショット以降に他ツールや Claude Code 本体が加えた変更」も巻き戻す副作用があるため、追記分の除去の第一手段はあくまで既存の `monomi uninstall-hooks`（`#monomi:v1` マーカーで Monomi 起因フックのみ選択除去）とし、バックアップ復元は破損時の最終手段として位置づける。
- 対応方針: release-19 候補。要壁打ち。

### N4. `engines.node` の下限値（`>=22.5.0`）ちょうどの環境だと同梱 npm のバグで `npm install -g` 自体が失敗する

- 場所: `package.json`（`engines.node`）
- 現象: 初回公開後の動作確認（Docker、クリーン環境）で判明。`node:22.5.0-slim`（下限値ちょうど、同梱 npm 10.8.2）で `npm install -g monomi-cli` を実行すると `npm error Exit handler never called!`（npm 自体の既知バグ）で失敗し `monomi` コマンドが導入されない。同じ tarball を `node:22-slim`（現行最新 22.x、npm 10.9.8 同梱）・`node:24-slim`（npm 11.16.0 同梱）で試すと問題なく成功し、`--version`・`--help`・`hub`（起動→status→stop）まで正常動作した。Monomi 側のコード・パッケージ内容には問題なく、原因は下限値ちょうどの古い npm 側のバグ。
- 対応方針: 実害は限定的（下限値ちょうどの組み合わせを使うユーザーは稀）だが、README の必要 Node バージョン説明に「`npm` 自体を最新化してから `npm install -g` することを推奨」という一文を添えるか、`engines.node` の下限を実際に安定して動く値（例: 現行 22.x の適当な patch 以降）へ引き上げるかは要検討。

### N5. バージョン bump（npm publish）のタイミングで GitHub の Releases にも掲載したい

- 場所: 該当なし（未実装の運用プロセス）。関連: `.github/workflows/publish.yml`、`CHANGELOG.md`
- 内容: 現状 `CHANGELOG.md`（Keep a Changelog 形式）への追記のみで、GitHub の Releases 機能（タグに紐づくリリースノート）は使っていない。バージョン bump・npm publish と同じタイミングで GitHub Releases にも同内容を掲載したい（ユーザー要望、2026-07-09）。
- 対応方針: 未検討、要壁打ち。`gh release create` を `publish.yml`（または bump 手順）に組み込み、`CHANGELOG.md` の該当バージョン節を本文へ転記する自動化が候補。手動運用で当面回すか、ワークフロー化するかは要判断。

### N6. LICENSE（MIT）の著作権表記にメールアドレスが含まれている

- 場所: `LICENSE`（`Copyright (c) 2026 sumihiro3 <sumihiro@gmail.com>`）
- 内容: MIT ライセンスの著作権表記は氏名（または識別子）のみで法的要件を満たし、メールアドレスの記載は必須ではない。公開リポジトリに個人メールアドレスをそのまま載せる必要があるか再検討したい（ユーザー要望、2026-07-09）。
- 対応方針: 未検討、要壁打ち。`Copyright (c) 2026 sumihiro3` のようにメールアドレスを削除する、または GitHub ユーザー名のみに留めるか、連絡先を残す場合は問い合わせ用の別チャネル（GitHub Issues 等）に置き換えるかを判断する。

### N7. GitHub リポジトリの About（説明文・topics・website）が未記載

- 場所: 該当なし（GitHub リポジトリ設定。`gh repo edit` 等で変更可能）
- 内容: `gh repo view` で確認したところ `description`・`homepageUrl`・`repositoryTopics` がいずれも空。OSS として発信していく前提で、リポジトリの第一印象となる About 欄（説明文・topics・必要なら website）を記載したい（ユーザー要望、2026-07-09）。
- 対応方針: 未検討、要壁打ち。説明文の文言・付与する topics（例: `cli`, `claude-code`, `dashboard`, `tui` 等）を壁打ちで決め、`gh repo edit --description "..." --homepage "..." --add-topic ...` で反映する。

### U13. README のクイックスタートに実際の画面のスクリーンショットが無い

- 場所: `README.md`（クイックスタート節、L13-35 付近）
- 内容: `npx monomi-cli` 実行後のダッシュボード表示など、実際の見た目を示すスクリーンショットが無く、文章だけでは初見のユーザーに完成イメージが伝わりにくい（ユーザー要望、2026-07-09）。
- 対応方針: 未検討、要壁打ち。ダッシュボード（一覧カードグリッド・詳細ビュー等）のスクリーンショットを README.md のクイックスタート節に追加する。画像の生成・更新方法（手動キャプチャか自動化か）、配置場所（例: `docs/images/`）、ダークモード/ライトモード双方の要否は要検討。

### S10. cli.log にログローテーションがなく、長期稼働で無制限にディスクを消費する

- severity: low（review:security 由来、起票日: 2026-07-13）
- 場所: src/cli/memory-watchdog.ts:185
- 現象: MemoryWatchdog は 60 秒間隔で cli.log に appendFileSync し続けるが、ファイルサイズの上限チェックやローテーション機構がない。1 行あたり約 120 バイト、1 日約 48KB、1 年約 17MB と増加速度は緩やかだが、ダッシュボードを長期間起動し続けるユースケース（本リリースの OOM 調査がまさにそのシナリオ）では、ディスク容量の逼迫した環境（CI ランナー、小容量 VPS 等）で問題になり得る。hub.log も同様にローテーションが無いが、hub は起動/停止のタイミングでログが区切られる一方、MemoryWatchdog は 60 秒間隔で絶え間なく追記する点が異なる。
- 対応方針: sample() 内でファイルサイズを確認し、閾値（例: 10MB）を超えたら先頭を切り詰めるか、ファイル名にタイムスタンプを付与してローテーションする。

## 解決済みログ

| ID  | 内容                                                                                                                                               | 解決リリース                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | 恒久 4xx が outbox キュー全体を閉塞                                                                                                                | release-3（FR-07: `outbox/rejected/` 隔離＋上限掃除）                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B2  | bash `json_escape` の制御文字未エスケープ（poison-pill）                                                                                           | release-3（FR-07: U+0000〜U+001F を `\uXXXX` 化）                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P1  | status 導出で SQL 済みソートの再実行・複数回走査                                                                                                   | release-3（FR-08: 既ソート前提の単一パス化）                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P2  | Repository が毎回 `db.prepare()` で再コンパイル                                                                                                    | release-3（FR-08: prepared statement をフィールドキャッシュ）                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| L1  | `AppView` の `useEffect` 依存欠落                                                                                                                  | release-3（FR-09。biome 緩和も撤去）                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| L2  | リストキーに配列インデックス使用                                                                                                                   | release-3（FR-09。biome 緩和も撤去）                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S2  | 読み取りエンドポイントのデバイス単位認可なし                                                                                                       | release-3（FR-06 AC-2: 「任意の有効トークンで全デバイス閲覧可」を仕様として明文化・テストで固定）                                                                                                                                                                                                                                                                                                                                                                                                      |
| S3  | `decodeURIComponent` が認証前に URIError → 500                                                                                                     | release-3（レビュー修正 #10: try/catch で 404 化）                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B7  | 異常終了で `SessionEnd` を受け取れなかった孤立セッションが、稼働中セッションの表示を覆い隠す（OSSRadar実例）                                       | release-7（FR-01: instance内の最新イベントから15分以上古いsessionをrollup対象から除外）                                                                                                                                                                                                                                                                                                                                                                                                                |
| B6  | セッション終了（正常終了含む）後も instance が一覧に残り続け、消す手段が無い                                                                       | release-8（FR-01: `filtered()` がフィルタ未選択時に `closed` を既定除外、`6` キーでトグル表示可能）                                                                                                                                                                                                                                                                                                                                                                                                    |
| B8  | セッション再開時、より優先度の高い古い session に覆い隠され instance が「稼働中」にならない                                                        | release-8（FR-02: `InstanceStatusRollup` を完全recency優先化、`STALE_SESSION_THRESHOLD_MS` 削除。加えてreview-changesで、recency優先化がイベント0件の縮退sessionの `lastEventAt=now` フォールバックと組み合わさり closed/生きているsessionを覆い隠す新規回帰2件を検出・修正）                                                                                                                                                                                                                          |
| I1  | UI 文言・エラーメッセージが日本語ハードコードで国際化（i18n）未対応                                                                                | release-9（`src/i18n/`（en.ts を基準に ja.ts を `satisfies` で網羅性チェック）へキー化。CLI 表示層のみが対象（hub 側等に実行時の日本語文字列は無いと確認済み）。既定表示言語が日本語→英語に変わる仕様変更を伴う。加えてreview-changesで、`--help`/`--version` が locale と無関係な config.yml の不正値に巻き込まれて失敗する回帰を検出・修正）                                                                                                                                                         |
| —   | 高: 一覧/詳細 API の全イベント履歴フルロード                                                                                                       | release-1 レビュー修正（keyset ページング）                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| —   | 中: outbox 再送の TOCTOU 二重送信                                                                                                                  | release-1 レビュー修正（mkdir ロック）                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| —   | 中: Bearer token の curl 引数露出（ps で可視）                                                                                                     | release-1 レビュー修正（`-K` 設定ファイル化）                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| —   | 高: devices list/revoke が任意 token で実行可能                                                                                                    | release-3 レビュー修正（loopback 限定ガード）                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| —   | 中: pair/claim の device 乗っ取り                                                                                                                  | release-3 レビュー修正（有効 token 保持 device への claim を 409 拒否）                                                                                                                                                                                                                                                                                                                                                                                                                                |
| —   | 中: `--hub` 複数指定が未実装（FR-02 AC-3 不一致）                                                                                                  | release-3 レビュー修正（配列化＋正規化）                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| —   | 低: CLI watch 中のエンドポイント再解決なし／config 由来 URL 正規化非対称／devices list N+1／run 境界判定のレイヤ越境／claim 入力長・文字種検証なし | release-3 レビュー修正（全件）                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| —   | 中: 非TTY環境（`stdout.columns` 未取得）でカードグリッドが1列フォールバックできず横並びしてしまう（FR-02 AC-4 違反）                               | release-4 レビュー修正（`flexDirection="column"` で構造的に保証、実非TTYを再現する回帰テスト追加）                                                                                                                                                                                                                                                                                                                                                                                                     |
| —   | 低: 新規CLIファイルの `import { type X }` が biome `useImportType` 警告                                                                            | release-4 レビュー修正（`import type` へ統一）                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| —   | 中: `instance-card.tsx`（`device.name`・`branch`）・`detail-view.tsx`（`device.name`）が未サニタイズで端末エスケープ注入（CWE-150）を許す          | release-10 レビュー修正（`sanitize-display-text.ts` を適用。`detail-view.tsx` の `branch` は release-6 で対応済みだったが `device.name` が漏れており、`instance-card.tsx` は両方とも未対応だった）                                                                                                                                                                                                                                                                                                     |
| U1  | ヘッダータイトルが「Claude Code Status」のままで、目立たない                                                                                       | release-10（FR-01: 「Monomi」へ変更し `backgroundColor="blue"` + `bold` でバッジ化）                                                                                                                                                                                                                                                                                                                                                                                                                   |
| U2  | 「● watching」インジケータが点滅しない                                                                                                             | release-10（FR-02: 点滅ロジックを専用コンポーネント `WatchingIndicator` に分離し1000ms間隔で点滅化（実機確認でのユーザーフィードバックにより当初の500msから倍へ変更）。P4「無条件再レンダー」を悪化させないことを負のコントロールテストで確認済み。FR-03で表示文言も `WATCHING` へ大文字化・i18nキー化）                                                                                                                                                                                               |
| U3  | ダッシュボードで選択中カードの強調が `borderColor` のみで弱い                                                                                      | release-10（FR-04: `borderStyle="double"` + `borderColor="cyan"` へ変更。実機確認でのユーザーフィードバックにより当初の `borderStyle="bold"` から二重線へ変更）                                                                                                                                                                                                                                                                                                                                        |
| U4  | フィルタリング（`[1]稼働中` 等）とカードグリッドの連動が分かりにくい                                                                               | release-10（FR-05: 有効フィルタのバッジを `inverse` 反転から `backgroundColor` 強調へ変更。壁打ちの結果、「非該当カードの完全グレーアウト」は `filtered()` の除外方式・release-8 の closed 既定非表示との再設計を要する大きめの変更と判明したため見送り、視覚的連動の強化のみで対応）                                                                                                                                                                                                                  |
| A5  | implement-feature の設計フェーズが StructuredOutput のペイロード切断でジャンク設計を確定し得る                                                     | release-12（FR-14: 設計出力のサニティ検査＋不合格時の再設計1回・再度不合格なら明示エラーで停止するガードを実装。ペイロード切断そのものへの構造対応は次リリース以降の検討課題として残す）                                                                                                                                                                                                                                                                                                               |
| S1  | SQLite DB と `~/.monomi` ディレクトリが既定パーミッションで作られ、機密データが他ローカルユーザーに読める                                          | release-13（FR-01/FR-02: home を 0o700、DB ファイルを 0o600 に固定）                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P5  | run-release の Gate2 再レビューが修正の増分に関係なく全差分×全次元を再実行する                                                                     | release-14（FR-01・FR-02: review-changes に diffPathScope 実装＋Gate2 再レビューのスコープ縮小）                                                                                                                                                                                                                                                                                                                                                                                                       |
| P6  | 実装エージェントが整形を自走せず、md 整形漏れで Gate1 修正ループが定型発火する                                                                     | release-14（FR-03: 実装エージェントの format/lint 自走）                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P7  | sync-docs が差分に無関係な文書にも全文整合パスを実行する                                                                                           | release-14（FR-04: sync-docs 関連性トリアージ）                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| N2  | run-release の meta.phases にエージェントが割り当てられない空フェーズが表示される                                                                  | release-14（FR-05: meta.phases 空フェーズ整理）                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| U6  | `Workflow`/`Agent` ツール呼び出しのイベントで、どのワークフロー/エージェントが実行中か分からない                                                   | release-16（FR-01: reporter `extract_tool_summary()` が `Workflow`/`Task`(Agent)/`Skill` の表示名を抽出。FR-02: hub `RunningWorkResolver` が代表 session の `raw_state=active` のときのみ専用境界（`Stop`/`Notification(idle_prompt)`/`SessionEnd`/`UserPromptSubmit`）でスキャンし `running_work` を一覧・詳細 API に追加（DB スキーマ変更なし）。FR-03: CLI 一覧カード・詳細ビューに `▶ <name>` 表示）                                                                                               |
| D1  | インストール／アンインストールの一気通貫ガイドが無い                                                                                               | release-17（FR-06: README を「対応環境→インストール→hub 起動・常駐化→フックの登録→ペアリング→使い方・設定→アップデート→アンインストール」の一気通貫ガイドへ再構成し、`monomi install-hooks`／`monomi uninstall-hooks`・pm2 常駐化・`~/.monomi` 削除を含む導入〜撤去を明記。clone/pnpm build 前提の開発者向け手順は `docs/development.md`（新規）へ分離）                                                                                                                                               |
| S6  | running_work.kind の未知値フォールバックが sanitizeDisplayText を経由せず端末に描画される (CWE-150)                                                | release-18（FR-06: `runningWorkKindLabel()` のフォールバックを `sanitizeDisplayText(kind)` に変更。テストでANSIエスケープ含む未知kind がサニタイズされることを確認）                                                                                                                                                                                                                                                                                                                                   |
| U8  | バックグラウンド Workflow 稼働中に running-work 表示（`▶ <name>`）が消灯し、別の Skill 名にも化ける                                                | release-18（FR-04: `scanForRunningWork` の消灯境界を候補種別ごとに非対称化。Workflow 候補は `SessionEnd` のみで消灯し、`Stop`/`UserPromptSubmit`/`Notification(idle_prompt)` を跨いで最新の `PreToolUse\|Workflow` まで遡って優先採用する。Skill/Agent の fallback 候補は従来の境界規則を維持。トレードオフとして、`SessionEnd` を送らない長時間 ACTIVE ランではポーリングごとに履歴を遡る読み取り量が増える（既知課題 P8 参照）。subagent 識別によるさらなる精緻化は U11 として新規起票）             |
| U10 | `npx monomi-cli` 一発で hub + ダッシュボードが立ち上がるクイックスタートにしたい                                                                   | release-18（FR-01: hub 自動起動（`role: hub` かつ port 不達時のみ detached spawn・`~/.monomi/hub.log` へログ・リトライ付き疎通待ち）。FR-02: `hub status`/`hub stop`・pid ファイル・stale pid 自己回復。FR-03: フック未登録時の確認プロンプト（拒否は永続化・非 TTY はスキップ）。FR-07: README を npx 起点に再構成し launchd 手動設定例を記載。クリーン環境での受け入れ試験（FR-01 AC-5/FR-07 AC-4）は PR #14 の手動検証項目として実施予定。npm 初公開は本リリースのマージ・受け入れ後に実施）        |
| A6  | dto.ts が status レイヤーの RunningWork 型を直接 wire DTO として露出（DTO 変換ステップの省略）                                                     | release-18（FR-05: `dto.ts` に wire 型 `RunningWorkDto`（`kind`/`name`/`started_at: string\|null`）と変換関数 `toRunningWorkDto()` を新設し、`InstanceStatusRow.running_work` の型を `RunningWork` から `RunningWorkDto \| null` へ変更。`toStatusDto()` と同型の明示的変換ステップを挟むことで A6 が指摘した「ドメイン型を変換なしに wire DTO として直結」を解消。あわせて `RunningWork` に `startedAt: EpochMs`（採用イベントの `occurredAt`）を追加し、一覧カード・詳細ビューに経過時間表示を追加） |
| A7  | class-diagram.md に release-18 の新規モジュール（hub-lifecycle / hub-autostart）が未反映                                                           | release-18（class-diagram.md の hub-api 層図に `HubLifecycle`、cli-ink 層図に `HubAutostart` をモジュールノードとして追加し、責任分解表にも2行追加。依存方向（`serve.ts`→`writeHubPidFile`/`removeHubPidFile`、`hub-autostart.ts`→`isPortReachable`の cli→hub 一方向依存、`isPortReachable`が`HubEndpointResolver.isReachable`と同パターンだが意図的に非共有）を責務分離の文中に明記）                                                                                                                 |
| B9  | 孤立セッションが正常終了直後に rollup 代表を乗っ取り「放置」表示にすり替わる                                                                       | release-19（FR-01: `InstanceStatusRollup.rollup()` に、同一 instance 内で最新の `CLOSED` セッションより `lastEventAt` が古い live 孤立セッションを候補から除外するフィルタを追加。除外後 live 候補が0件なら最新 `CLOSED` セッションを代表にする。B7/B8 の recency 優先ロジックへの影響なしを回帰テストで確認）                                                                                                                                                                                         |
| B10 | LANG_DELIMITER_RE に `@` 区切り文字が欠落しており `LANG=ja@modifier` 形式を検出できない                                                            | release-19（`LANG_DELIMITER_RE` を `/[_.]/` から `/[_.@]/` へ修正し FR-02 AC-1 の仕様どおりに。`ja@calendar=japanese`/`en@euro` の回帰テストを追加）                                                                                                                                                                                                                                                                                                                                                   |
| P4  | `AppView` が毎レンダー `store.filtered()` を2回計算し、集計系もメモ化なしで無条件に再計算される                                                    | release-20-dashboard-heap-guard（FR-03: `filtered()` の結果をレンダー内で使い回して二重計算を解消、`countByDisplay`/`deviceCount`/`rollupByProject` を `useMemo` 化、`useInput` は実際に state が変化する操作のときのみ `bump()` を呼ぶよう変更）                                                                                                                                                                                                                                                      |
| B5  | 詳細ビュー表示中も一覧側のポーリングが止まらず、二重ポーリング + 非表示一覧の無駄な再描画が発生                                                    | release-20-dashboard-heap-guard（FR-04: `viewMode` が `'detail'` へ遷移した際に一覧用 `PollingLoop` を `stop()`、`'list'` へ戻った際に `start()` し直す。詳細ビュー中は一覧側 `onUpdate` が発生しないこと・復帰後に再開することをテストで確認）                                                                                                                                                                                                                                                        |
| A8  | class-diagram.md: InstanceListStore.projectRows() のシグネチャが省略可能引数 rows? を反映していない                                                | release-20-dashboard-heap-guard（sync-docs による副次解消。バックログ記載の更新漏れを release-21 で整理）                                                                                                                                                                                                                                                                                                                                                                                              |
| A9  | 段階リリースと現状スコープ table に release-20 エントリが欠落                                                                                      | release-20-dashboard-heap-guard（sync-docs による副次解消。バックログ記載の更新漏れを release-21 で整理）                                                                                                                                                                                                                                                                                                                                                                                              |
