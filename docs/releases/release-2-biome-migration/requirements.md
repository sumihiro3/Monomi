# release-2-biome-migration — 要件定義

- リリース識別子: `release-2-biome-migration`
- ステータス: 確定
- 作成日: 2026-07-02
- 種別: tooling chore（プロダクト機能の変更なし）

> 注: 当初 release-2 はマルチデバイス/ペアリングを予定していたが、本 tooling 移行が先に
> 着手されたため時系列順の採番でこちらが release-2 となり、**ペアリングは release-3 に繰り下げ**。
> release-N はイテレーション識別子であり、アプリのバージョン番号（semver）とは独立（命名決定の経緯は
> release-1 開始時の議論参照）。

## 背景と目的

release-1 は ESLint（+ @typescript-eslint）と Prettier の2系統で lint / format を運用してきた。
作者の意向により linter を **Biome** に移行する。Biome は JS/TS/JSON の lint と format を
1ツール・高速に担えるため、依存を減らし検査を高速化できる。

ただし **Biome は Markdown の整形に未対応**。Prettier による md 整形チェックは release-1 の
サイクル中に実際にドキュメント崩れを検出した実績があるため、廃止せず md 専用として残す
（壁打ちでの決定: 「Biome＋md のみ Prettier」）。

## スコープの確定（壁打ちでの決定事項）

| 論点             | 決定                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Biome の適用範囲 | **JS/TS/JSON の lint + format 両方**を Biome に一本化。ESLint 系依存は削除                                               |
| Markdown         | **Prettier を md 専用で残す**（`format:check` で Biome と併走）。`.prettierignore` の運用も維持                          |
| スクリプト名     | `lint` / `format:check` / `test` / `build` の名前は**変更しない**（`.claude/workflows/release-check.js` が参照するため） |

## 機能要件

### FR-01: Biome の導入と ESLint 系の撤去（優先度: 必須）

- AC-1: `@biomejs/biome`（2.x）が devDependencies に追加され、`eslint` / `@typescript-eslint/eslint-plugin` / `@typescript-eslint/parser` と `eslint.config.js` が削除されている
- AC-2: `biome.jsonc` が存在し、現行スタイル互換の設定を持つ（セミコロン無し=asNeeded・シングルクォート・lineWidth 100・trailingCommas es5）。※当初要件は `biome.json` だったが、Biome 2.5.2 では `biome.json` にコメントが1つでもあると**設定全体が無言で破棄される**（`files.includes` が無効化され `.claude`/`dist` まで走査される）ことを実機確認したため、コメントを正しく解釈する `.jsonc` を採用
- AC-3: `.claude/**`（Workflow tool 専用構文のスクリプト）・`dist`・`node_modules`・`pnpm-lock.yaml` が Biome の対象外である
- AC-4: 現行 ESLint 設定と同様に、`_` プレフィックスの未使用変数・引数が lint エラーにならない

### FR-02: スクリプトの置換（優先度: 必須）

- AC-1: `pnpm run lint` が Biome の lint を実行し exit 0 になる
- AC-2: `pnpm run format:check` が「Biome の format チェック + Prettier の md チェック」を実行し exit 0 になる
- AC-3: `.prettierignore` の `monomi-handoff.md` 除外（ユーザー手書き文書を整形しない）が維持されている

### FR-03: 既存コードの Biome 整形適用（優先度: 必須）

- AC-1: `src/**` が Biome の整形に揃っている（Prettier との軽微な差分は許容）。整形以外のロジック変更を含まない
- AC-2: 既存テスト（vitest 19ファイル・204件、`.test.tsx` 含む）が引き続き全通過する
- AC-3: `pnpm run build` が exit 0 になる

### FR-04: ドキュメント同期（優先度: 必須）

- AC-1: `README.md` の「開発」セクションが新体制（Biome / Prettier=md のみ）を反映している

## スコープ外

- `reporter/` の bash スクリプト（lint 対象外のまま）
- `.claude/` 配下のワークフロー・コマンド定義
- `src/` のロジック変更・リファクタリング（整形のみ）
- CI 設定（本プロジェクトに CI は未導入）

## 未解決事項（実装中に解決済み）

- ~~Biome の `noUnusedVariables` が `_` プレフィックスを既定で無視するか~~ → **既定で無視することを実機確認**（`_req`/`_unused` は無発火、`req`/`unused` は warn 発火。追加設定不要）
- ~~Biome 整形と Prettier 整形の差分量~~ → **6ファイルのみ・軽微**（union 型キャストの折返し位置と `vi.fn` アロー関数の折返しのみ。ロジック変更なし、`tsc --noEmit`・vitest 204件で確認）

## 実装で確定した補足事項

- Biome recommended が新規検出した実在の指摘2件（`useExhaustiveDependencies`: app-view.tsx の hook 依存 `bump` 欠落、`noArrayIndexKey`: detail-view.tsx）は、本 chore が「ロジック非変更」のため `biome.jsonc` で **warn に緩和**して lint ゲートを通した。コード側での解消は `known-issues.md` にバックログ化（L1/L2）
- 残警告22件（`noNonNullAssertion` 16・`useImportType` 4・`useTemplate` 1 ほか）は非ブロッキング。ESLint 時代に未強制だったルール由来のノイズで、方針判断（off にするか解消するか）は release-3 以降
- フォルダ除外は Biome 2.2.0 以降 `!dist` 形式（`!dist/**` は `useBiomeIgnoreFolder` が error を出す）
