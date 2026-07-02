# Monomi

複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PRレビュー待ち／放置）を横断確認できる CLI ダッシュボード。

- 設計の権威仕様: `ARCHITECTURE.md`（`monomi-handoff.md` は設計経緯を記録した凍結資料であり、現行仕様の参照先ではない）
- 機能要件サマリー: `REQUIREMENTS.md`（機能軸での現状要約。詳細は各 `docs/releases/release-N/requirements.md`）
- クラス設計: `docs/design/class-diagram.md`
- 開発ワークフロー: `docs/development-workflow.md`
- 既知の課題（バックログ）: `docs/known-issues.md`
- パッケージマネージャ: pnpm
- 構成: hub（素の Node.js + SQLite）／ CLI（Ink）／ レポーター（bash、macOS/Linux/WSL2 のみ）

## 開発ワークフロー (release-workflow-template 導入)

このプロジェクトは Claude Code の Workflow tool (dynamic workflows) による 6 ステップのリリースサイクルを採用しています。

| #   | ステップ                   | 実体                                                                  |
| --- | -------------------------- | --------------------------------------------------------------------- |
| 1   | 要件壁打ち                 | `/refine-requirements` → `docs/releases/release-N/requirements.md`    |
| 2   | 実装 (探索→設計→実装→検証) | `Workflow({name: "implement-feature", args: {release: "release-N"}})` |
| 3   | 差分レビュー               | `Workflow({name: "review-changes"})`                                  |
| 4   | ドキュメント同期           | `Workflow({name: "sync-docs", args: {release: "release-N"}})`         |
| 5   | リリース前検査             | `Workflow({name: "release-check"})`                                   |
| 6   | 論理単位コミット           | `/logical-commits` (あれば)                                           |

ワークフローは `.claude/workflows/`、コマンドは `.claude/commands/` にある。要件は `docs/releases/release-N/requirements.md` に確定させてから実装に進むこと。
