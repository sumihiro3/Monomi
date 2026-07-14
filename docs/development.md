# 開発者向けセットアップ

Monomi 本体（リポジトリ）を clone して開発に参加する場合の手順。npm パッケージ（`monomi-cli`）の利用者向け手順は [README.md](../README.md)（英語版）を参照。日本語で読みたい場合は [README.ja.md](../README.ja.md) を参照。

## clone・セットアップ

```sh
git clone https://github.com/sumihiro3/Monomi.git
cd Monomi
pnpm install
pnpm build
```

`pnpm build` は `dist/` に成果物を出力し、`dist/bin.js`（`bin.monomi` が指す実行エントリ）に実行権限を付与する。ローカルの `monomi` コマンドとしてリポジトリの変更を試すには `dist/bin.js` にパスを通す（例: `npm link` や `pnpm link --global`、もしくは `alias monomi="node $(pwd)/dist/bin.js"`）。

`npm link` でグローバルの `monomi` コマンドをリポジトリの `dist/bin.js` に差し替えている間は、`npm install -g monomi-cli` で入れた公開版と共存できない（同じ bin 名を奪い合う）。リンクを外して公開版へ戻すには `npm unlink -g monomi-cli`（または `npm uninstall -g monomi-cli` の後に再度 `npm install -g monomi-cli`）を実行する。

## 検査コマンド

```sh
pnpm lint          # biome lint .
pnpm format:check  # biome format . && prettier --check（Markdown のみ）
pnpm test          # vitest run
pnpm build         # tsc + dist からのテストファイル除去 + dist/bin.js の実行権限付与
```

Lint・フォーマットチェックは [Biome](https://biomejs.dev/) に統一した（設定は `biome.jsonc`）。Markdown（`.md`/`.mdx`）のみ Prettier（`.prettierrc`）でチェックする。

reporter（bash）のテストは別途 `bash reporter/monomi-report.test.sh` で実行する（詳細は `reporter/README.md`）。

## ドキュメント一覧

- 設計の権威仕様: `docs/ARCHITECTURE.md`（`docs/monomi-handoff.md` は設計経緯を記録した凍結資料であり、現行仕様の参照先ではない）
- 機能要件サマリー: `docs/REQUIREMENTS.md`（機能軸での現状要約。詳細は各 `docs/releases/release-N/requirements.md`）
- クラス設計: `docs/design/class-diagram.md`
- 開発ワークフロー: `docs/development-workflow.md`
- リリース要件: `docs/releases/`（`release-N-slug/requirements.md`）
- 既知の課題: `docs/known-issues.md`

## npm publish（メンテナ向け）

`monomi-cli` の npm 公開レジストリへの publish 運用（token 発行・version bump・publish 確認の具体的コマンド）は `docs/development-workflow.md` を参照。
