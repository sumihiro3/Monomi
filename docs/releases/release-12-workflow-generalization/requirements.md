# release-12-workflow-generalization — 要件定義

- リリース識別子: `release-12-workflow-generalization`
- ステータス: 確定
- 作成日: 2026-07-04
- 対応する設計: 2026-07-04 承認の改良計画（7 エージェント並列調査＋3 視点の敵対的検証・所見 32 件を反映済み）。設計要点は本書に自己完結で記載する

## 背景と目的

現行の 7 ステップ・リリースワークフロー（`docs/development-workflow.md`）には 3 つの構造問題がある。

1. **他プロジェクトへ展開できない**: `/opt/dev/Monomi` 絶対パス（4 ワークフロー計 5 箇所）・pnpm 検査コマンド・同期先文書名などがエンジンコードにハードコードされている
2. **品質ゲートとして信頼できない**: `release-check.js:47` の `results.filter(Boolean)` により検査エージェント全滅でも `passed=true` になり得る偽グリーン、`review-changes.js:104-107` のレビュー次元サイレント消失、実装失敗のリトライなし素通りがある
3. **全自動化の機構が存在しない**: 工程間の自動連鎖・失敗時修正ループ・known-issues 自動起票がすべて未実装で、「要件壁打ち後 PR 作成まで自動」が実現できない

本リリースは「方法（エンジン＝config を読むだけの汎用コード）」と「事実（プロジェクト固有値＝`.claude/workflow.config.json`）」を分離してエンジンをプロジェクト中立化し、統括ワークフロー `run-release` による**壁打ち確定→PR 作成までの全自動実行**（前提検査・品質ゲート・修正ループ・known-issues 自動起票・通知つき）を Monomi 上で完成させる。テンプレートリポジトリへの抽出（Phase 3）はエンジンの単純コピーで済む状態を本リリースのゴールとする。

## スコープの確定（壁打ちでの決定事項）

| 論点                  | 決定                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| スコープ              | 承認済み計画の Phase 1（エンジン汎用化＋堅牢化）＋ Phase 2（run-release 全自動パイプライン）。すべて Monomi リポジトリ内の作業                                                  |
| 配布方式（前提）      | 専用 Git リポジトリ＋per-repo config 分離（確定済み）。本リリースはその前段として「エンジンの中立化」まで                                                                       |
| Monomi の自動化既定値 | `pipeline: "auto"`・`autoApprove: true`（完全自動。壁打ち確定→確認なしで PR 作成まで）                                                                                          |
| レビュー用モデル      | **`claude-opus-4-6` のバージョン固定を継続**（config の完全モデル ID 指定で表現。config スキーマはティア名・完全 ID の両対応）                                                  |
| 品質ゲート            | critical/high はブロックし修正ループ（検査 5 回・レビュー 3 回上限）、medium は修正 1 回試行後起票、low は起票のみ。収束不能時: critical 残存→PR 作らず停止、high 残存→draft PR |
| コミット承認          | `run-release` の `autoApprove=true` 起動をユーザーによるコミット一括承認とみなす（`logical-commits` の規約を改訂）                                                              |
| プロジェクト中立性    | エンジン `.js`・コマンド `.md` の本文に Monomi 固有名詞・固有値を残さない（固有情報は config と docs のみ）                                                                     |

## 機能要件

### FR-01: `workflow.config.json`＋スキーマの新設（優先度: 必須）

- 場所: `.claude/workflow.config.json`（新規）、`.claude/config.schema.json`（新規）
- AC-1: config に最低限以下を含む — `configVersion: 1` / `language: "ja"` / `baseBranch: "main"` / `requirementsPath: "docs/releases/{release}/requirements.md"` / `conventionsDoc: "docs/ARCHITECTURE.md"` / `checks`（lint・format・test・build の pnpm 4 コマンド、各 `cwd`）/ `reviewDimensions`（現 `review-changes.js` の 4 次元プロンプトを移設）/ `diffPathScope: null` / `syncDocs`（targets: ARCHITECTURE.md・README.md・class-diagram.md、frozen: monomi-handoff.md、excluded: REQUIREMENTS.md）/ `knownIssues`（path・categoryMap: bugs→B, perf→P, arch→A, security→S, check:test→B, check:build→B, check:lint→L, check:format→L、マップ外→N）/ `models`（review: `claude-opus-4-6`、他はティア名）/ `complexityRubricExamples`（現 `implement-feature.js:107-114` の較正例を移設）/ `automation`（pipeline: "auto", autoApprove: true, maxFixIterationsCheck: 5, maxFixIterationsReview: 3, maxGate1RerunsPerReviewFix: 2, maxTotalCheckRuns: 10, maxAgentInvocations: 80, severityGate）
- AC-2: `config.schema.json` で検証可能（models は pattern でティア名／完全モデル ID の両対応。`templateVersion`・`installedAt` は null 許容）
- AC-3: エンジン各ファイルはプロジェクト固有情報を config 経由でのみ取得する（本文リテラルとして残さない）

### FR-02: `release-check.js` の config 駆動化＋偽グリーン修正（優先度: 必須）

- 場所: `.claude/workflows/release-check.js`
- AC-1: CHECKS を `args.config.checks` から取得。config 未指定時は haiku エージェントが `.claude/workflow.config.json` を読むフォールバック（ファイル不存在は `exists: false` で報告させ、値の捏造を防いだうえで明示 throw）
- AC-2: 絶対パス `/opt/dev/Monomi`（`:41`）を廃止し cwd 前提にする
- AC-3: **偽グリーン修正**: エージェントが null を返した検査は failed 扱い。結果数 ≠ 検査数の場合も `passed=false`（`:47` の `filter(Boolean)` 廃止）
- AC-4: CHECK_SCHEMA に構造化フィールド `failedItems`（`file:line`・テスト名・エラーコード等の文字列配列）を追加し、失敗時に必ず返させる（run-release の収束判定の入力。自由文 `detail` は表示専用）
- AC-5: 検証（scriptPath 起動）: プロダクトコードを一時的に壊すと test が failed＋failedItems 非空になる。存在しないコマンドを含む config では `passed=false` になる（全滅偽グリーンの再現テスト）

### FR-03: `review-changes.js` の config 駆動化＋null ガード（優先度: 必須）

- 場所: `.claude/workflows/review-changes.js`
- AC-1: DIMENSIONS・規約文書パス・base 既定・絶対パス（`:29,97`）を config 駆動にする
- AC-2: レビューモデルは `config.models.review` から取得（Monomi の値は `claude-opus-4-6` を継続）
- AC-3: `:92-94` — 次元レビューエージェントが null を返しても throw せず、当該次元を「検証不能」として結果に含める
- AC-4: `:104-107` — `filter(Boolean)` によるサイレント消失を廃止し、欠落次元・検証不能所見を明示報告する
- AC-5: severity の構造化出力（実装済み）が required のまま維持されていることを確認する

### FR-04: `implement-feature.js` の config 駆動化＋skipVerify＋完了性報告（優先度: 必須）

- 場所: `.claude/workflows/implement-feature.js`
- AC-1: 複雑度ルーブリック較正例（`:107-114`）・要件パス（`:57`）・規約文書・絶対パス（`:65`）を config 駆動にする
- AC-2: `args.skipVerify === true` のとき最終の release-check ネスト実行（`:176`）を省略する（run-release からの起動用。workflow() ネスト 1 段制約への対応）。単体起動時の既定は現行どおり実行
- AC-3: 実装失敗項目はサイレントスキップせず 1 回リトライし、最終的な失敗項目を戻り値に `failedItems` として明示する
- AC-4: 各作業項目の完了報告に「変更したファイル一覧」を含めさせ、`git diff --name-only` との機械照合結果（報告されたファイルに実差分がない＝捏造疑い）を戻り値に含める（run-release の Gate 0.5 の入力）

### FR-14: `implement-feature.js` 設計フェーズのジャンク出力ガード（優先度: 必須）

- 場所: `.claude/workflows/implement-feature.js`（設計フェーズ）
- 背景: 本リリースの実装中に実発生した既知課題 `docs/known-issues.md` A5。設計エージェント（opus）が大きな StructuredOutput 送信でペイロード切断に遭い、切り分け用の最小診断ペイロード（`summary: "test"`, `items: [{title: "t", ...}]`）がそのまま正式な設計出力として実装フェーズへ渡り、実装ゼロで終了した。設計出力はスキーマ適合のみで信用されており、内容の正当性検査がなかった
- AC-1: 設計エージェントの出力に対し、プレースホルダ的な内容を検知するサニティ検査を追加する（例: `summary` が極端に短い/空、`items` の `title`・`description` が極端に短い、`files` の各要素がファイルパスらしくない）
- AC-2: サニティ検査に不合格の場合、「前回の出力は無効だった」旨を明示した上で設計エージェントへの再試行を 1 回行う
- AC-3: 再試行後も不合格なら、設計を確定させず明示的にエラーとして停止する（ジャンク値のまま実装フェーズへ進ませない）
- AC-4: 検証（scriptPath 起動）: サニティ検査関数を `{summary:"test", items:[{title:"t", description:"d", files:["f"], complexity:5}]}` のような既知のジャンク形状に適用し、不合格判定になることを確認する。正常な設計形状（既存の複数項目・具体的な説明・実ファイルパス）では合格判定になることも確認する
- AC-5: 実装後、`docs/known-issues.md` の A5 を「未解決（バックログ）」から「解決済みログ」へ移動し、解決リリースを `release-12（FR-14）` と記載する

### FR-05: `sync-docs.js` の config 駆動化（優先度: 必須）

- 場所: `.claude/workflows/sync-docs.js`
- AC-1: 同期先・凍結・除外文書と絶対パス（`:26`）を config 駆動にする（固有文書名コメント `:36` も除去）
- AC-2: args パース失敗を `{}` へ潰す挙動（`:14-21`）を廃止し、明示エラーにする

### FR-06: 統括ワークフロー `run-release.js` の新設（優先度: 必須）

- 場所: `.claude/workflows/run-release.js`（新規）
- AC-1: **Gate 0 preflight** — ①作業ツリーがクリーン（autoApprove でも例外なし） ②現在ブランチ == `args.release` かつ ≠ baseBranch ③requirements.md が存在し「ステータス: 確定」 ④`configVersion` がエンジン要求版と一致 — のいずれか違反で**何も変更せず**停止し通知する
- AC-2: 実装工程は `workflow('implement-feature', {release, config, skipVerify: true})`。直後に **Gate 0.5**（FR-04 の照合結果を判定。捏造疑い・失敗残存は 1 回リトライ→残れば critical 相当として停止/draft 分岐へ）
- AC-3: **Gate 1 検査ループ** — 上限 `maxFixIterationsCheck`(5)・release-check 通算 `maxTotalCheckRuns`(10)。失敗→fix エージェント（maker。合否判定はしない）→テスト不変ガード checker（fix 前スナップショットとの差分でテストの skip 化・期待値改変・削除を検査。基準は fix エージェントの増分 diff のみ）→再検査。**収束判定**: `check key＋正規化済み failedItems のソート済み JSON` が 2 回連続一致で収束不能
- AC-4: **Gate 2 レビューループ** — 上限 `maxFixIterationsReview`(3)。confirmed 所見を severityGate で振り分け: critical/high→fix→Gate 1 再実行（別枠上限 2）→差分再レビュー / medium→修正 1 回試行、残れば起票対象 / low→起票対象
- AC-5: 全工程通算のエージェント起動数が `maxAgentInvocations`(80) を超えたら収束不能と同じ停止経路に入る
- AC-6: triage 工程で `record-known-issues`（FR-07）を実行（未対応所見＋収束不能分を入力）
- AC-7: doc 同期（sync-docs）→最終 release-check。最終検査失敗は別枠 2 回の修正ループ→収束しなければ起票＋draft PR 降格
- AC-8: コミット工程 — `args.autoApprove`（既定は `config.automation.autoApprove`）が true ならワークフロー内エージェントが論理単位コミットを実行。false なら**コミット直前で停止**し、コミット案・PR 案を戻り値で返してメインセッションの `/logical-commits`（対話承認）へ引き継ぐ
- AC-9: PR 作成分岐 — critical 残存（Gate 0.5 由来含む）→PR を作らず停止（ブランチ・作業状態は保全、reset しない）/ high 残存→draft PR＋未解決所見を本文明記 / 手動検証必須 AC（FR-09 の区分）が残存→draft PR＋未実施明記 / それ以外→通常 PR。push は `git push -u origin <release>` のみ（baseBranch への push は行わない）
- AC-10: PR 本文は自動生成 — FR/AC 充足状況（**AC 充足検証 checker が実コード grep・検査出力で裏取りした結果**に基づく。実装エージェントの自己申告は使わない）・最終検査結果・所見対応・起票 ID・更新文書一覧・消費サマリー（フェーズ別エージェント起動数）
- AC-11: 完了・停止（Gate 0 拒否・収束不能含む）時に、ワークフロー内から push 通知（bark）を直接送信する
- AC-12: 受け入れ試験（手動検証必須） — 小規模実タスク 1 件で壁打ち→PR まで無人完走すること。加えて ①ダーティツリー起動が Gate 0 で拒否される ②プロダクトコードを壊した状態から修正ループが収束する ③baseBranch への push が引き続きブロックされる（負テスト） ④収束不能を人工的に発生させ停止＋起票＋通知到達を確認する

### FR-07: `record-known-issues.js` の新設（優先度: 必須）

- 場所: `.claude/workflows/record-known-issues.js`（新規）
- AC-1: 単一エージェントが全所見を**逐次**採番・追記する（並列採番による ID 衝突の禁止）
- AC-2: 採番は `docs/known-issues.md` の「未解決（バックログ）」「解決済みログ」**両セクションを走査**した当該カテゴリの最大 ID+1（既存データで同一カテゴリ ID が両セクションに分散しているため）
- AC-3: 所見種別→カテゴリ接頭辞は `config.knownIssues.categoryMap` に従う（`check:*` 由来を含む。マップ外は N）
- AC-4: 既存項目と同一ファイル・同一現象の所見は新規起票せず既存項目への追記に留める（重複照合）
- AC-5: 起票形式は既存規約（`### <ID>. <タイトル>`＋場所/現象/対応方針）に **severity bullet を追加**した形式。起票日はエージェントが bash `date` で取得する（Workflow スクリプト内では Date 不可のため）
- AC-6: 解決済みログへの移動は自動実行せず、提案 diff としてのみ出力する

### FR-08: `/run-release` コマンドの新設（優先度: 必須）

- 場所: `.claude/commands/run-release.md`（新規）
- AC-1: `.claude/workflow.config.json` を Read→スキーマ検証→`args.config` に渡して run-release を起動する手順を指示する
- AC-2: 起動は常に **scriptPath 指定**（新規ワークフローが同一セッションで name 解決されない既知の罠の構造的回避）
- AC-3: config 不在時は「`.claude/workflow.config.json` がありません」と明示し、起動しない

### FR-09: `refine-requirements.md` の実運用フォーマット昇格＋自動起動（優先度: 必須）

- 場所: `.claude/commands/refine-requirements.md`
- AC-1: 出力仕様を実運用フォーマット（スコープ確定表・FR-XX/AC-N・場所 bullet・known-issues ID 参照）へ更新する
- AC-2: AC に「自動検証可能／手動検証必須」の区分を導入する（run-release の PR 分岐 AC-9 の入力）
- AC-3: 要件確定・ブランチ作成後、`config.automation.pipeline === "auto"` なら**確認なしで** run-release を起動する。`"ask"` のときのみ起動確認を挟む
- AC-4: requirements.md のパス等は config 参照で記述する（コマンド本文とconfig の二重管理排除）

### FR-10: `logical-commits.md` の autoApprove 対応（優先度: 必須）

- 場所: `.claude/commands/logical-commits.md`
- AC-1: `autoApprove` パラメータを追加する（既定 false＝現行どおりコミット前のユーザー承認必須）
- AC-2: 「スキル経由でも自動 commit はしない」段落を改訂し、「`run-release` の `autoApprove=true` 起動はユーザーによるコミット一括承認とみなす」例外を明文化する
- AC-3: 他プロジェクト由来の例文（`:20,27,39`）をプロジェクト中立な例文に差し替える

### FR-11: プロジェクトレベル `.claude/settings.json` の新設（優先度: 必須）

- 場所: `.claude/settings.json`（新規）
- AC-1: allow rules を**コロン構文**で定義する: `Bash(git add:*)`・`Bash(git commit:*)`・`Bash(git stash:*)`・`Bash(git push -u origin release-:*)`・`Bash(gh pr create:*)`
- AC-2: 汎用 `git push`・baseBranch への push は allow に**含めない**（release-7 で実証された main 直 push ガードレールの温存。release-11 のバージョン bump 例外は手動運用のため対象外）
- AC-3: auto モードで settings 自己編集がブロックされた場合は、手動作成手順を提示して停止する

### FR-12: CLAUDE.md の 7 ステップ表の参照化（優先度: 推奨）

- 場所: `CLAUDE.md`
- AC-1: 7 ステップ表を削除し、`docs/development-workflow.md` への参照 1 行に置き換える（CLAUDE.md／development-workflow.md／テンプレートの三重管理による乖離の根絶）

### FR-13: `development-workflow.md` への run-release 運用追記（優先度: 推奨）

- 場所: `docs/development-workflow.md`
- AC-1: run-release による自動パイプライン（品質ゲート・autoApprove・停止時の挙動）の節を追記する（全面再構成はテンプレートリポジトリ抽出時に実施）
- AC-2: release-11 で追記されたバージョン bump の main 直接 push 例外の記載を保全する

## 非機能要件

- **プロジェクト中立性**: `.claude/workflows/*.js`・`.claude/commands/*.md` の本文に Monomi 固有名詞・固有値（`Monomi`・`/opt/dev`・`monomi-handoff`・pnpm コマンド等）を残さない。検証: `grep -rniE 'monomi|/opt/dev|pnpm' .claude/workflows .claude/commands` のヒットが 0 件（config・docs は対象外）
- **既存品質の維持**: `pnpm run test`（617 件）・`lint`・`format:check`・`build` が全通過
- **後方互換**: 各ワークフローの単体起動（config args なし）はブートストラップフォールバックで従来同等に動作する
- **Workflow tool 制約の遵守**: スクリプト内 fs・Date 不可／workflow() ネスト 1 段まで（skipVerify で回避）／検証時は scriptPath 起動を用いる

## スコープ外（release-12 では実装しない）

- テンプレートリポジトリ `claude-release-workflow` の作成、install/update スキル、`release-workflow-template.zip` の削除、`development-workflow.md` の全面再構成（Phase 3）
- 他プロジェクトへの導入検証・モノレポ実地検証（Phase 4）
- プロンプトの英語化（config の `language` フィールド予約のみ）
- バージョン bump（`pnpm version:*`）の run-release への組み込み（release-11 の手動運用を維持）

## 未解決事項

- E2E（FR-06 AC-12）用の小規模実タスクの選定（`docs/known-issues.md` バックログの U/L 項目から実装完了後に選定）
- 通知送信の具体コマンド（`~/.claude` 側 bark-notify.sh の引数仕様を実装時に確認し踏襲する）
- config スキーマ検証の実行手段（ajv 等の dev 依存追加か、エージェントによる構造検査か。実装時に軽量な方を選択）
- run-release の PR 本文テンプレートの細部文言

## 次のステップ

```
Workflow({name: "implement-feature", args: {release: "release-12-workflow-generalization"}})
```

注意: 本リリースの変更対象は `.claude/` 配下（ワークフロー・コマンド・設定）と docs であり、プロダクト TS コードではない。release-check の 4 検査はほぼ素通りになるため、検証の主体は FR ごとの scriptPath 起動スモークと FR-06 AC-12 の E2E とする。run-release 自体はこのリリースの成果物なので、本リリース自身のレビュー〜PR は従来の 7 ステップ（review-changes → sync-docs → release-check → /logical-commits → push・PR）で行う。
