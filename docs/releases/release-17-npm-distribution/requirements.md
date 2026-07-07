# release-17-npm-distribution — 要件定義

- リリース識別子: `release-17-npm-distribution`
- ステータス: 確定
- 作成日: 2026-07-07
- 対応する設計・参照資料: `docs/ARCHITECTURE.md`（install-hooks・reporter・バージョン管理）、`docs/development-workflow.md`（リリース運用への追記対象）、`docs/known-issues.md`（D1）、`docs/releases/release-11-version-automation/requirements.md`（`pnpm version` 運用の前提）

## 背景と目的

Monomi は現状、リポジトリを clone して `pnpm install && pnpm build && npm link` する開発者向け手順でしか導入できず、reporter（bash スクリプト）も手動 cp が必要である。リポジトリは private のため、外部の人はそもそも clone できない。

本リリースで **npm 公開レジストリへのパッケージ公開**（`monomi-cli`）と**利用者向けドキュメントの一気通貫整備**を行い、日本語圏の開発者が `npm install -g monomi-cli` だけで導入〜撤去まで完結できる状態にする。既知課題 **D1**（インストール／アンインストールの一気通貫ガイドが無い）を本リリースで解消する。

前提となる現状の技術的事実（要件確定前に実機確認済み）:

- SQLite は Node 組込み `node:sqlite` を使用しておりネイティブ依存なし（npm 配布に有利。ただし Node 22.5 以上が必要で、プロジェクトの動作実績は Node 24）
- npm レジストリで `monomi`（unscoped）は取得済みで使用不可。`monomi-cli` は空きであることを確認済み（2026-07-07）
- リポジトリに `.github/`（CI）は存在しない
- `package.json` は `"private": true`・`@tep-lab/monomi`・`files`/`engines` 未指定
- この開発機は npm 未ログイン（publish には別途 `npm login` またはトークン発行が必要）

## スコープの確定（壁打ちでの決定事項）

| 論点                   | 決定                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象ユーザー           | 日本語圏の開発者。ドキュメントは日本語優先（CLI 表示自体は release-9 以降、既定 en で対応済み）                                                                                                                                 |
| リポジトリの public 化 | **保留**（履歴・docs の棚卸しが先）。本リリースでは配布物（npm パッケージ）のみ公開する。npm 上の dist/ JS は誰でも読める点は了解済み                                                                                           |
| 配布経路               | npm 公開レジストリのみ。パッケージ名は `monomi-cli`（`monomi` は取得済みのため）。bin 名は `monomi` を維持                                                                                                                      |
| ライセンス             | MIT。LICENSE ファイルを新設                                                                                                                                                                                                     |
| 初公開バージョン       | 0.1.0。ただし本リリースの実装では `package.json` の version は 0.0.1 のまま変更しない。マージ後に main 上で `pnpm version:minor`（release-11 で確立した運用）により 0.1.0 へ bump し、その tag push が publish のトリガーになる |
| publish の運用         | GitHub Actions による自動化まで含める（`v*` tag push → npm publish）。加えて PR 用 CI（lint/format/test/build）も新設する                                                                                                       |
| reporter の配布        | npm パッケージに同梱し、`monomi install-hooks` が `~/.monomi/` へ自動配置する。手動 cp 手順は撤廃                                                                                                                               |
| CHANGELOG.md           | 新設する（release-11 で先送りされた項目）。0.1.0 以前の release-1〜16 は「初公開までの内部リリース」として要点のみ一括記載                                                                                                      |
| ドキュメント構成       | README を npm 利用者向け（導入→常駐→ペアリング→アンインストールの一気通貫）に再構成し、D1 は README で解消。開発者向け内容は `docs/development.md`（新規）へ分離                                                                |
| フィードバック窓口     | 当面設けない。`package.json` の `repository`/`bugs`/`homepage` は省略（private リポへのリンクは外部から 404 になるため）。public 化の検討とセットで将来整備                                                                     |

## 機能要件

### FR-01: npm 公開パッケージとしてのパッケージング整備（優先度: 必須）

- 場所: `package.json`、`LICENSE`（新規）

`package.json` を npm 公開可能な状態に整備する:

- `name` を `@tep-lab/monomi` から `monomi-cli` へ変更
- `"private": true` を削除
- `license: "MIT"` を設定し、リポジトリ直下に MIT の `LICENSE` ファイルを新設（著作権者は git user 名義）
- `files` フィールドで同梱物を `dist/`・`reporter/monomi-report.sh`・`CHANGELOG.md` に限定する（`README.md`・`LICENSE`・`package.json` は npm が常に同梱する）。`src/`・`docs/`・テスト・設定類（biome.jsonc 等）が含まれないこと
- `engines.node` を明記する（下限は FR-04 の CI マトリクス実測で確定。暫定は `>=22.5.0`、Node 22 で検証が通らない場合は `>=24.0.0` へ引き上げ）
- `description`・`keywords`（例: claude-code, dashboard, cli, monitoring）を設定
- `repository`/`bugs`/`homepage` は設定しない（スコープ確定表の決定どおり）
- `version` は 0.0.1 のまま変更しない（bump はマージ後の `pnpm version:minor` 運用）

受け入れ基準:

- AC-1: `npm pack --dry-run`（または `--json`）の出力に `dist/` 一式・`reporter/monomi-report.sh`・`README.md`・`LICENSE`・`CHANGELOG.md`・`package.json` のみが含まれ、`src/`・`docs/`・`*.test.*`・`biome.jsonc`・`tsconfig.json` が含まれない
- AC-2: `package.json` が `name: "monomi-cli"`・`license: "MIT"`・`bin.monomi`・`engines.node` を持ち、`private` フィールドが存在しない
- AC-3: `LICENSE` ファイルが存在し MIT ライセンス本文を含む
- AC-4: `pnpm build` 後、`npm pack` で生成した tarball を別ディレクトリで `npm install -g <tarball>` した環境（またはそれと等価な検証）で `monomi --version` が動作する（release-11 の `package.json` 動的読み込みがパッケージ配置でも相対パス解決できることの確認）

### FR-02: reporter の同梱と install-hooks による自動配置（優先度: 必須）

- 場所: `src/install-hooks/install-hooks.ts`、`src/cli.ts`（配線）、`README.md`（手順撤廃）

`monomi install-hooks` 実行時に、npm パッケージ同梱の `reporter/monomi-report.sh` を `~/.monomi/monomi-report.sh` へ自動配置してからフック登録を行う。手動 `cp` 手順を撤廃する。

- 同梱 reporter のパス解決は `import.meta.url` 起点でパッケージルート相対（`dist/` と `reporter/` は package root 直下の兄弟）とする
- 配置先に既存ファイルがあっても**常に上書き**する（パッケージ同梱版を正とする。旧手動配置ユーザーも自然に置き換わる）
- 配置後のファイルに実行権限（owner 実行ビット）を付与する
- `uninstall-hooks` は従来どおりフック除去のみ（reporter ファイルの削除はアンインストール手順の手動ステップ `rm -rf ~/.monomi` に含める）

受け入れ基準:

- AC-1: クリーンな環境（`~/.monomi/monomi-report.sh` 不在）で `monomi install-hooks` を実行すると、reporter が配置され実行権限が付き、7 フックが登録される（テストは既存の DI パターンで fs をモック／一時ディレクトリで検証）
- AC-2: 配置先に内容の異なる既存ファイルがある場合も同梱版で上書きされる
- AC-3: 配置に失敗した場合（権限エラー等）はフック登録へ進まず、原因が分かるエラーメッセージで異常終了する
- AC-4: README から `cp reporter/monomi-report.sh ~/.monomi/` の手動手順が消えている

### FR-03: 起動時の Node バージョン検査（優先度: 必須）

- 場所: `src/cli.ts` またはその手前の軽量エントリ（新規ファイルの可能性あり）、`package.json`（bin 先変更の可能性）

`engines.node` の下限を満たさない Node で `monomi` を実行した場合、`node:sqlite` 由来の不可解なエラーやスタックトレースではなく、必要な Node バージョンを明示したメッセージで exit code 1 終了する。

- ESM は import が先に評価されるため、検査は新しい構文・組込みモジュールに依存する import の評価前に走る構造にする（例: 検査だけを行う軽量エントリから本体を dynamic import する）
- メッセージは i18n モジュールに依存せず表示できること（config/locale 読み込み前でも安全に動く。日英併記の固定文言で可）
- 下限値は `package.json` の `engines.node` を単一ソースとして参照し、ハードコードの二重管理をしない

受け入れ基準:

- AC-1: バージョン比較ロジックが pure function として unit test され、下限未満（例: v20.x）・境界値・下限以上のケースを網羅する
- AC-2: 検査失敗時の出力に必要な Node バージョンと現在のバージョンが含まれ、exit code が 1 である
- AC-3: 下限を満たす環境では従来どおり全コマンドが動作する（既存テストが green のまま）

### FR-04: PR 用 CI ワークフロー（優先度: 必須）

- 場所: `.github/workflows/ci.yml`（新規）

PR および main への push で検査を実行する GitHub Actions ワークフローを新設する。

- ジョブ内容: `pnpm run lint`・`pnpm run format:check`・`pnpm run test`・`pnpm run build`・reporter の bash テスト（`bash reporter/monomi-report.test.sh`）
- Node バージョンマトリクス: 22.x と 24.x の2系列（22.x で `node:sqlite` 起因の失敗が出る場合はマトリクスから外し、`engines.node`・FR-03 の下限・README 記載を `>=24.0.0` へ統一する）
- ランナーは ubuntu-latest（reporter は bash のため動作可能。macOS ランナーは使わない）
- `pnpm install --frozen-lockfile` を使用する

受け入れ基準:

- AC-1: ワークフロー定義が上記の全検査ジョブと Node マトリクスを含む
- AC-2: 本リリースの PR 上で CI が全ジョブ成功する（手動検証必須）

### FR-05: npm publish ワークフロー（優先度: 必須）

- 場所: `.github/workflows/publish.yml`（新規）

`v*` パターンの tag push をトリガーに npm publish する GitHub Actions ワークフローを新設する。release-11 で確立した `main` 上での `pnpm version:minor` → `git push --follow-tags` 運用にそのまま接続する。

- publish 前に test・build を実行し、失敗時は publish しない
- 認証は npm の granular access token（`monomi-cli` への publish 権限のみ）を GitHub Secrets `NPM_TOKEN` として登録して使う
- npm provenance は使わない（private リポジトリでは利用不可）
- workflow の `permissions` は最小（`contents: read`）とする

受け入れ基準:

- AC-1: ワークフロー定義が tag `v*` トリガー・test/build ゲート・`NPM_TOKEN` による publish を含む
- AC-2: 手動検証必須 — マージ後、`NPM_TOKEN` を GitHub Secrets へ登録し、main 上で `pnpm version:minor`（0.0.1 → 0.1.0）と `git push --follow-tags` を実行して、Actions 経由で `monomi-cli@0.1.0` が npm に公開され `npm view monomi-cli version` が `0.1.0` を返すこと

### FR-06: README の利用者向け再構成と開発者向けドキュメントの分離（優先度: 必須）

- 場所: `README.md`、`docs/development.md`（新規）、`docs/known-issues.md`（D1 を解決済みへ移動）

既知課題 **D1** の解消。README を npm 利用者向けの一気通貫ガイドに再構成する（README は npm のパッケージページにそのまま表示される）。

README の構成（この順で導入から撤去まで完結させる）:

1. 概要（現行の説明を踏襲）
2. 対応環境: macOS で動作確認済み・reporter は bash 前提（macOS/Linux/WSL2）・必要 Node バージョン（`engines.node` と一致させる）
3. インストール: `npm install -g monomi-cli`
4. hub の起動と常駐化: `monomi hub` と、pm2 による常駐化の具体例（コマンドは実装時に実機検証した内容を記載）
5. フックの登録: `monomi install-hooks`（FR-02 により手動 cp なし）
6. デバイスのペアリング（現行内容を踏襲）
7. 使い方・設定（現行の表を踏襲）
8. アップデート: `npm update -g monomi-cli`
9. アンインストール: `monomi uninstall-hooks` → pm2 プロセスの停止・削除 → `npm uninstall -g monomi-cli` → `~/.monomi` の削除（DB・token も消える旨を明記）

開発者向け内容（clone・pnpm セットアップ・lint/test/build・ドキュメント一覧・`npm link` 運用）は `docs/development.md` へ移設する。README には「開発に参加する場合はリポジトリの `docs/development.md` を参照」の一行のみ残す（private リポのため npm 利用者にはリンクとして機能しない前提で書く）。

受け入れ基準:

- AC-1: README にインストール〜アンインストールの上記 1〜9 が漏れなく含まれ、clone/`pnpm build` 前提の導入手順と reporter 手動 cp 手順が本文から消えている
- AC-2: `docs/development.md` が存在し、移設した開発者向け内容（セットアップ・検査コマンド・ドキュメント一覧）を含む
- AC-3: `docs/known-issues.md` の D1 が「解決済みログ」へ移動され、解決リリースとして release-17 が記録されている
- AC-4: README 記載の必要 Node バージョンが `package.json` の `engines.node` と一致している

### FR-07: CHANGELOG.md の新設（優先度: 必須）

- 場所: `CHANGELOG.md`（新規）、`.claude/workflow.config.json`（syncDocs.targets へ追加）、`docs/development-workflow.md`（運用ルール追記）

Keep a Changelog 形式の `CHANGELOG.md` を新設し、npm パッケージに同梱する（FR-01 の `files` に含める）。

- `## [0.1.0]` セクションに初公開内容（ダッシュボード・hub・ペアリング・フック連携・本リリースの配布整備）を利用者目線の要点で記載する
- release-1〜16 の遡及記載は行わず、「0.1.0 が初の公開リリース（それ以前は内部イテレーション）」である旨を明記する
- `.claude/workflow.config.json` の `syncDocs.targets` に CHANGELOG.md を追加し、指示文を「利用者に見える変更のみを Keep a Changelog 形式で Unreleased セクションへ追記する。乖離がなければ変更しない」とする（以降のリリースで自動追記されるようにする）
- `docs/development-workflow.md` に「version bump 時に Unreleased を該当バージョンへ繰り上げる」運用を追記する

受け入れ基準:

- AC-1: `CHANGELOG.md` が Keep a Changelog 形式で存在し、`[0.1.0]` セクションと初公開の明記を含む
- AC-2: `.claude/workflow.config.json` の `syncDocs.targets` に CHANGELOG.md のエントリが追加されている
- AC-3: `prettier --check`（format:check）が CHANGELOG.md を含めて成功する

### FR-08: npm 公開手順の手順書化（優先度: 必須）

- 場所: `docs/development-workflow.md`（追記）

publish 運用をコピペ可能なコマンド付きで手順書化する:

- 初回のみ: npm アカウントでの granular access token 発行（`monomi-cli` への publish 権限のみ・有効期限付き）→ `gh secret set NPM_TOKEN` での登録
- 毎リリース: main 最新化 → working tree clean 確認（release-11 の注意事項）→ `pnpm version:patch|minor|major` → `git push --follow-tags` → Actions の publish 成功確認 → `npm view monomi-cli version` での到達確認
- 公開直後の動作確認: クリーン環境相当での `npm install -g monomi-cli` → `monomi --version`

受け入れ基準:

- AC-1: `docs/development-workflow.md` に上記の初回手順・毎リリース手順が具体的コマンド付きで記載されている
- AC-2: 記載コマンドが release-11 で確立した version 運用（main 上で bump・push は明示的な別ステップ）と矛盾しない

## 非機能要件

- **セキュリティ**: `NPM_TOKEN` は publish 権限のみの granular token とし、ワークフローの `permissions` を最小化する。token・シークレット値をログ・ドキュメント・コミットに含めない。CI/publish は `--frozen-lockfile` でロックファイルを強制する
- **互換性**: 既存ユーザー（開発者自身の `npm link` 運用・手動配置済み reporter）を壊さない。bin 名 `monomi`・`~/.monomi` のレイアウト・config.yml・DB スキーマ・hub API に変更なし。reporter は install-hooks 再実行で同梱版に置き換わる（上書きは仕様）
- **可搬性**: 動作確認済みは macOS のみである旨を README に明記する（hub/CLI は Node のみに依存するが、動作保証の範囲を正直に書く）

## スコープ外（やらないと決めたこと）

- リポジトリの public 化（履歴・docs の棚卸しが先。別途検討）
- npm 以外の配布経路（Homebrew tap・GitHub Releases バイナリ等）
- 英語ドキュメント（対象は日本語圏の開発者。CLI 表示は既定 en で対応済み）
- フィードバック窓口（GitHub Issues 代替）の設置
- npm provenance（private リポジトリでは利用不可）
- `package.json` の version bump（マージ後の運用ステップであり本リリースの差分に含めない）

## 未解決事項（実装中に判断が必要な点）

- **Node 下限の最終値**: 暫定 `>=22.5.0`。FR-04 の CI マトリクス（22.x/24.x）の実測で確定し、`engines.node`・FR-03 検査・README 記載を必ず一致させる
- **`node:sqlite` の ExperimentalWarning**: 利用者の目に stderr 警告が触れるかを実装時に確認し、許容するか抑制するか判断する（抑制する場合も警告全般の握りつぶしはしない）
- **pm2 常駐の具体コマンド**: README 記載前に実機検証し、動いた形をそのまま記載する（グローバルインストールされた bin を pm2 で起動する形式の確認）

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-17-npm-distribution", config: <.claude/workflow.config.json の内容>}})
```
