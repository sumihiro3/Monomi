export const meta = {
  name: 'sync-docs',
  description: '実装差分をドキュメント (README/architecture 等) に同期する',
  whenToUse: '実装・レビュー完了後のドキュメント同期。args: {base: "main", release: "release-1"} で差分の比較先と対象リリースを指定(いずれも省略可)',
  phases: [
    { title: '差分把握', detail: '変更内容の要約', model: 'sonnet' },
    { title: '同期', detail: 'ドキュメントを並列更新', model: 'sonnet/haiku' },
  ],
}

// モデル使い分けの方針: ドキュメント化 = sonnet / 軽量な更新 = haiku

// args は JSON 文字列で渡ってくる場合があるためパースする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    input = {}
  }
}
input = input || {}

const base = input.base || 'main'
const release = input.release || ''
const REPO = 'リポジトリは /opt/dev/Monomi。'

phase('差分把握')
const diffSummary = await agent(
  `${REPO}git diff ${base}... と git status / git diff(未コミット分)を確認し、今回の変更内容を要約してください: 追加・変更されたモジュール/機能、ユーザーに見える変更、開発環境の変更(依存関係・ビルドコマンド)。ドキュメント更新の判断材料になる粒度で。${release ? `対象リリース: ${release}` : ''}`,
  { label: '差分要約', phase: '差分把握', model: 'sonnet' }
)

// {PLACEHOLDER}: 同期先ドキュメントをプロジェクトに合わせて増減すること。
// Obsidian Vault 等の外部ノートを同期する場合は {VAULT_OVERVIEW_PATH} を実パスに置換 (不要なら該当ブロックごと削除)。
// docs/monomi-handoff.md は凍結済み(設計経緯の記録)のため同期対象外。docs/REQUIREMENTS.md も機能軸サマリーの安定性を優先し対象外(未解決事項として留保)。
phase('同期')
const updates = await parallel([
  () =>
    agent(
      `${REPO}以下の変更要約をもとに docs/ARCHITECTURE.md を実装に同期してください。乖離がなければ変更しないこと。\n\n## 変更要約\n${diffSummary}`,
      { label: 'architecture更新', phase: '同期', model: 'sonnet' }
    ),
  () =>
    agent(
      `${REPO}以下の変更要約をもとに README.md を同期してください。ユーザーに見える機能変更・セットアップ手順の変更のみ反映し、乖離がなければ変更しないこと。\n\n## 変更要約\n${diffSummary}`,
      { label: 'README更新', phase: '同期', model: 'sonnet' }
    ),
  () =>
    agent(
      `${REPO}以下の変更要約をもとに docs/design/class-diagram.md をクラス構成の実装差分に同期してください。乖離がなければ変更しないこと。\n\n## 変更要約\n${diffSummary}`,
      { label: 'class-diagram更新', phase: '同期', model: 'sonnet' }
    ),
])

return {
  diffSummary,
  updates,
}
