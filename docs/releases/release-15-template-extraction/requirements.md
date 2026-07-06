# release-15-template-extraction — 要件定義

- リリース識別子: `release-15-template-extraction`
- ステータス: 確定
- 作成日: 2026-07-06
- 対応する設計: 2026-07-04 承認の改良計画 Phase 3（テンプレートリポジトリ抽出）。参照: `docs/development-workflow.md`（現行運用）、`.claude/workflows/`・`.claude/commands/`・`.claude/config.schema.json`（抽出元の実体）

## 背景と目的

release-12〜14 でリリースワークフローのエンジン（`.claude/workflows/*.js`）は config 駆動のプロジェクト中立コードになったが、配布手段が旧 `release-workflow-template.zip`（バージョン識別子なし・更新追従不能・発祥元 Yagura は消失済み）のままで、他プロジェクトへの展開ができない。

本リリースは、エンジン・コマンド・docs 骨格・導入/更新スキルを専用 Git リポジトリ **`claude-release-workflow`**（GitHub private, sumihiro3）へ抽出し、「方法（エンジン）＝テンプレートリポジトリ／事実（プロジェクト固有値）＝per-repo config」の配布体制を確立する。zip は廃止し、Monomi 自身も templateVersion を記録した「導入済みプロジェクト第 1 号」となる。

## スコープの確定（壁打ちでの決定事項）

| 論点                     | 決定                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 実施プロセス             | **run-release／implement-feature は使わない**。作業の大半が Monomi リポジトリ外（新規リポジトリの作成・執筆・push、~/.claude/skills への symlink、サンドボックス検証）であり、Gate 0.5 の git 照合や review-changes の差分レビューが Monomi の作業ツリー前提で成立しないため。メインセッション主導で、執筆・検証はサブエージェント／使い捨てワークフローで並列化する。Monomi 側の変更（FR-05）のみ従来のレビュー・検査に乗せる |
| clone 配置場所           | 任意の場所に clone し `skills/` を `~/.claude/skills/` へ symlink する方式（README にはこの Mac の実例として `/opt/dev/claude-release-workflow` を挙げる。全 Mac 共通の固定パスは強制しない）                                                                                                                                                                                                                                  |
| release-15 の検証範囲    | サンドボックス（使い捨て git リポジトリ）への `/install-release-workflow` 実行で検出→質問→生成→スモークの全工程を確認するところまで。実プロジェクトへの本格導入検証は Phase 4（次リリース以降）                                                                                                                                                                                                                                |
| Monomi の位置づけ        | テンプレート「導入済みプロジェクト第 1 号」として `workflow.config.json` の `templateVersion`（テンプレートリポジトリの初回コミット SHA）・`installedAt` を記録する。以降の更新追従は `/update-release-workflow` の対象になる                                                                                                                                                                                                  |
| リポジトリ名・可視性     | `claude-release-workflow`（GitHub private, sumihiro3）— 承認済み計画どおり。名前の未使用は確認済み                                                                                                                                                                                                                                                                                                                             |
| テンプレートの言語       | 日本語のまま（config の `language` は予約フィールドとして温存）                                                                                                                                                                                                                                                                                                                                                                |
| テンプレート既定のモデル | ティア名（review も含む）。Monomi の `claude-opus-4-6` 固定は Monomi 固有のテーラリング値であり、テンプレート既定には持ち込まない                                                                                                                                                                                                                                                                                              |

## 機能要件

### FR-01: テンプレートリポジトリの作成と engine/ の抽出（優先度: 必須）

- 場所: `/opt/dev/claude-release-workflow`（新規リポジトリ）— `engine/workflows/`・`engine/commands/`・`engine/config.schema.json`・`VERSION`・`CHANGELOG.md`・`README.md`
- AC-1: GitHub private リポジトリ `sumihiro3/claude-release-workflow` を作成し、`/opt/dev/claude-release-workflow` をローカル作業コピーとする
- AC-2: `engine/workflows/` に Monomi の `.claude/workflows/` 全 6 ファイル（implement-feature・review-changes・sync-docs・release-check・run-release・record-known-issues）を、`engine/commands/` に `.claude/commands/` 全 3 ファイル（refine-requirements・logical-commits・run-release）を、`engine/config.schema.json` に `.claude/config.schema.json` をコピーする。エンジンは config 駆動の中立コードなので原則無改変（中立性検査 AC-5 で発覚した残置のみ修正し、修正は Monomi 側へも還流する）
- AC-3: `README.md` に導入手順（clone → `skills/` を `~/.claude/skills/` へ symlink → 対象プロジェクトで `/install-release-workflow`）、更新手順（`git pull` → `/update-release-workflow`）、リポジトリ構成、設計原則（方法と事実の分離）を記載する
- AC-4: `VERSION`（初期値 `0.1.0`）と `CHANGELOG.md`（初版エントリ）を置く
- AC-5: プロジェクト中立性の機械検査 — `grep -riE 'monomi|/opt/dev|yagura|projectlens' engine/ scaffold/ skills/` のヒットが 0 件（README.md は導入例のパス記載を許容するため対象外）
- AC-6: 全 `.js` の構文検査（meta を除いた本文を async 関数でラップして構文 OK）と全 `.json` の JSON.parse が通る

### FR-02: scaffold/（docs 骨格テンプレート）の作成（優先度: 必須）

- 場所: `/opt/dev/claude-release-workflow` — `scaffold/docs/development-workflow.md.tmpl`・`scaffold/docs/known-issues.md.tmpl`・`scaffold/docs/e2e-verification.md.tmpl`
- AC-1: `development-workflow.md.tmpl` — Monomi の `docs/development-workflow.md` から、7 ステップサイクル・run-release 運用（品質ゲート・autoApprove・停止時挙動・エンジン自己変更時の段階実行注記）・リリースブランチ運用・release-N 命名規則・known-issues 運用規約の**汎用骨格**を抽出する。Monomi 固有の経緯（Biome 移行・バージョン bump 例外等）は含めず、プロジェクト側で追記する節の位置を示す
- AC-2: `known-issues.md.tmpl` — 「未解決（バックログ）」「解決済みログ」の 2 部構成、コアカテゴリ（B/P/A/S = review コア 4 次元と対応）＋プロジェクト別拡張の手順（カテゴリ表への行追加＋config の categoryMap 追記）を含む雛形
- AC-3: `e2e-verification.md.tmpl` — 「何を見て・何を見ないか」の冒頭宣言、チェックリスト、実施記録表（日付・実施者・結果・メモ）の骨格
- AC-4: 各 tmpl は install スキルが生成時に置換する変数（プロジェクト名・検査コマンド等）を `{{PROJECT_NAME}}` 形式で明示し、変数一覧を tmpl 冒頭コメントに列挙する

### FR-03: `/install-release-workflow` スキル（導入ウィザード）の作成（優先度: 必須）

- 場所: `/opt/dev/claude-release-workflow` — `skills/install-release-workflow/SKILL.md`
- AC-1: **Phase 0 前提検査** — git リポジトリであること／既導入判定（`.claude/workflow.config.json` の存在 → 更新モードを案内して `/update-release-workflow` へ誘導）／ベースブランチ検出／モノレポ検出（workspaces・pnpm-workspace.yaml → 導入先パッケージの選択を質問）
- AC-2: **Phase 1 自動検出** — パッケージマニフェスト（package.json scripts・Cargo.toml・go.mod・Makefile 等）から検査コマンド候補、依存関係からレビュー次元候補（例: React→a11y、i18n ライブラリ→i18n）、docs/ 走査から同期先文書候補と不足文書を検出する
- AC-3: **Phase 2 質問**（AskUserQuestion、1 テーマずつ）— 検査コマンドの確定／レビュー次元（コア 4＋検出候補の採否）／規約文書（無ければ scaffold 生成するか）／同期先・凍結・除外／ブランチ運用／手動検証（e2e-verification）の要否／自動化レベル（pipeline: auto/ask・autoApprove の明示的意思決定）
- AC-4: **Phase 3 生成** — `workflow.config.json`（回答＋テンプレートリポジトリの HEAD SHA を templateVersion に記録）・エンジンコピー（workflows/commands）・docs 骨格（**既存ファイルは生成をスキップし config の該当項目へマッピング**）・CLAUDE.md への参照 1 行追記・`.claude/settings.json`（コロン構文の allow rules。ベースブランチへの push は含めない）
- AC-5: **Phase 4 導入スモーク** — 生成した config のスキーマ検証（構造照合）／release-check を **scriptPath 指定**で単体実行（同一セッション name 未解決の罠の回避を実装手順として明記）／プレースホルダ残置 grep
- AC-6: スキルの frontmatter（description）が「新しいプロジェクトに release-workflow を導入する」ときに発火する内容になっている

### FR-04: `/update-release-workflow` スキル（更新）の作成（優先度: 必須）

- 場所: `/opt/dev/claude-release-workflow` — `skills/update-release-workflow/SKILL.md`
- AC-1: 対象プロジェクトの `config.templateVersion` とテンプレートリポジトリの HEAD を比較し、差分の changelog（コミットログ＋ CHANGELOG.md）を提示する
- AC-2: エンジン `.js` は上書きコピー、コマンド `.md` はプロジェクト側の変更を保全する 3-way 相当の更新（衝突時は差分を提示して確認）、`workflow.config.json` は保全。更新後に templateVersion を新 SHA へ書き換える
- AC-3: configVersion 非互換（エンジン要求版と config の不一致）を検出した場合は「マイグレーション差分の提示→ユーザー承認→config 書き換え→エンジンコピー」の順で進め、承認なしに config を書き換えない
- AC-4: スキル自身の clone（テンプレートリポジトリのローカル）が上流より古い場合は、先に `git pull` を促してから再実行させる
- AC-5: 下流プロジェクトで生まれたエンジン改善は上流へ PR で還流する手順を README とスキル本文に記載する

### FR-05: Monomi 側の移行（zip 廃止・templateVersion 記録）（優先度: 必須）

- 場所: `release-workflow-template.zip`（削除）、`docs/development-workflow.md`、`.claude/workflow.config.json`
- AC-1: `release-workflow-template.zip` をリポジトリから削除する
- AC-2: `docs/development-workflow.md` の冒頭とテンプレート参照（関連ドキュメント表の zip 行）を `claude-release-workflow` リポジトリ方式の記述へ書き換える（release-11 のバージョン bump 例外・release-14 の段階実行注記は保全）
- AC-3: `.claude/workflow.config.json` の `templateVersion` にテンプレートリポジトリの初回コミット SHA、`installedAt` に導入日を記録する
- AC-4: `pnpm run lint` / `format:check` / `test` / `build` が全パスする（Monomi 側差分の release-check）

### FR-06: この Mac への配布セットアップ（優先度: 必須）

- 場所: `~/.claude/skills/install-release-workflow`・`~/.claude/skills/update-release-workflow`（symlink）
- AC-1: `/opt/dev/claude-release-workflow/skills/` 配下の 2 スキルを `~/.claude/skills/` へ symlink する
- AC-2: symlink 先の SKILL.md が Read で読めること（リンク切れなし）を確認する
- AC-3: 他 Mac（MacBook 等）向けのセットアップ手順（clone＋symlink）が README に記載されている（FR-01 AC-3 と共通）

### FR-07: サンドボックスでの導入スモーク（優先度: 必須）

- 場所: 該当なし（使い捨てサンドボックスでの検証）
- AC-1: 受け入れ試験(手動検証必須) — 使い捨ての git リポジトリ（最小の package.json＋テストスクリプトを持つ）に対し `/install-release-workflow` を実行し、Phase 0〜4（前提検査→自動検出→質問→生成→スモーク）が一巡すること
- AC-2: 受け入れ試験(手動検証必須) — 生成された `workflow.config.json` がスキーマ検証を通り、`templateVersion` にテンプレートリポジトリの SHA が記録されていること
- AC-3: 受け入れ試験(手動検証必須) — サンドボックスで release-check が scriptPath 起動で動作し、サンドボックスの検査コマンドを実行して結果を返すこと

## 非機能要件

- **プロジェクト中立性**: テンプレート成果物（engine/・scaffold/・skills/）に個別プロジェクト固有名詞・固有値を含めない（FR-01 AC-5 の grep 検査）
- **可逆性**: Monomi 側の変更は zip 削除・doc 書き換え・config 2 フィールドのみで、エンジンの動作に影響しない（release-check 全パスで担保）
- **update の安全性**: `/update-release-workflow` はユーザー承認なしに config を書き換えない（FR-04 AC-3）

## スコープ外（release-15 では実装しない）

- 実プロジェクト（サンドボックス以外）への導入検証・モノレポ実地検証（Phase 4）
- install/update スキルのプラグイン化（「プラグイン＝配達員」構成は将来候補）
- プロンプトの英語化
- バックログ S4・S5 ほか既存課題の解消

## 未解決事項

- テンプレートリポジトリの CHANGELOG 運用粒度（リリースごとか、変更ごとか）は初版運用の中で決める
- update スキルのコマンド 3-way 更新の具体手段（git merge-file 相当をエージェントが行うか、差分提示のみか）は実装時にシンプルな方を選ぶ

## 次のステップ

本リリースは作業の大半が Monomi リポジトリ外のため run-release を使わない（スコープ確定表参照）。メインセッション主導で以下の順に実施する:

1. FR-01〜04: テンプレートリポジトリの作成・執筆（並列サブエージェント＋中立性/構文の機械検査）
2. FR-06: symlink セットアップ
3. FR-07: サンドボックススモーク（発見問題はテンプレートへ即還流）
4. FR-05: Monomi 側の移行 → review-changes / release-check → コミット → PR
