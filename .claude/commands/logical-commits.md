# Logical Commits Command

変更されたファイルを分析して、論理的な単位でコミットを分割して作成します。

引数: `$ARGUMENTS`(`autoApprove=true` を指定するとコミット前のユーザー承認を省略する。省略時は `autoApprove=false`＝現行どおりコミット前のユーザー承認必須)

## 処理の流れ

1. `git status` で変更されたファイルを確認
2. `git diff` で変更内容を確認
3. ファイルを論理的な単位にグループ化
4. 各グループごとに適切なコミットメッセージを作成
5. **コミット案 (分け方 + メッセージ) をユーザーに提示して承認を待つ**(`autoApprove=true` のときは案の提示のみ行い、承認待ちを省略する)
6. **承認後にコミットを実行**

## コミットの分類基準

### 機能追加 (feat:)

- 新しいファイルの追加
- 新しい機能の実装
- 例: `feat: 一覧画面に検索フィルタを追加`

### リファクタリング (refactor:)

- 既存コードの改善・整理
- import文の変更
- ディレクトリ構造の変更
- 例: `refactor: 重複していた日付整形処理を共通関数に集約`

### ドキュメント (docs:)

- README、CLAUDE.md等のドキュメント更新
- コメントの追加・改善
- 例: `docs: CLAUDE.mdにコーディング規約を追加`

### 設定ファイル (chore:)

- package.json、tsconfig.json等の設定変更
- 依存関係の追加・更新
- 例: `chore: テストフレームワークの依存パッケージを追加`

## コミットメッセージの形式

```
<type>: <subject>

<body>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

- **type**: feat, refactor, docs, chore, fix など
- **subject**: 変更の概要（日本語、1行）
- **body**: 詳細な説明（必要に応じて）

## 実行

このコマンドを実行すると、Claude Code が自動的に:

- 変更ファイルを分析
- 論理的なグループに分類
- 適切なコミットメッセージを生成
- **コミット案を提示してユーザー承認を取得**(`autoApprove=true` のときは承認取得を省略)
- **承認後に順次コミットを作成**

各コミットは人間の開発者が理解しやすい単位で分割されます。

## 重要: ユーザー承認の取得

`autoApprove=false`(既定)では、commit 実行前に必ず以下をユーザーに見せて承認を取る:

- コミットの分け方 (何件に分けるか、各コミットに含めるファイル)
- 各コミットのメッセージ (type / subject / body)

承認の方法は `AskUserQuestion` または平文で「以下の内容で commit してよいですか?」
と尋ねる。「はい」「OK」「進めて」等の明示的な肯定があってから `git add` /
`git commit` を実行する。

CLAUDE.md の global rule (「Only create commits when requested by the user」)
との整合性を保つため、スキル経由の起動でも原則として自動 commit はしない。

**例外**: `run-release` ワークフローからの `autoApprove=true` 起動
(既定値は `config.automation.autoApprove`) は、ユーザーによるコミットの
一括承認とみなす。この場合は承認待ちを省略し、コミット案を提示したうえで
順次コミットを実行してよい。
