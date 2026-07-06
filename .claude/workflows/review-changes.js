export const meta = {
  name: 'review-changes',
  description: '差分を複数次元で並列レビューし、敵対的検証を通った所見のみ報告',
  whenToUse:
    '実装後の差分レビュー。args: {base: "main"} で比較先ブランチを指定(省略時は config.baseBranch)、{config: {...}} で workflow config を直接渡せる。未コミット変更も含めてレビューする',
  phases: [
    { title: '準備', detail: 'workflow config の読み込み' },
    { title: 'レビュー', detail: '複数次元の並列レビュー' },
    { title: '検証', detail: '所見ごとの敵対的検証' },
  ],
}

// モデル使い分けの方針: レビュー = config.models.review / 敵対的検証 = config.models.verify。
//
// 'opus' 等のティア名エイリアスは Anthropic API では最新版に解決されるため、
// 特定バージョンに固定したい場合は config にエイリアスではなく完全なモデル名を指定する
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

phase('準備')

// config ブートストラップ: args.config を優先し、未指定時は .claude/workflow.config.json をエージェント経由で読む
let config = input.config
if (!config) {
  const loaded = await agent(
    'カレントリポジトリの .claude/workflow.config.json を読んでください。存在すれば {exists: true, config: <ファイル内容そのまま>} を、無ければ {exists: false} を返すこと。内容の要約・省略・補完は禁止。',
    {
      label: 'config-bootstrap',
      phase: '準備',
      schema: {
        type: 'object',
        required: ['exists'],
        properties: {
          exists: { type: 'boolean' },
          config: { type: 'object' },
        },
      },
      model: 'haiku',
    }
  )
  if (!loaded || loaded.exists === false || !loaded.config) {
    throw new Error(
      'workflow.config.json が読めません。args.config を渡すか .claude/workflow.config.json を作成してください'
    )
  }
  config = loaded.config
}
if (config.configVersion !== 1) {
  throw new Error(
    `workflow.config.json の configVersion がエンジン要求版と一致しません (要求: 1, 実際: ${config.configVersion})`
  )
}

// レビュー次元は config.reviewDimensions から取得する(観点の増減はプロジェクト側の config で行う)
const DIMENSIONS = Array.isArray(config.reviewDimensions) ? config.reviewDimensions : []
if (DIMENSIONS.length === 0) {
  throw new Error('config.reviewDimensions が空です。レビュー次元を workflow.config.json に定義してください')
}

const reviewModel = config.models && config.models.review
const verifyModel = config.models && config.models.verify
if (!reviewModel || !verifyModel) {
  throw new Error('config.models.review / config.models.verify が未定義です')
}

const base = input.base || config.baseBranch || 'main'
const DIFF = `カレント作業ディレクトリ(=リポジトリルート)でレビューする。レビュー対象は「${base} との差分 + 未コミットの変更」。git diff ${base}... と git status / git diff で対象を確認すること。`

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

phase('レビュー')
const results = await pipeline(
  DIMENSIONS,
  d =>
    agent(`${DIFF}\n${d.prompt}`, {
      label: `review:${d.key}`,
      phase: 'レビュー',
      schema: FINDINGS_SCHEMA,
      model: reviewModel,
    }),
  (review, d) => {
    // レビューエージェントが null(失敗・スキップ)を返した次元は throw せず「検証不能」として扱う
    if (!review || !Array.isArray(review.findings)) {
      return { dimension: d.key, ran: false, findings: [], verified: [] }
    }
    return parallel(
      review.findings.map(
        f => () =>
          agent(
            `カレントリポジトリで次のレビュー所見を敵対的に検証してください。コードを実際に読み、所見が誤りである可能性を積極的に探すこと。誤検出と思われる場合や再現根拠が弱い場合は isReal: false にすること。\n\n## 所見(${d.key})\n${f.title}\n対象: ${f.file}\n${f.detail}`,
            { label: `verify:${f.file}`, phase: '検証', schema: VERDICT_SCHEMA, model: verifyModel }
          ).then(v => ({ ...f, dimension: d.key, verdict: v }))
      )
    ).then(verified => ({ dimension: d.key, ran: true, findings: review.findings, verified }))
  }
)

// filter(Boolean) によるサイレント消失はさせない:
// 欠落した次元・検証エージェントが結果を返さなかった所見は unverifiable として明示報告する
const confirmed = []
const unverifiable = []
const dimensionsRun = []

DIMENSIONS.forEach((d, i) => {
  const r = results && results[i]
  if (!r || r.ran === false) {
    unverifiable.push({
      dimension: d.key,
      reason: 'この次元のレビューエージェントが結果を返さなかったため検証不能(再実行を推奨)',
    })
    return
  }
  dimensionsRun.push(d.key)
  r.verified.forEach((entry, j) => {
    const f = r.findings[j] || {}
    if (!entry || !entry.verdict) {
      unverifiable.push({
        dimension: d.key,
        reason: `所見「${f.title || '(タイトル不明)'}」(${f.file || '対象不明'}) の敵対的検証エージェントが結果を返さなかった`,
      })
      return
    }
    if (entry.verdict.isReal) {
      confirmed.push({
        dimension: entry.dimension,
        severity: entry.severity,
        title: entry.title,
        file: entry.file,
        detail: entry.detail,
        verifiedReason: entry.verdict.reason,
      })
    }
    // isReal: false は誤検出として意図的に破棄する
  })
})

log(
  `確定所見: ${confirmed.length} 件 / 検証不能: ${unverifiable.length} 件 / 実行次元: ${dimensionsRun.length}/${DIMENSIONS.length}`
)

return {
  confirmed,
  unverifiable,
  dimensionsRun,
  summary:
    (confirmed.length === 0
      ? '確定した所見はありません'
      : `severity 順に対応を検討してください(${confirmed.length} 件)`) +
    (unverifiable.length > 0 ? `。検証不能 ${unverifiable.length} 件あり(内容は unverifiable を参照)` : ''),
}
