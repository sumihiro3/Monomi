# Monomi

複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PRレビュー待ち／放置）を横断確認できる CLI ダッシュボード。

- 設計の権威仕様: `monomi-handoff.md`（§0 が実装前レビューで確定した最新仕様。以降の節と食い違う場合は §0 優先）
- クラス設計: `docs/design/class-diagram.md`
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
