export const meta = {
  name: 'review-changes',
  description: '差分を複数次元で並列レビューし、敵対的検証を通った所見のみ報告',
  whenToUse: '実装後の差分レビュー。args: {base: "main"} で比較先ブランチを指定(省略時は main)。未コミット変更も含めてレビューする',
  phases: [
    { title: 'レビュー', detail: '複数次元の並列レビュー', model: 'claude-opus-4-6' },
    { title: '検証', detail: '所見ごとの敵対的検証', model: 'sonnet' },
  ],
}

// モデル使い分けの方針: 複雑なレビュー = Opus 4.6(claude-opus-4-6、バージョン固定) / 敵対的検証 = sonnet
//
// 'opus' エイリアスは Anthropic API では最新版(現状 Opus 4.8)に解決されるため、
// 特定バージョンに固定したい場合はエイリアスではなく完全なモデル名を直接指定する
// (https://code.claude.com/docs/ja/model-config#pin-models-for-third-party-deployments)。

// args は JSON 文字列で渡ってくる場合があるためパースする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    input = { base: input }
  }
}
input = input || {}

const base = input.base || 'main'
const DIFF = `リポジトリは /opt/dev/Monomi。レビュー対象は「${base} との差分 + 未コミットの変更」。git diff ${base}... と git status / git diff で対象を確認すること。`

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'detail', 'severity'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'file:line 形式' },
          detail: { type: 'string', description: '問題の内容と根拠' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean', description: '実在する問題なら true' },
    reason: { type: 'string' },
  },
}

// {PLACEHOLDER}: プロジェクトの性質・層構成に応じて次元を増減すること (例: i18n, a11y, cost)。
// 複数層/複数言語のプロジェクトでは、層ごとに観点を分けてもよい
// (例: 'backend-security' で Rust/Go 側、'frontend-a11y' で UI 側を別次元にする)。
const DIMENSIONS = [
  {
    key: 'bugs',
    prompt: `${DIFF}\n正確性のレビュー: ロジックバグ、エラーハンドリング漏れ、境界条件、非同期処理の誤用を探してください。確信度の高いものだけ報告すること。`,
  },
  {
    key: 'perf',
    prompt: `${DIFF}\n性能のレビュー: 不要な再計算・再レンダリング、N+1 的なアクセス、大きなデータの無駄なコピー、ブロッキング処理を探してください。実害のあるものだけ報告すること。`,
  },
  {
    key: 'arch',
    prompt: `${DIFF}\nアーキテクチャ規約のレビュー: docs/ARCHITECTURE.md を読み、規約違反(責務分離、命名規則、型安全性など)を探してください。`,
  },
  {
    key: 'security',
    prompt: `${DIFF}\nセキュリティのレビュー: 入力バリデーション漏れ、機密情報のログ出力、権限チェック漏れを探してください。`,
  },
]

phase('レビュー')
const results = await pipeline(
  DIMENSIONS,
  d =>
    agent(d.prompt, {
      label: `review:${d.key}`,
      phase: 'レビュー',
      schema: FINDINGS_SCHEMA,
      model: 'claude-opus-4-6',
    }),
  (review, d) =>
    parallel(
      review.findings.map(
        f => () =>
          agent(
            `リポジトリ /opt/dev/Monomi で次のレビュー所見を敵対的に検証してください。コードを実際に読み、所見が誤りである可能性を積極的に探すこと。誤検出と思われる場合や再現根拠が弱い場合は isReal: false にすること。\n\n## 所見(${d.key})\n${f.title}\n対象: ${f.file}\n${f.detail}`,
            { label: `verify:${f.file}`, phase: '検証', schema: VERDICT_SCHEMA, model: 'sonnet' }
          ).then(v => ({ ...f, dimension: d.key, verdict: v }))
      )
    )
)

const confirmed = results
  .filter(Boolean)
  .flat()
  .filter(Boolean)
  .filter(f => f.verdict && f.verdict.isReal)

log(`確定所見: ${confirmed.length} 件`)

return {
  confirmed: confirmed.map(f => ({
    dimension: f.dimension,
    severity: f.severity,
    title: f.title,
    file: f.file,
    detail: f.detail,
    verifiedReason: f.verdict.reason,
  })),
  summary:
    confirmed.length === 0
      ? '確定した所見はありません'
      : `severity 順に対応を検討してください(${confirmed.length} 件)`,
}
