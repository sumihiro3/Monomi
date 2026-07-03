export const meta = {
  name: 'implement-feature',
  description: 'リリース要件を入力に、探索→設計→実装→検証を行う機能実装パイプライン',
  whenToUse:
    '確定済み要件 (docs/releases/release-N/requirements.md) を実装するとき。args: {release: "release-1"} でリリース指定、または {task: "..."} で単発タスク指定。スコープを絞る場合は {scope: "..."} を併用',
  phases: [
    { title: '探索', detail: '要件と関連コードの並列調査', model: 'haiku/sonnet' },
    { title: '設計', detail: '実装計画と作業項目への分解', model: 'opus' },
    {
      title: '実装',
      detail: '作業項目を順に実装(ファイル競合を避けるため逐次)',
      model: 'haiku/sonnet/opus(複雑度スコアで決定)',
    },
    { title: '検証', detail: 'release-check ワークフローをネスト実行', model: 'haiku' },
  ],
}

// モデル使い分けの方針: 要件・設計 = opus / 実装 = 複雑度スコアに応じて haiku・sonnet・opus / 検証 = haiku
//
// 実装フェーズのモデル割当は複雑度スコア(1-10、設計フェーズが作業項目ごとに採点)を
// 2つの閾値で3段に分ける。閾値を変えるだけで sonnet の担当範囲を調整できる。
// HAIKU_MAX_COMPLEXITY 以下 → haiku、OPUS_MIN_COMPLEXITY 以上 → opus、
// その間(既定 3-8 の6段階、10段中最も広い帯)は sonnet。opus は「本当に難しい9-10」だけに絞り、
// sonnet の担当範囲を広めにする方針(Sonnet 5 は Opus 4.8 と遜色ないため)。
const HAIKU_MAX_COMPLEXITY = 2
const OPUS_MIN_COMPLEXITY = 9

/**
 * 複雑度スコア(1-10)から実装フェーズのモデルを決める。
 *
 * @param score 設計フェーズが採点した複雑度(1-10)。
 * @returns 'haiku' | 'sonnet' | 'opus'。
 */
function modelForComplexity(score) {
  if (score <= HAIKU_MAX_COMPLEXITY) return 'haiku'
  if (score >= OPUS_MIN_COMPLEXITY) return 'opus'
  return 'sonnet'
}

// args は JSON 文字列で渡ってくる場合があるためパースする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    input = { task: input }
  }
}
input = input || {}

const release = input.release
const taskDesc = input.task || ''
const scope = input.scope || ''
if (!release && !taskDesc) {
  throw new Error('args.release(例: {release: "release-1"})または args.task を指定してください')
}
const reqPath = release ? `docs/releases/${release}/requirements.md` : null
const target = reqPath
  ? `要件ファイル ${reqPath}${scope ? `(今回のスコープ: ${scope})` : ''}`
  : `タスク: ${taskDesc}`

// {PLACEHOLDER}: プロジェクトの規約ドキュメントに置き換えること。
// ARCHITECTURE.md は単一ファイルでも、複数層構成なら「docs/architecture/backend.md と
// docs/architecture/frontend.md」のように複数パスを列挙してもよい。
const RULES = 'リポジトリは /opt/dev/Monomi。CLAUDE.md と ARCHITECTURE.md の規約に従うこと。'

phase('探索')
const [reqSummary, codeMap] = await parallel([
  () =>
    agent(
      `${RULES}\n${target} と CLAUDE.md を読み、実装すべき要件の要点を返してください: 機能要件(受け入れ基準つき)、スコープ外、未解決事項。原文の構造を保ち簡潔に。`,
      { label: '要件読込', phase: '探索', model: 'haiku' }
    ),
  () =>
    agent(
      `${RULES}\n${target} に関連する既存コードを調査してください。関連ファイルパス、既存パターン、再利用できる実装、変更が必要になりそうな箇所を報告してください。`,
      { label: 'コード調査', phase: '探索', agentType: 'Explore', model: 'sonnet' }
    ),
])

phase('設計')
const DESIGN_SCHEMA = {
  type: 'object',
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string', description: '実装方針の要約' },
    items: {
      type: 'array',
      description: '実装順に並べた作業項目',
      items: {
        type: 'object',
        required: ['title', 'description', 'files', 'complexity'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string', description: '変更内容と完了条件' },
          files: { type: 'array', items: { type: 'string' }, description: '触る予定のファイル' },
          complexity: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description:
              '実装の複雑度(1-10、実装に割り当てるモデルの強さを決める採点)。' +
              '次の3観点を総合して採点すること: ' +
              '(a) 新規設計判断の有無(既存パターンの単純適用か、新しい抽象・状態管理・並行制御の設計が要るか)、' +
              '(b) 変更範囲(単一ファイルの局所変更か、複数レイヤーにまたがる契約変更か)、' +
              '(c) バグ混入リスク(機械的な値変更か、境界値・タイミング・レイアウト計算等が絡むか)。' +
              '目安 — 1-3: 機械的な置換・定数値の変更・定型パターンのそのままの適用' +
              '(例: 設定値の変更、footer文言の追加、既存コンポーネントへの1行のprops追加)。' +
              '4-7: 典型的な実装(既存パターンの組み合わせ・中程度の分岐、大半の作業項目はここ)' +
              '(例: 既存コンポーネントと同じ設計で新規UIコンポーネントを1つ追加する)。' +
              '8-10: 新規のアーキテクチャ判断・複雑な状態管理・レイアウト計算等の新規ロジック・' +
              '既存規約からの逸脱を伴う判断' +
              '(例: ポーリング機構のジェネリック化、スクロール位置とtail-follow挙動の状態設計、' +
              '枠線へのタイトル埋め込みの文字数計算)。',
          },
        },
      },
    },
  },
}
const design = await agent(
  `${RULES}\n以下の要件と現状調査をもとに実装計画を設計し、実装順に並べた作業項目に分解してください。各項目は独立して検証できる粒度にすること。依存関係がある場合は、依存される側を先に並べること。\n\n## 要件\n${reqSummary}\n\n## 現状調査\n${codeMap}`,
  { label: '設計', phase: '設計', schema: DESIGN_SCHEMA, model: 'opus' }
)
log(`設計完了: ${design.items.length} 作業項目`)

phase('実装')
const results = []
for (let i = 0; i < design.items.length; i++) {
  const item = design.items[i]
  const model = modelForComplexity(item.complexity)
  log(`実装 ${i + 1}/${design.items.length}: ${item.title} (複雑度 ${item.complexity} → ${model})`)
  const r = await agent(
    `${RULES}\n次の作業項目を実装してください。実装後、変更したファイル一覧と判断に迷った点を報告してください。テストが必要な変更は同時に書くこと。\n\n## 実装方針(全体)\n${design.summary}\n\n## 作業項目\n${item.title}\n${item.description}\n対象ファイル目安: ${item.files.join(', ')}\n\n## 要件(参照用)\n${reqSummary}`,
    { label: `実装: ${item.title}`, phase: '実装', model }
  )
  results.push({ item: item.title, complexity: item.complexity, model, report: r })
}

phase('検証')
const verify = await workflow('release-check')

return {
  design: design.summary,
  implemented: results.map(r => r.item),
  reports: results,
  verification: verify,
  next: 'review-changes ワークフローで差分レビューを実施してください',
}
