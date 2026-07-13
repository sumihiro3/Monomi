# release-20-dashboard-heap-guard 要件定義

- リリース識別子: release-20-dashboard-heap-guard
- ステータス: 確定
- 作成日: 2026-07-13
- 参照資料: `docs/ARCHITECTURE.md` §10（CLI設計）、`docs/known-issues.md`（P4・B5・P8）、本セッションの調査結果（承認済みプラン: `~/.claude/plans/stacktrace-last-few-polished-liskov.md`）

## 背景と目的

ダッシュボード（`node dist/cli.js`、引数なし起動）を約65時間起動したまま放置したところ、V8 の `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory` でクラッシュした。クラッシュ直前の GC ログは Mark-Compact で 4094.6MB → 4091.4MB とほぼ回収できておらず（0.1%未満）、これは GC で解放できないオブジェクトが実際に保持され続けている「真性リーク」のシグネチャである。

3つの並行調査エージェントによる探索と主要ファイルの直接確認の結果、CLI 側に配列の無限増殖・`fs.watch` 等の未解放リソース・Ink の `<Static>`（追記専用でスクロールバックに永続する既知の落とし穴）の使用は見つからなかった。一方で、以下が判明した:

- `monomi`（bin）は `dist/bin.js` → `dist/cli.js` という単一ディスパッチャで、ダッシュボード（引数なし）と `hub` サブコマンド（常駐デーモン）の両方を扱う。今回のクラッシュ表示に `hub` 引数が付いていないこと、ユーザー自身が「ダッシュボードを起動し放し」と説明していることから、クラッシュしたのは**ダッシュボード（Ink TUI）プロセス**である可能性が高い。
- hub 側の既知課題 P8（`src/hub/instance-status-service.ts:288` の `loadRunningWorkForCurrentRun` が、長時間 `ACTIVE` のセッションに対してポーリングのたびに履歴を遡って読み直す）は実在するが、CLI へ返す値は小さく畳み込まれており、hub 側のクエリ量・レイテンシの問題であってダッシュボード側のヒープ増大の説明にはならない。対象プロセスが異なるため本リリースのスコープには含めない。
- 最有力仮説は **Node の stdout 書き込みバックプレッシャー未処理**である。`watching-indicator.tsx` の1Hz点滅・`polling-loop.ts` の既定3秒ごとの再取得・任意のキー入力のいずれもが `bump()` を呼び、Ink はほぼ絶え間なくフル画面再描画を `stdout.write()` する。Ink パッケージには `stream.write()` の戻り値チェックや `'drain'` イベント待ちが一切なく（`node_modules/ink` を grep して確認済み）、macOS/POSIX では TTY への書き込みは非同期であるため、ターミナル側が読み出しを止めると（バックグラウンドのターミナルアプリ・固まった SSH セッション・detach された tmux 等）、未消費のバイト列が Node の Writable ストリーム内部バッファ（ヒープ上）に溜まり続ける。これは GC ログの「ほぼ回収できない」挙動、および「65時間という長丁場でようやく顕在化する」という時間スケールの双方と整合する。
- 明示的な `--max-old-space-size` の指定はどこにもなく（確認済み）、既定の上限（トレースが示す ~4GB）に達するまで際限なく増え続ける構造になっている。

heap snapshot 等の直接証拠はなく、上記は最有力仮説である（100%の確証ではない）。そのため本リリースでは、直接的な緩和策（バックプレッシャーに応じた再描画間引き）に加えて、次回再発時に仮説の真偽を確認できる軽量な診断ログも合わせて導入する。

## スコープの確定（壁打ちでの決定事項）

| 論点                         | 決定                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対策範囲                     | 承認済みプランの4項目（①診断ログ ②バックプレッシャー時の再描画間引き ③既知課題 P4/B5 の付随修正 ④known-issues.md 記録）を全て release-20 に含める。書き込み量そのものを減らす付随修正まで含めることで再発リスクを最も下げられるため。 |
| AC の検証方針                | 自動検証（単体テスト・型検査・コードレビュー実査）を中心とする。65時間相当の完全再現は非現実的なため、実運用でのログ観測は手動検証必須の参考項目として1件のみ添える（FR-01 AC-7）。                                                   |
| hub側 P8 の扱い              | 本リリースのスコープ外。クラッシュしたプロセス（ダッシュボード）と対象プロセスが異なるため、既存のまま `docs/known-issues.md` のバックログに残す。                                                                                    |
| ウォッチドッグの自動終了要否 | 自動終了（`process.exit` 等によるプロセス強制終了）はさせない。誤検知でダッシュボードが突然落ちる方がリスクが高いため、ログ記録のみに留める。                                                                                         |

## 機能要件

### FR-01: 稼働監視ログ（メモリ・stdoutバックプレッシャー計測）の追加（優先度: 必須）

- 場所: `src/cli/memory-watchdog.ts`（新規）、`src/config/paths.ts`、`src/cli.ts`
- AC-1: `src/config/paths.ts` の `MonomiPaths` に `cliLogFile`（`~/.monomi/cli.log`）が `hubLogFile` と同じパターン（`resolvePaths()` 内で `path.join(base, 'cli.log')`）で追加されている
- AC-2: 新規モジュール `src/cli/memory-watchdog.ts` が、既定60秒間隔で `process.memoryUsage()` と `stdout.writableLength` をサンプリングし、1行1サンプルの形式で `cliLogFile` へ追記する関数を提供する
- AC-3: `writableLength` が既定閾値（64KB）を超えた状態が既定連続回数（3回）続いた場合、通常のサンプル行とは区別できる WARN 相当の行を追記する
- AC-4: ウォッチドッグはいかなる条件でも `process.exit` 等でプロセスを終了させない（ログ記録専用であることをコードレビューで確認する）
- AC-5: `src/cli.ts` のダッシュボード起動経路（引数なし、`case undefined`）からウォッチドッグが起動される
- AC-6: 単体テストで、サンプリング関数が正しい形式の行を `cliLogFile` へ書き込むこと、および閾値超過が既定連続回数続いた場合に WARN 相当の行が出ることを検証する
- AC-7: 実運用でダッシュボードを一定期間（目安1週間程度）起動したままにし、`~/.monomi/cli.log` の `heapUsed`/`writableLength` の推移が横ばいであることを確認する（手動検証必須） — PR マージ後、通常利用の中で別途確認する

### FR-02: stdout バックプレッシャー時の再描画間引き（優先度: 必須・新規対策）

- 場所: `src/cli/memory-watchdog.ts`（`isStdoutBackpressured` 相当の判定関数、新規）、`src/cli/components/app-view.tsx`、`src/cli/components/watching-indicator.tsx`
- AC-1: `isStdoutBackpressured(stdout, thresholdBytes)` という純粋関数が実装され、`stdout.writableLength >= thresholdBytes` のとき `true` を返す
- AC-2: `app-view.tsx` の `polling.onUpdate`/`onError` コールバック内で、`bump()` を呼ぶ直前にバックプレッシャー判定を行い、バックプレッシャー中は再描画トリガー（`bump()`）をスキップする。ただし `store.setInstances(rows)`/`setError` などのデータ更新自体は従来どおり継続する（次にドレインした際に最新状態が描画されるようにするため）
- AC-3: `watching-indicator.tsx` の1秒ごとの点滅更新（`setVisible` 呼び出し）についても、同じ判定でバックプレッシャー中はスキップする
- AC-4: 単体テストで `isStdoutBackpressured` が閾値未満/以上それぞれで正しい真偽値を返すことを検証する
- AC-5: 単体テストで、バックプレッシャー相当の条件（フェイクの `stdout`）下では `bump()` に相当する再描画トリガーが呼ばれない（またはスキップされる）ことを確認する

### FR-03: 既知課題 P4 の解消 — `AppView` の再計算・再描画の間引き（優先度: 推奨、対応する既存課題ID: P4）

- 場所: `src/cli/components/app-view.tsx`
- AC-1: `filteredRows = store.filtered()` の呼び出しが1レンダーにつき1回になり、`projectRows()` 等の派生値も同じ結果を再利用する（二重計算の解消）
- AC-2: `countByDisplay`/`deviceCount`/`rollupByProject` 相当の集計処理が `useMemo` 化され、依存する値（`store.instances`/`filteredRows` 等）が変化しない限り再計算されない
- AC-3: `useInput` のキー入力ハンドラは、実際に state が変化する操作（フィルタ切替・選択移動・詳細表示切替等）のときのみ `bump()` を呼び、状態変化のないキー入力では呼ばない
- AC-4: 既存の `app-view.test.tsx` 等の既存テストがグリーンのまま維持される

### FR-04: 既知課題 B5 の解消 — 詳細ビュー表示中の一覧側ポーリング停止（優先度: 推奨、対応する既存課題ID: B5）

- 場所: `src/cli/components/app-view.tsx`
- AC-1: `viewMode` が `'detail'` に遷移した際、一覧用 `PollingLoop`（`polling`）が `stop()` される
- AC-2: `viewMode` が `'list'` に戻った際、一覧用 `PollingLoop` が `start()` され直す
- AC-3: 詳細ビュー表示中は一覧側の `onUpdate` による `store.setInstances()`/`bump()` が発生しないことを単体テストで確認する
- AC-4: 一覧へ戻った直後、一覧用ポーリングが再開し最新の一覧データが反映されることを単体テストで確認する

### FR-05: インシデントの記録（優先度: 必須）

- 場所: `docs/known-issues.md`
- AC-1: 本リリースで確認した OOM クラッシュの原因分析（stdout バックプレッシャー仮説と GC ログの根拠、ダッシュボード/hub のプロセス切り分け）と対策内容を、新規項目として `docs/known-issues.md` に記録する。仮説の確証が取れていない残存不確実性がある旨とあわせて、未解決（バックログ）側に記載し severity・場所・対応方針（FR-01/FR-02 実施済み、FR-01 AC-7 の実運用確認が残存）を明記する
- AC-2: 既存の P4・B5 項目は、FR-03/FR-04 での対応をもって「解決済みログ」テーブルへ移動し、解決リリースとして `release-20-dashboard-heap-guard` を記録する
- AC-3: hub 側 P8 は今回スコープ外である旨（対象プロセスがダッシュボードではなく hub であるための除外理由）を明記した上で、既存のままバックログに残す（内容変更なし）

## 非機能要件

- 性能: 追加する監視処理（FR-01/FR-02）自体が定常時の CPU/メモリ負荷を有意に増やさないこと。サンプリングは60秒間隔の軽量処理に留め、バックプレッシャー判定は `writableLength` の参照のみで追加の I/O を発生させない
- 後方互換性: `~/.monomi/` 配下のファイル構成に `cli.log` を追加するのみとし、既存ファイル（`hub.log`・`config.yml`・`monomi.db` 等）のフォーマット・挙動は変更しない

## スコープ外

- hub 側 P8（`loadRunningWorkForCurrentRun` の無制限遡り読み）の修正
- launchd/pm2 等の外部プロセスマネージャによる自動再起動の仕組み
- ウォッチドッグによる自動終了（`process.exit`）でのハードクラッシュ回避
- 65時間相当の完全な実環境再現テスト（非現実的なため実施しない）

## 未解決事項

- stdout バックプレッシャー仮説が実際の原因であるかは、`cli.log` 導入後の実運用ログでのみ最終確認できる（FR-01 AC-7）。再発した場合は `cli.log` を確認し、仮説の再検証を行う
- 各種閾値（`writableLength` 64KB、サンプリング間隔60秒、連続超過3回等）は初期値であり、実運用ログを見て調整が必要になる可能性がある

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-20-dashboard-heap-guard", config: <.claude/workflow.config.json の内容>}})
```
