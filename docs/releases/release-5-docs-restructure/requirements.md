# release-5-docs-restructure — 要件定義

- リリース識別子: `release-5-docs-restructure`
- ステータス: 確定
- 作成日: 2026-07-03
- 種別: ドキュメント整備（プロダクト機能の変更なし）

## 背景と目的

release-1〜4 を経て、ドキュメント構成に以下の問題が蓄積した（壁打ちで確認済み）:

- `monomi-handoff.md` は自ら「Claude.aiでの設計検討をClaude Codeへ引き継ぐための資料」と宣言しているにもかかわらず、`sync-docs` が実装のたびに書き換え続ける「現行アーキテクチャ仕様」として扱われている。命名決定の経緯（§1）のような歴史的経緯とアーキテクチャ仕様が混在している
- `docs/design/class-diagram.md` は release-1 着手前の1回きりで更新されておらず、release-3/4 の実装（`PollingLoop` ジェネリック化・`PairingService`・`InstanceCard` 等）を反映していない（review-changes #6 で指摘済み）。`sync-docs` の対象にも入っていない
- 要件資料（`docs/releases/release-N/requirements.md`）が release ごとに分散しており、「Monomi は今何ができるか」を横断的に把握できる場所がない
- `known-issues.md` が横断バックログの性質を持つのに `docs/releases/release-1-single-machine-wedge/` 配下に埋もれている
- 開発ワークフロー（release-N の命名規則・known-issues.md の運用規約・e2e-verification.md の位置づけ等）がこの会話の中にしか存在せず、文書化されていない

本リリースはこれらを整理し、「現状のスナップショット」と「詳細な決定の経緯」を分離した持続可能なドキュメント構成にする。

## スコープの確定（壁打ちでの決定事項）

| 論点                   | 決定                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 要件資料               | ルートに `REQUIREMENTS.md` を新設し、**機能軸で現状の要件を要約**する。決定の経緯・未解決事項などの細部は各 `docs/releases/release-N/requirements.md` へのリンクに留める（known-issues.md のような全文統合はしない）                                                      |
| アーキテクチャ資料     | ルートに `ARCHITECTURE.md` を新設し、`monomi-handoff.md` §0（実装前レビューで確定した権威仕様）と、§3〜10 のうち現在も有効な内容をこちらへ移行する。`monomi-handoff.md` は歴史的経緯（命名決定等）を残す**凍結した設計経緯資料**に降格し、以後 `sync-docs` の対象から外す |
| UIコンポーネント資料   | 独立した新規ファイルは作らない。`docs/design/class-diagram.md` を現状に合わせて全面更新し、`sync-docs` の対象に追加する（ARCHITECTURE.md=backend仕様、class-diagram.md=詳細クラス設計・UIコンポーネント含む、の2本構成）                                                  |
| 開発ワークフロー定義   | `docs/development-workflow.md` を新規作成する。`release-workflow-template.zip` 同梱の README（テンプレート導入手順書、汎用）を参考にしつつ、Monomi 固有の運用（release-N 命名規則・known-issues.md 運用規約・e2e-verification.md の位置づけ）を書き起こす                 |
| known-issues.md の配置 | `docs/releases/release-1-single-machine-wedge/known-issues.md` を `docs/known-issues.md` へ移動する（横断バックログという性質に合わせる）                                                                                                                                 |

## 機能要件

### FR-01: `REQUIREMENTS.md` の新設（優先度: 必須）

- AC-1: ルートに `REQUIREMENTS.md` を新設し、機能軸（例: 単機ダッシュボード／マルチデバイスペアリング／CLI UX）で現状の要件を要約する
- AC-2: 各項目から対応する `docs/releases/release-N/requirements.md` の詳細へリンクする
- AC-3: 決定の経緯・未解決事項などの細部は書かない（「何ができるか」の要約に留める）
- AC-4: `CLAUDE.md` からのリンクを追加する

### FR-02: `ARCHITECTURE.md` の新設（優先度: 必須）

- AC-1: ルートに `ARCHITECTURE.md` を新設する
- AC-2: `monomi-handoff.md` §0（project_key 正規化・outbox・認証・status 導出・段階リリース区分等）と、§3〜10 のうち現在も有効な内容（全体アーキテクチャ・DDL・Hub API・ペアリングフロー・CLI設計）をこちらへ移行する
- AC-3: 記述は実装ソース（`src/db/ddl.ts`・`src/hub/dto.ts`・各コントローラ等）と齟齬がないか確認しながら書く（実装を正として記述する。handoff.md の記述をそのまま転記しない）
- AC-4: §1 のような命名決定の経緯・歴史的トピックは移行しない（`monomi-handoff.md` 側に残す）

### FR-03: `docs/design/class-diagram.md` の全面更新（優先度: 必須）

- AC-1: 現在のソースコード（release-1〜4 の全実装）に基づき、domain-model / status-engine / hub-api / cli-ink の4レイヤーのクラス図を現状の構造に更新する
- AC-2: release-3 で追加されたクラス（`PairingService`・`DevicesController`・`ConfigWriter`・network 検出・`Loopback` 判定等）を反映する
- AC-3: release-4 での変更（`PollingLoop<T>` のジェネリック化、`KeyBindingController` の `PollingLoop` 依存削除、`InstanceCard`/`card-grid.ts`、`DetailView` の自動更新機構）を反映する
- AC-4: 既知のバックログ項目（A4: `InstanceTable` の presentational 規約逸脱・命名不一致）は図中に注記として残してもよい（解消は別リリース）

### FR-04: `monomi-handoff.md` の凍結（優先度: 必須）

- AC-1: 冒頭に「現行仕様は `ARCHITECTURE.md` を参照。本資料は設計経緯の記録として凍結」旨の注記を追加する
- AC-2: §0 など ARCHITECTURE.md へ移行済みの節には、移行先へのポインタを残す（本文を全削除するか経緯のみ残すかは実装時に判断）
- AC-3: 以後 `sync-docs`（FR-06）の対象から外す

### FR-05: `known-issues.md` の移動（優先度: 必須）

- AC-1: `docs/releases/release-1-single-machine-wedge/known-issues.md` を `docs/known-issues.md` へ `git mv` で移動する（履歴を保持する）
- AC-2: 移動元を参照している既存ドキュメント（各 release の requirements.md・README.md・CLAUDE.md）のリンクを新しいパスに更新する

### FR-06: `sync-docs.js` の同期対象更新（優先度: 必須）

- AC-1: 同期対象を `monomi-handoff.md` → `ARCHITECTURE.md` に変更する
- AC-2: `docs/design/class-diagram.md` を新たな同期対象として追加する
- AC-3: `REQUIREMENTS.md` を同期対象に含めるかどうかは未解決事項とし、実装時に判断する

### FR-07: `docs/development-workflow.md` の新規作成（優先度: 必須）

- AC-1: 6ステップサイクルの説明（`release-workflow-template.zip` 同梱 README を参考に、Monomi 向けに書き直す）
- AC-2: release-N の命名規則（イテレーション識別子であり、アプリのバージョン番号=semverとは独立という決定。命名決定の経緯を含む）を明記する
- AC-3: `known-issues.md` の運用規約（severity付き記録・「解決済みログ」への移動ルール）を明記する
- AC-4: `docs/releases/release-N/e2e-verification.md` のような手動検証手順の位置づけ・命名規則を明記する
- AC-5: `CLAUDE.md` からリンクする

### FR-08: `CLAUDE.md` の導線更新（優先度: 必須）

- AC-1: 冒頭の「設計の権威仕様」の参照先を `ARCHITECTURE.md` に変更する
- AC-2: `REQUIREMENTS.md`・`docs/development-workflow.md`・`docs/known-issues.md`（移動後）へのリンクを追加する

## 非機能要件

- 依存追加なし（ドキュメントのみの変更）
- `pnpm run format:check`（Prettier による Markdown 整形チェック）が対象ファイル全てで green であること
- 実装（`src/`・`reporter/`）への変更は一切行わない

## スコープ外（release-5 では実装しない）

- ARCHITECTURE.md 執筆にあたっての仕様の再決定（あくまで現状の文書化。新しい設計判断はしない）
- UIコンポーネント専用の独立ファイル新設（class-diagram.md への統合で対応、スコープ確定の通り）
- `release-workflow-template.zip` 自体の削除・整理
- known-issues.md に記載済みの各バックログ項目（B3〜B5・P3・P4・A1〜A4・S1・N1・I1）の解消

## 未解決事項（実装中に判断）

- `REQUIREMENTS.md` を `sync-docs` の同期対象に含めるか（機能軸サマリーのため、細かい release ごとの差分では更新しない方が安定する可能性がある）
- `monomi-handoff.md` の本文をどこまで削るか（全文削除して経緯のみ残すか、§0等はそのまま残し「移行済み」の注記だけ足すか）
- `docs/design/class-diagram.md` のファイル名・配置は現状維持でよいか（改名する場合は参照元の更新が必要）

## 次のステップ

```
Workflow({name: "implement-feature", args: {release: "release-5-docs-restructure"}})
```
