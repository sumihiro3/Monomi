# release-9-i18n — 要件定義

- リリース識別子: `release-9-i18n`
- ステータス: 確定
- 作成日: 2026-07-04
- 対応する設計: `docs/ARCHITECTURE.md`（新設セクション追加を想定）、`docs/known-issues.md`（I1）

## 背景と目的

`docs/known-issues.md` I1（UI 文言・エラーメッセージが日本語ハードコードで国際化未対応）への対応。`monomi-handoff.md` にある「OSS 公開、将来的に商用化も視野」を踏まえ、非日本語話者のユーザーも想定した表示言語切替手段を用意する。

事前調査の結果、対象は CLI 表示層に限定できることを確認済み：

- hub 側（`src/hub/*.ts`）の実行時文字列（`throw new Error(...)`・`console.*`・HTTP レスポンス）に日本語は現存しない（grep で確認済み。JSDoc コメントのみ）。
- `src/cli/pairing-client.ts`・`src/install-hooks/install-hooks.ts` にも実行時の日本語文字列は無い。
- 対象は `src/cli/status-display.ts`（状態ラベル）・`src/cli/components/*.tsx`（6 ファイル: `instance-card.tsx`・`help-overlay.tsx`・`app-view.tsx`・`instance-table.tsx`・`detail-view.tsx`・`status-filter-bar.tsx`）・`src/cli.ts`（USAGE・エラーメッセージ）の3箇所に閉じる。

## スコープの確定（壁打ちでの決定事項）

| 論点                                       | 決定                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 実装方式                                   | 軽量な自前 i18n。ライブラリは導入しない（現状の依存は `ink`/`react`/`yaml`/`zod` のみで、対象文言数も数十件規模のため、キー→文言マップの自前実装で十分）。`src/i18n/ja.ts`・`src/i18n/en.ts` にロケール別テーブルを持つ  |
| ロケール解決優先順位                       | `config.yml` の `locale:` を最優先。未設定の場合は `en` を既定とする。`LANG` 環境変数は解決に使わない（known-issues.md の当初案にあった `LANG` 参照は今回のスコープから外す）                                            |
| **既存ユーザーへの影響（重要・仕様変更）** | 現状は無設定で常に日本語表示だったが、本リリース後は `config.yml` に `locale: ja` を明示しない限り既定で英語表示になる。既存の日本語話者ユーザーは、本リリース適用後に `config.yml` へ `locale: ja` を追記する必要がある |
| 未翻訳キーのフォールバック                 | `en` を基準ロケール（ground truth）とする。アクティブなロケール（例 `ja`）に存在しないキーは `en` の値にフォールバックする                                                                                               |
| 翻訳範囲                                   | 今回のスコープで `ja`・`en` の両ロケールとも対象文言を全件用意する（段階移行はしない）                                                                                                                                   |
| 対象範囲の境界                             | CLI 表示層（`status-display.ts`・`components/*.tsx`・`cli.ts`）に限定。hub 側・pairing-client・install-hooks は対象の実行時文字列が存在しないため対応不要（上記調査で確認済み）                                          |

## 機能要件

### FR-01: ロケール解決基盤（優先度: 必須）

- 場所: `src/config/config.ts`（`rawConfigSchema`/`MonomiConfig`）、新規 `src/i18n/`（`ja.ts`・`en.ts`・ロケール解決関数・型定義）
- AC-1: `config.yml` に `locale: ja` または `locale: en` を指定できる（zod スキーマに `locale: z.enum(['ja', 'en']).optional()` を追加し、`MonomiConfig.locale` として公開）
- AC-2: `locale` 未設定時は `en` を既定ロケールとする
- AC-3: `locale` に `ja`/`en` 以外の値が指定された場合は zod のバリデーションエラーとして拒否する（既存の config パースエラー処理に準拠）
- AC-4: `src/i18n/` にロケール別の文言テーブル（`ja.ts`・`en.ts`）を持つ。両ファイルは同一のキー集合を持つ型（`Record<TranslationKey, string>` 等）で表現し、キーの過不足があれば型チェックの時点で検出できるようにする
- AC-5: アクティブなロケールのテーブルに存在しないキーがあれば `en` の値にフォールバックする関数（例 `t(key)`）を用意する
- AC-6: 回帰テスト: `locale` 未設定→`en`、`locale: ja`→日本語、不正な `locale` 値→バリデーションエラー、を確認する

### FR-02: 既存 UI 文言の全面移行（優先度: 必須）

- 場所: `src/cli/status-display.ts`（`STATUS_LABELS` 等）、`src/cli/components/instance-card.tsx`・`help-overlay.tsx`・`app-view.tsx`・`instance-table.tsx`・`detail-view.tsx`・`status-filter-bar.tsx`、`src/cli.ts`（`USAGE` 文字列・エラーメッセージ）
- AC-1: 上記ファイルの実行時に表示される日本語ハードコード文字列を、すべて FR-01 の `t(key)` 経由のキー参照に置き換える（JSDoc コメント等、実行時に表示されない文字列は対象外）
- AC-2: `status-display.ts` の状態ラベル（稼働中/権限待ち/次の指示待ち/PRレビュー待ち/放置/終了）を最優先で移行する（`docs/known-issues.md` I1 の指摘通り最も露出面が広いため）
- AC-3: `ja.ts`・`en.ts` の両方に、移行した全キーの翻訳文言を用意する（英語訳も含め本リリースで完成させる。プレースホルダーや未翻訳のまま残さない）
- AC-4: `cli.ts` の `USAGE` 文字列・サブコマンドのエラーメッセージ（`unknown command`/`unknown subcommand`/`unknown option` 等）もキー化・翻訳する
- AC-5: 回帰テスト: 主要コンポーネント（`status-display.ts`・`app-view.tsx`・`help-overlay.tsx`）で `locale: 'ja'`/`locale: 'en'` それぞれの表示文言を確認する既存テストの更新、または新規テストの追加

## 非機能要件

- 依存関係の追加は行わない（`i18next` 等の外部 i18n ライブラリは導入しない）
- 既存の `config.yml` パーミッション規約（`chmod 600`）・DRY 原則（`serve()` での読み込み1回集約、A3 とは別件）に影響しない

## スコープ外（release-9 では実装しない）

- `LANG` 環境変数からのロケール自動検出（known-issues.md I1 の当初案にあったが、`config.yml` の `locale:` のみに一本化する決定により対象外）
- `ja`/`en` 以外の第三ロケールの追加
- hub 側・pairing-client・install-hooks の文言移行（対象の実行時文字列が現存しないため不要）
- reporter（bash）側の出力文言の国際化
- 表示周りの UX 改善（`docs/known-issues.md` U1〜U4: ヘッダータイトル変更・watching インジケータ点滅・選択中カード枠線強調・フィルタバー連動強化）は別リリースとする

## 未解決事項

- 既存ユーザー（本プロジェクトの運用者自身を含む）は、本リリースのマージ後に自分の `~/.monomi/config.yml` へ `locale: ja` を追記する運用対応が必要になる。ドキュメント（README 等）への追記が要るかは `sync-docs` 工程で判断する
- 将来的に `LANG` 環境変数対応や第三ロケールを追加する場合、`src/i18n/` の型定義（キー集合）をどう拡張するかは本リリースでは設計しない

## 次のステップ

要件確定後、以下で実装フェーズへ進む:

```
Workflow({name: "implement-feature", args: {release: "release-9-i18n"}})
```
