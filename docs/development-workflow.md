# Monomi 開発ワークフロー

Monomi は release-workflow-template（`release-workflow-template.zip` 同梱の README が汎用の導入手順）を採用し、Claude Code の Workflow tool（dynamic workflows）による 7 ステップのリリースサイクルで開発する。本ドキュメントは、その汎用テンプレートを Monomi の実体（`.claude/workflows/`・`.claude/commands/`・`docs/releases/release-N/requirements.md`）に即して具体化した運用ガイドである。

1 サイクルは「要件を `docs/releases/release-N/requirements.md` に確定させ、同名のリリースブランチを作成してから実装に入り、レビュー・ドキュメント同期・検査を経てコミットし、PR で `main` へ合流する」流れで、要件確定なしに実装へ進まないこと・`main` への直接 push はしないことを原則とする。ただし、release-11（バージョンオートメーション）以降は、バージョン bump スクリプト（`pnpm version:patch` / `pnpm version:minor` / `pnpm version:major`）実行のみ `main` 上で直接実行し push する明示的な例外を設ける。

## 7 ステップのリリースサイクル

| #   | ステップ                         | 実体                                                                                           |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | 要件壁打ち＋リリースブランチ作成 | `/refine-requirements` → `docs/releases/release-N/requirements.md` ＋ `release-N` ブランチ作成 |
| 2   | 実装 (探索→設計→実装→検証)       | `Workflow({name: "implement-feature", args: {release: "release-N"}})`                          |
| 3   | 差分レビュー                     | `Workflow({name: "review-changes"})`                                                           |
| 4   | ドキュメント同期                 | `Workflow({name: "sync-docs", args: {release: "release-N"}})`                                  |
| 5   | リリース前検査                   | `Workflow({name: "release-check"})`                                                            |
| 6   | 論理単位コミット                 | `/logical-commits`                                                                             |
| 7   | ブランチ push・PR 作成           | `git push -u origin release-N` ＋ `gh pr create`                                               |

### 1. 要件壁打ち＋リリースブランチ作成 — `/refine-requirements`

- コマンド: `.claude/commands/refine-requirements.md`
- 対象リリース（`release-N`）単位で要件を対話で詰め、確定要件を `docs/releases/release-N/requirements.md` に書き出す。
- 出力の構成: ヘッダー（リリース識別子・ステータス・作成日）／背景と目的／機能要件（`FR-XX` 形式、優先度と受け入れ基準 `AC-XX` つき）／非機能要件／スコープ外／未解決事項。
- 次工程の `implement-feature` はこのファイルを入力に取るため、**実装可能な粒度まで具体化してから確定**させる。
- **リリースブランチ**: リリース識別子（`release-N-slug`、`docs/releases/` のディレクトリ名と完全一致）が確定した時点で、`main` を最新化してから同名のブランチを作成しチェックアウトする。以降のステップ（実装・レビュー・doc 同期・コミット）はすべてこのブランチ上で行い、ステップ 7 まで `main` はチェックアウトしない（詳細は後述の「リリースブランチの運用」）。

### 2. 実装 — `implement-feature`

- スクリプト: `.claude/workflows/implement-feature.js`
- 確定した `requirements.md` を入力に、探索→設計→実装→検証のフェーズを回す。
- 呼び出し: `Workflow({name: "implement-feature", args: {release: "release-N"}})`。単発タスクは `args: {task: "..."}`、範囲を絞るときは `args: {scope: "..."}` を併用する。

### 3. 差分レビュー — `review-changes`

- スクリプト: `.claude/workflows/review-changes.js`
- 多次元レビュー＋敵対的検証を行い、検証を通った所見だけを報告する。比較先は既定で `main`（`args: {base: "..."}` で変更可）。未コミット分も含めてレビューする。
- ここで検出され、当該リリースでは解消しないと判断した所見は `docs/known-issues.md` にバックログとして記録する（後述の「known-issues.md の運用規約」参照）。

### 4. ドキュメント同期 — `sync-docs`

- スクリプト: `.claude/workflows/sync-docs.js`
- 実装差分を各ドキュメントへ同期する。Monomi での同期対象は次の通り。
  - `docs/ARCHITECTURE.md`（設計の権威仕様）
  - `README.md`（ユーザーに見える機能・セットアップ手順）
  - `docs/design/class-diagram.md`（クラス設計）
- `docs/REQUIREMENTS.md` は「機能軸の現状サマリー」であり細かな release 差分で揺らさないため、sync-docs の同期対象には**含めない**。
- 乖離がなければ各ドキュメントは変更しない。

### 5. リリース前検査 — `release-check`

- スクリプト: `.claude/workflows/release-check.js`
- 検証コマンドを並列実行し、失敗のみを集約報告する（この工程では修正しない）。Monomi の検査は 4 種。

| キー   | コマンド                | 内容                                                      |
| ------ | ----------------------- | --------------------------------------------------------- |
| lint   | `pnpm run lint`         | `biome lint .`                                            |
| format | `pnpm run format:check` | `biome format .`（JS/TS/JSON）＋ `prettier --check`（md） |
| test   | `pnpm run test`         | `vitest run`                                              |
| build  | `pnpm run build`        | `tsc -p tsconfig.json` ＋ `chmod +x dist/cli.js`          |

- `format:check` が 2 系統に分かれているのは、Biome が Markdown 整形に未対応で md は Prettier が担うため（`release-2-biome-migration` の決定）。`.claude/` と `docs/monomi-handoff.md` は整形対象外（それぞれ Biome / Prettier の ignore 設定）。

### 6. 論理単位コミット — `/logical-commits`

- コマンド: `.claude/commands/logical-commits.md`
- 差分を意味のある論理単位に分割してコミットする。

### 7. ブランチ push・PR 作成

- `git push -u origin release-N` でリリースブランチをリモートへ push し、`gh pr create` で `main` 向けの PR を作成する。
- **`main` への直接 push はしない**（実害: release-7 で直接 push を試みたところ、自動モードのガードレールに「デフォルトブランチへの直接 push」としてブロックされた）。ただし、release-11 以降は、バージョン bump スクリプト（`pnpm version:*`）実行のみ主例外であり、実行後は `git push` で `main` へ直接 push する。PR のマージはユーザーが GitHub 上で行う、またはユーザーが明示的に指示した場合のみ `gh pr merge` する。
- マージ後、ローカルの `main` を最新化し、不要になったリリースブランチを削除する（`git branch -d release-N`）。

## バージョン bump の実行（release-11 以降）

`pnpm version:patch` / `pnpm version:minor` / `pnpm version:major` スクリプトを実行する際は、以下に注意すること。

- **working tree の状態確認**: `pnpm version` コマンドは working tree が dirty（未処理の変更がある）な場合、処理を中止して失敗する。実行前に必ず `git status` で確認し、未処理の変更があれば `git commit` または `git stash` で解消する。
- **実行場所**: `main` ブランチを checkout してから実行する（`git checkout main`）。
- **自動化**: `pnpm version` はテスト成功時に `package.json` を bump、git commit・git tag を自動作成する。push は手動ステップで、`git push -u origin main` で tag とともに push する（`git push --follow-tags`）。

## リリースブランチの運用

- **作成タイミング**: ステップ 1（要件壁打ち）で要件識別子（`release-N-slug`）が確定した時点。実装（ステップ2）に入る前に必ず作成する。
- **命名**: `docs/releases/` のディレクトリ名と完全一致させる（例: `release-7-session-status-reliability`）。ディレクトリ名と枝分かれさせない。
- **作成元**: 最新化した `main`（`git checkout main && git pull && git checkout -b release-N-slug`）。
- **作業範囲**: ステップ 2〜6（実装・レビュー・doc 同期・検査・コミット）はすべてこのブランチ上で行う。
- **合流**: ステップ 7 で PR を作成し、マージで `main` へ合流する（直接 push しない）。

## release-N の命名規則（semver とは独立）

`release-N`（例: `release-1-single-machine-wedge`）は**開発イテレーションの識別子**であり、`package.json` の `version`（semver）とは独立して採番する。

- **命名形式**: `release-<連番>-<ケバブケースの短い主題>`。既存例は `release-1-single-machine-wedge`・`release-2-biome-migration`・`release-3-multi-device-pairing`・`release-4-cli-dashboard-ux`・`release-5-docs-restructure`。ディレクトリ `docs/releases/release-N/` 配下に `requirements.md`（必須）と、必要に応じて `e2e-verification.md` などを置く。
- **採番規則**: 番号は「着手した順」に振る。プロダクト機能を伴わない tooling / docs のみのイテレーション（例: `release-2`（Biome 移行）・`release-5`（ドキュメント再構成））も同じ連番の一部として数える。
- **semver との関係**: semver（`package.json` の `version`）はプロダクトの公開バージョニング用で、release-N の増加とは 1:1 で対応しない。tooling / docs のみのリリースでバージョン番号を上げる必要はない。

### 経緯（この命名にした理由）

当初 `release-2` はマルチデバイス／ペアリングを予定していたが、Biome への lint 移行（tooling chore）が先に着手されたため、時系列順の採番でそちらが `release-2` となり、ペアリングは `release-3` に繰り下がった（`docs/releases/release-2-biome-migration/requirements.md` の冒頭注記）。この経験から、release-N は「着手順のイテレーション番号」に徹し、プロダクトのバージョン番号とは切り離すことを決定した。予定と実際の着手順がずれても番号を振り直さず、履歴として残す。

## known-issues.md の運用規約

- **場所**: `docs/known-issues.md`（`release-5` で `docs/releases/release-1-single-machine-wedge/` から移動）。`review-changes`（敵対的検証済み）由来のバックログを、リリースをまたいで一元管理する。
- **記録契機**: 主にステップ 3（差分レビュー）で検出され、そのリリースでは解消しないと判断した所見を記録する。
- **記録内容（severity つき）**: 各項目には重大度（severity）が分かる形で、場所（ファイル）・現象・対応方針を書く。未解決項目はカテゴリ接頭辞つき ID で分類する。

| 接頭辞 | 種別                                                       |
| ------ | ---------------------------------------------------------- |
| B      | バグ（correctness）                                        |
| P      | パフォーマンス                                             |
| A      | アーキテクチャ／レイヤ境界                                 |
| S      | セキュリティ                                               |
| L      | lint／コード品質                                           |
| N      | ツール警告などのノイズ                                     |
| I      | i18n（国際化）                                             |
| U      | UX/UI改善要望（ユーザー起点、review-changes 由来ではない） |
| D      | ドキュメント不足（新規ガイド等、コード変更を伴わない）     |

- **構成**: ファイルは「## 未解決（バックログ）」と「## 解決済みログ」の 2 部構成にする。解決済みログは重大度（高／中／低）と解決リリース（例: `release-3（FR-07）`）を記録するテーブルとする。
- **解決時の運用**: 項目を解決したら、バックログから削除せず**「解決済みログ」テーブルへ移動**し、どのリリースで解消したかを追記する。これにより「いつ・どのリリースで直したか」の履歴が残る。

## e2e-verification.md（実機手動検証）の位置づけ

- **目的**: 単機シミュレーションや自動テストでは固定できない項目（実 2 台のマシン境界・ネットワークの実経路など）だけを対象にした、手動チェックリスト。
- **命名／配置**: `docs/releases/release-N/e2e-verification.md`。当該リリースの受け入れ基準のうち、実機でしか検証できない項目に限定する。
- **運用パターン**: 単機シミュレーションで検証済みの項目（例: ペアリングフロー・loopback ガード・乗っ取り 409）は**再確認不要**とし、実機でしか観測できない差分（ネットワーク実経路・マシン境界）だけをチェックリスト化する。冒頭に「何を見て・何を見ないか」を明記し、シミュレーション済み項目を重複検証しない。
- **結果記録**: ファイル末尾に「日付・実施者・結果・メモ」の表を設け、実施のたびに追記する。
- **実例**: `docs/releases/release-3-multi-device-pairing/e2e-verification.md`（MacBook → Mac mini の実 2 台 E2E。hub セットアップ → ペアリング → イベント疎通 → LAN 断による Tailscale フォールバック → 片付け、の手順とチェック項目）。

## 関連ドキュメント

| ドキュメント                    | 役割                                              |
| ------------------------------- | ------------------------------------------------- |
| `docs/ARCHITECTURE.md`          | 現行アーキテクチャの権威仕様                      |
| `docs/REQUIREMENTS.md`          | 機能軸の現状要件サマリー                          |
| `docs/design/class-diagram.md`  | クラス設計                                        |
| `docs/known-issues.md`          | 既知の課題（レビュー由来のバックログ）            |
| `docs/monomi-handoff.md`        | 凍結した設計経緯（命名決定・要求の背景など）      |
| `release-workflow-template.zip` | ワークフローテンプレートの導入手順（同梱 README） |
