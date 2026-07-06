# release-13-monomi-home-permissions — 要件定義

- リリース識別子: `release-13-monomi-home-permissions`
- ステータス: 確定
- 作成日: 2026-07-06
- 対応する設計: `docs/ARCHITECTURE.md`（既存の `chmod 600` 方針との整合を保つ）。既存課題 `docs/known-issues.md` S1 の解消

## 背景と目的

`~/.monomi` ディレクトリと SQLite DB ファイル（`monomi.db`）が既定パーミッションで作成されており、単一ユーザー前提の現状でも他ローカルユーザーから読める状態になっている（`docs/known-issues.md` S1）。`token`/`config.yml` は既に `chmod 600` 固定済みだが、それらを格納するディレクトリ自体と DB ファイルが未対応のまま残っている。

本リリースは、このパーミッション強化に加えて、**`run-release`（統括ワークフロー）の初回ライブ無人実行検証**を兼ねる。要件壁打ち後、実装→検査ループ→レビューループ→known-issues 起票→doc 同期→コミット→PR 作成までを実際に無人連鎖実行し、`release-12-workflow-generalization` で構築したゲート機構（Gate 0 前提検査・Gate 0.5 実装照合・Gate 1 検査ループ・Gate 2 レビューループ）が実際に機能することを確認する。

## スコープの確定（壁打ちでの決定事項）

| 論点                                         | 決定                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象範囲                                     | 当初の known-issues.md 記載（`serve.ts`/`database.ts`）に加え、実地調査で判明した `src/cli/pairing-client.ts`（子デバイスの `monomi pair` 時に同種の token を同じ無防備なディレクトリへ書き込む）も含める。`~/.monomi` を作成する3箇所（`serve.ts`・`bootstrap.ts`・`pairing-client.ts`）全てを対象にする |
| 既存インストールへの適用                     | 毎回起動時に無条件で `chmodSync` する（新規作成時のみに限定しない）。アップグレード後の初回起動で自動的にパーミッションが修復される。`bootstrap.ts` の token ファイルと同じ「書き込み後に明示 `chmodSync`」パターンを踏襲し、umask の影響を受けない                                                       |
| 3箇所の重複実装                              | 個別に `chmod` 行を足すのではなく、共通ヘルパー関数へ集約する（DRY。3箇所が同一の `mkdirSync(paths.home, {recursive: true})` を重複させている既存構造そのものの改善を兼ねる）                                                                                                                             |
| `config.yml`                                 | 対象外。`src/config/config-writer.ts:44-45` で既に `chmod 600` 固定済みであることを確認済み                                                                                                                                                                                                               |
| `outboxDir`/`rejectedDir` 等の他ディレクトリ | 対象外。`~/.monomi` を 0o700 にすることで、配下の全ファイル・サブディレクトリはパストラバーサル自体が他ユーザーから不可能になるため、個別対応は不要                                                                                                                                                       |

## 機能要件

### FR-01: `~/.monomi` ディレクトリ作成の共通ヘルパー化とパーミッション強化（優先度: 必須）

- 場所: `src/config/paths.ts`（新規関数）、`src/hub/serve.ts:84`、`src/hub/bootstrap.ts:107`、`src/cli/pairing-client.ts:232`（既存の `mkdirSync` 呼び出しを置換）
- 対応する既存課題: `docs/known-issues.md` S1
- AC-1: `src/config/paths.ts` に `ensureMonomiHome(paths: MonomiPaths): void` を新設する。`fs.mkdirSync(paths.home, {recursive: true})` に続けて `fs.chmodSync(paths.home, 0o700)` を必ず実行する（新規作成・既存ディレクトリの両方で毎回無条件に適用。`mkdirSync` の `mode` オプションは umask でマスクされるため、`writeTokenFile`（`bootstrap.ts`）と同様に明示 `chmodSync` を使う）
- AC-2: `serve.ts`・`bootstrap.ts`・`pairing-client.ts` の3箇所の `fs.mkdirSync(paths.home, {recursive: true})` を `ensureMonomiHome(paths)` の呼び出しに置き換える
- AC-3: 新規テスト `src/config/paths.test.ts` を追加し、`ensureMonomiHome()` 呼び出し後に `fs.statSync(paths.home).mode & 0o777` が `0o700` になることを確認する。既存ディレクトリ（広い権限で事前作成）に対しても実行後に `0o700` へ修復されることを確認する回帰テストを含める
- AC-4: `src/hub/bootstrap.test.ts`・`src/cli/pairing-client.test.ts` の既存テストが、置き換え後も現状の全アサーションを維持したまま成功すること（`ensureMonomiHome` 経由でも従来と同じ副作用になることの確認）
- AC-5: 実装後、`docs/known-issues.md` の S1 を解決済みログへ移動し、解決リリースを `release-13（FR-01/FR-02）` と記載する

### FR-02: SQLite DB ファイルのパーミッション強化（優先度: 必須）

- 場所: `src/db/database.ts`（`openDatabase()`）
- 対応する既存課題: `docs/known-issues.md` S1
- AC-1: `openDatabase()` 内で、DDL 適用後に `location !== ':memory:'` の場合のみ `fs.chmodSync(location, 0o600)` を実行する（`:memory:` はファイルが存在しないためスキップ。既存 DB ファイルに対しても毎回無条件に適用し、アップグレード経路で自動修復する）
- AC-2: 新規テスト `src/db/database.test.ts` を追加し、実ファイルパス（`fs.mkdtempSync` によるテスト用一時ディレクトリ配下）で `openDatabase()` を呼び出した際に `fs.statSync(dbFile).mode & 0o777` が `0o600` になることを確認する。`openDatabase(':memory:')` が例外を投げないこと（既存の `event-ingestion-service.test.ts`・`instance-status-service.test.ts` が `:memory:` を使い続けても壊れないこと）も確認する
- AC-3: WAL モードで遅延生成される `-wal`/`-shm` 補助ファイルは、FR-01 によるディレクトリ 0o700 化により他ユーザーからのパストラバーサル自体が防がれるため、個別の chmod 対応は行わない（このファイル自体には触れないことをコメントで明記する）

### FR-03: run-release 初回ライブ無人実行の受け入れ試験（優先度: 必須）

- 場所: 該当なし（本リリースの実施プロセス自体が検証対象）
- AC-1: 受け入れ試験(手動検証必須) — 本リリースの要件確定後、`run-release` が確認なしで自動起動し、実装（FR-01・FR-02）→ Gate 1 検査ループ → Gate 2 レビューループ → known-issues 起票（該当あれば）→ doc 同期 → コミット → PR 作成まで無人で完走すること
- AC-2: 受け入れ試験(手動検証必須) — 完走中、`/workflows` で進行を監視し、Gate 0（前提検査）・Gate 0.5（実装照合）が実際に発火する（ログ・戻り値に現れる）ことを確認する
- AC-3: 受け入れ試験(手動検証必須) — 生成された PR の本文に、FR-01/FR-02 の AC 充足状況・最終検査結果・known-issues（S1 解決）の反映が含まれていることを確認する

## 非機能要件

- **性能**: `chmodSync` の追加呼び出しはナノ秒オーダーのコストであり、hub 起動時間・`monomi pair` 実行時間に体感できる影響を与えない
- **後方互換性**: 既存の `~/.monomi` インストール（release-12 以前に作成されたもの）に対して、手動移行手順なしで次回起動時に自動的にパーミッションが修復されること
- **セキュリティ**: 単一ユーザー前提の現状要件を維持しつつ、多ユーザー環境でも `~/.monomi` 配下の機密データ（token・DB・config.yml）が他ユーザーから読めない状態にする

## スコープ外（release-13 では実装しない）

- `outboxDir`・`rejectedDir` への個別のパーミッション対応（ディレクトリ 0o700 化で構造的に保護されるため）
- `config.yml` のパーミッション対応（対応済み確認のみ）
- Windows 環境でのパーミッションモデル対応（`ARCHITECTURE.md` の対象 OS が macOS/Linux/WSL2 であり、WSL2 は Linux 側の POSIX パーミッションに従うため現行方針のままで良いと判断。Windows ネイティブは元々スコープ外）
- known-issues.md のその他バックログ項目（S1 以外）

## 未解決事項

- なし（壁打ちで全論点確定済み）

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-13-monomi-home-permissions", config: <.claude/workflow.config.json の内容>}})
```
