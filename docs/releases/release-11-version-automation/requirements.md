# release-11-version-automation — 要件定義

- リリース識別子: `release-11-version-automation`
- ステータス: 確定
- 作成日: 2026-07-04
- 対応する設計: `docs/ARCHITECTURE.md`（新設セクション追加を想定）、`docs/development-workflow.md`（運用ルールの例外追記）

## 背景と目的

バージョン管理（semver）の更新が現状すべて手作業であることの解消。`package.json` の `version` と
`src/index.ts` の `MONOMI_VERSION`（`monomi --version` が表示する値）が手動で二重管理されており、
bump のたびに両方を書き換える必要がある。また Ink の TUI ダッシュボード（`monomi` コマンド本体の
画面）にはバージョン表示が一切なく、`monomi --version` を別途叩かないと稼働中のバージョンが
分からない。

本リリースで「バージョンの単一ソース化」「npm スクリプトによる bump 定型作業の自動化」
「TUI でのバージョン可視化」を実現する。

## 壁打ちでの技術検証（実施済み）

`MONOMI_VERSION` を `package.json` から動的に読み込む方式が本プロジェクトの構成（TypeScript
`module: NodeNext`・Node 24・`pnpm`）で実際に動作することを、要件確定前にスパイクで検証済み：

- `tsconfig.json` に `resolveJsonModule: true` を追加
- `src/index.ts` で `import packageJson from '../package.json' with { type: 'json' }` を使用
- `pnpm run build` → `dist/index.js` に `import packageJson from '../package.json' with { type: 'json' }`
  がそのまま emit され、`dist/` は repo ルート直下（`package.json` と同階層の親子関係）にあるため
  相対パスが実行時にも解決できることを確認
- `node dist/cli.js --version` が package.json の値（`0.0.1`）を正しく表示することを確認
- `pnpm run test`（617件）・`pnpm run lint`・`pnpm run build` がいずれも既存のまま成功することを確認
  （検証後にコードは元に戻し、実装は `implement-feature` で行う）

`pnpm version` の挙動についても実機検証済み（検証後は tag 削除・commit 取り消し・ファイル復元で
すべて元に戻し済み）：

- `scripts.preversion` は `pnpm version <bump>` から確実に発火する（pnpm 9.15.0 で `echo` による
  発火を実測確認。fallback チェーン（`pnpm run test && pnpm version patch`）は不要と判断）
- 既定の commit メッセージはバージョン番号そのもの（例: `0.0.2`、`v` 接頭辞なし）、tag 名は
  `v` 接頭辞つき（例: `v0.0.2`）。`--no-git-tag-version` を付けると commit・tag のいずれも
  作成されず `package.json` の書き換えのみ行われることも確認済み
- **注意**: `pnpm version` は tracked ファイルに未コミットの変更がある（working tree が dirty な）
  状態では `npm error Git working directory not clean.` で失敗する（実測確認）。`main` 上で bump 前に
  他の未コミット変更が残っていないか確認する運用が必要。untracked ファイルの存在は失敗要因にならない

## スコープの確定（壁打ちでの決定事項）

| 論点                                    | 決定                                                                                                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 二重管理の解消方針                      | `MONOMI_VERSION` の値をハードコードで保持するのをやめ、`package.json` の `version` を実行時に動的読み込みして単一ソース化する（上記スパイクで検証済み）。以後は `package.json` の1箇所を変更するだけで CLI 表示・TUI 表示の両方に自動反映される                             |
| npm スクリプトの命名                    | `version:patch`／`version:minor`／`version:major`。`version` 単体は npm/pnpm の予約済みライフサイクルフック名（`preversion`/`version`/`postversion`）と紛らわしいため、素の名前としては使わない                                                                             |
| git への副作用                          | `pnpm version <patch\|minor\|major>` をそのまま使う（package.json 書き換え＋ git commit＋ git tag をコマンド自身が自動で行う、npm 標準の `version` コマンドと同一の既定動作）。push は本リリースのスクリプトに含めない（後述）                                              |
| 実行タイミング・ブランチ                | **`main` 上で直接実行して push する運用を、本リリースに限り「no direct push to main」原則の明示的な例外として認める**（`docs/development-workflow.md` へ追記）。release-N 開発イテレーションとは独立した「随時行う管理作業」であるため                                      |
| push の自動化                           | 行わない。`git push && git push --tags`（または `git push --follow-tags`）は bump 実行後にユーザーが別途実行する、独立した明示的なステップとする（本プロジェクトの `git push` は常に単独の明示的操作として扱う既存方針に合わせる）                                          |
| bump 前の安全弁                         | `preversion` スクリプトで `pnpm run test` を必須化する。テストが red の状態での bump／commit／tag 作成を防ぐ                                                                                                                                                                |
| TUI（ダッシュボード）でのバージョン表示 | ヘッダー・ヘルプオーバーレイの**両方**に表示する。ヘッダーは「Monomi」バッジの直後に `v{MONOMI_VERSION}` を dim 表示（例: `Monomi  v0.0.1  — 3 projects · 2 devices  ● WATCHING`）。ヘルプオーバーレイはキーバインド一覧の末尾に `Monomi v{MONOMI_VERSION}` の1行を追加する |
| CHANGELOG.md                            | 今回のスコープに含めない（別途検討）                                                                                                                                                                                                                                        |
| npm registry への公開                   | 対象外。`package.json` は `"private": true` であり公開しない。tag 作成までがスコープ                                                                                                                                                                                        |

## 機能要件

### FR-01: `MONOMI_VERSION` の単一ソース化（優先度: 必須）

- 場所: `src/version.ts`（新規）、`src/index.ts`、`tsconfig.json`
- AC-1: `tsconfig.json` に `resolveJsonModule: true` を追加する
- AC-2: `MONOMI_VERSION` の定義（`import packageJson from '../package.json' with { type: 'json' }` ＋
  `packageJson.version` を参照する形）を新規の葉モジュール `src/version.ts` に置く。
  `src/index.ts`（公開 API バレル）はここから re-export するのみとし、値をハードコードで持たない
- AC-3: `pnpm run build` で `dist/index.js`／`dist/version.js` が正しく emit され、
  `node dist/cli.js --version` が `package.json` の `version` の値を表示する
  （コンパイル後の相対パス解決が壊れないことを確認）
- AC-4: `src/index.test.ts`・`src/cli.test.ts` の `--version`/`-v` テストが、`'0.0.1'` のような
  ハードコードされた期待値ではなく `package.json` から読み込んだ値（または `MONOMI_VERSION` 自身）
  と比較する形に変更する。bump のたびにテストの期待値を手動更新する必要をなくすため
- AC-5: 既存の全テスト・lint・build が回帰なく通る
- 備考（review-changes 修正）: 当初 `MONOMI_VERSION` を `src/index.ts` に直接定義したところ、
  FR-03/FR-04 で `app-view.tsx`・`help-overlay.tsx`（`index.ts` が `AppView` を re-export している
  内部コンポーネント）が表示用に `MONOMI_VERSION` を `index.ts` から import したことで
  `index.ts → app-view.tsx → index.ts` の循環依存が発生した。`index.ts` 自身の JSDoc が謳う
  「実装詳細の変更を外部へ波及させない公開 API バレル」という責務に反し、将来モジュール
  トップレベルで参照する形へ変更された場合に TDZ エラーとして顕在化しうることを実機検証で確認済み。
  値を `src/version.ts` へ切り出し、バレル・内部コンポーネントの双方がここから一方向に参照する
  形へ修正した

### FR-02: バージョンアップ用 npm スクリプトの追加（優先度: 必須）

- 場所: `package.json`（`scripts`）
- AC-1: `scripts` に `version:patch`／`version:minor`／`version:major` を追加し、それぞれ
  `pnpm version patch`／`pnpm version minor`／`pnpm version major` を実行する
- AC-2: `scripts.preversion` に `pnpm run test` を追加する。テストが失敗する状態では
  `pnpm version <bump>`（および `version:patch` 等のラッパー経由の呼び出し）が bump・commit・tag の
  いずれも実行せず異常終了する。`preversion` が `pnpm version <bump>` から確実に発火することは
  pnpm 9.15.0 で実機確認済み（上記「壁打ちでの技術検証」参照）
- AC-3: `pnpm run version:patch`（や `minor`/`major`）を実行すると、`package.json` の `version` が
  bump され、`git commit`（メッセージはバージョン番号そのもの、例 `0.0.2`）と `git tag`（`v` 接頭辞
  つき、例 `v0.0.2`）が自動作成される。push は行われない
- AC-4: `--allow-same-version` 等の特殊オプションは今回のスクリプトに組み込まない（素の
  `pnpm version` の既定動作をそのまま使う）
- AC-5: 運用上の注意として、`pnpm version` は tracked ファイルに未コミットの変更が残っている
  （working tree が dirty な）状態では失敗する（実機確認済み）。`docs/development-workflow.md` の
  追記（非機能要件参照）にこの注意を含める

### FR-03: TUI ヘッダーへのバージョン常時表示（優先度: 必須）

- 場所: `src/cli/components/app-view.tsx`
- AC-1: ヘッダー行の「Monomi」バッジの直後に、半角スペース1つを空けて `v{MONOMI_VERSION}` を
  `dimColor` で表示する（例: `Monomi  v0.0.1  — 3 projects · 2 devices  ● WATCHING`。バッジ自体が
  背景色付きで前後に半角スペース1つ分の余白を持つため、バッジと `v` の間は見た目上スペース2つ分になる。
  実機確認でのユーザーフィードバックにより、当初のスペースなし詰め表示から変更）
- AC-2: 既存の `— N projects · M devices` 表示・watching インジケータとの位置関係（同一行）は
  崩さない
- AC-3: 回帰テスト: ヘッダー行に `v` + `MONOMI_VERSION` の文字列が含まれることを確認する

### FR-04: ヘルプオーバーレイへのバージョン表示追加（優先度: 必須）

- 場所: `src/cli/components/help-overlay.tsx`
- AC-1: キーバインド一覧（`HELP_LINES`）の末尾に、`Monomi v{MONOMI_VERSION}` の1行を追加する
- AC-2: この行はロケール（`en`/`ja`）によらず同一表記とする（`WATCHING` と同様、技術的な表示で
  自然言語の翻訳を要しないため、新規 i18n キーは追加しない）
- AC-3: 行追加に伴い `HELP_OVERLAY_ROWS`（表示行数定数）を更新し、ヘルプ表示時の行数計算
  （`DetailView` 側の `extraReservedRows` 等）に既存のズレを生じさせない
- AC-4: 回帰テスト: ヘルプオーバーレイの表示に `Monomi v` + `MONOMI_VERSION` の文字列が
  含まれることを確認する

## 非機能要件

- 依存関係の追加は行わない（`pnpm version` は pnpm 本体の既存コマンドを使う）
- `docs/development-workflow.md` に「バージョンアップ（`pnpm run version:*`）は release-N サイクルとは
  独立した管理作業であり、`main` 上で直接実行して push することを例外的に許可する」旨を追記する
  （sync-docs 工程で対応）

## スコープ外（release-11 では実装しない）

- CHANGELOG.md の自動生成・更新
- npm registry への公開（`package.json` は `"private": true` のまま）
- git tag・コミットの `git push` 自動化（bump 実行後の push は独立した手動ステップとする）
- premajor/preminor/prepatch/prerelease（プレリリース版）の運用整備
- release-N（開発イテレーション識別子）と semver の対応関係の変更（既存方針どおり独立のまま）

## 未解決事項

- ヘッダーの `v{MONOMI_VERSION}` 表示が既存の端末幅フォールバック（狭い端末での折返し）と衝突しないかは
  実装時に確認する

## 次のステップ

要件確定後、以下で実装フェーズへ進む:

```
Workflow({name: "implement-feature", args: {release: "release-11-version-automation"}})
```
