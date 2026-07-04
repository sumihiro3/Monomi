# Monomi

複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PRレビュー待ち／放置）を横断確認できる CLI ダッシュボード。

- 設計の権威仕様: `docs/ARCHITECTURE.md`（`docs/monomi-handoff.md` は設計経緯を記録した凍結資料であり、現行仕様の参照先ではない）
- 機能要件サマリー: `docs/REQUIREMENTS.md`（機能軸での現状要約。詳細は各 `docs/releases/release-N/requirements.md`）
- クラス設計: `docs/design/class-diagram.md`
- 開発ワークフロー: `docs/development-workflow.md`
- 既知の課題（バックログ）: `docs/known-issues.md`
- パッケージマネージャ: pnpm
- 構成: hub（素の Node.js + SQLite）／ CLI（Ink）／ レポーター（bash、macOS/Linux/WSL2 のみ）

## 開発ワークフロー (release-workflow-template 導入)

リリースサイクルの手順（各ステップと実体）は `docs/development-workflow.md` を参照してください。

ワークフローは `.claude/workflows/`、コマンドは `.claude/commands/` にある。要件は `docs/releases/release-N/requirements.md` に確定させてから実装に進むこと。リリースブランチは要件確定時に作成し、`main` への直接 push はせず PR で合流する（詳細: `docs/development-workflow.md`）。
