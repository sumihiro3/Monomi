export const meta = {
  name: 'record-known-issues',
  description: 'レビュー・検査の未対応所見を既知課題ドキュメントへ逐次起票する',
  whenToUse:
    'run-release の triage 工程、または手動で未対応所見をバックログ化するとき。args: {config, findings: [{source: "review"|"check", dimension?, checkKey?, severity, title, file?, detail}]}',
  phases: [
    { title: '設定読み込み', detail: 'workflow.config.json の取得と検証' },
    { title: '起票', detail: '単一エージェントが既知課題ドキュメントへ逐次採番・追記' },
  ],
}

// モデル使い分けの方針: 既知課題ドキュメントの読解・採番・追記 = 文書編集タスクなので docSync モデルを流用。
//
// 採番の一貫性を保つため、起票は単一エージェントによる逐次処理とする(並列採番による ID 衝突の禁止)。
// 起票日は Workflow スクリプト内で Date が使えないため、エージェントが bash の date コマンドで取得する。

// args は JSON 文字列で渡ってくる場合があるためパースする(失敗は握り潰さず明示エラー)
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error(`record-known-issues の args を JSON としてパースできません: ${e.message}`)
  }
}
input = input || {}

phase('設定読み込み')

// config ブートストラップ: args.config を優先し、未指定時は .claude/workflow.config.json をエージェント経由で読む
let config = input.config
if (!config) {
  const loaded = await agent(
    'カレントリポジトリの .claude/workflow.config.json を読んでください。存在すれば {exists: true, config: <ファイル内容そのまま>} を、無ければ {exists: false} を返すこと。内容の要約・省略・補完は禁止。',
    {
      label: 'config-bootstrap',
      phase: '設定読み込み',
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

const knownIssues = config.knownIssues
if (!knownIssues || typeof knownIssues.path !== 'string' || knownIssues.path.length === 0) {
  throw new Error('config.knownIssues.path が未定義です。workflow.config.json に knownIssues 節を定義してください')
}
const issuesPath = knownIssues.path
const categoryMap = knownIssues.categoryMap && typeof knownIssues.categoryMap === 'object' ? knownIssues.categoryMap : {}
const defaultCategory = typeof knownIssues.defaultCategory === 'string' ? knownIssues.defaultCategory : 'N'

// 所見の検証と正規化。カテゴリ接頭辞の決定は決定的な処理なのでスクリプト側で行う
// (review 由来 → dimension、check 由来 → "check:<checkKey>" を categoryMap で引き、マップ外は defaultCategory)
const rawFindings = input.findings == null ? [] : input.findings
if (!Array.isArray(rawFindings)) {
  throw new Error('args.findings は配列で渡してください')
}

if (rawFindings.length === 0) {
  log('起票対象の所見がありません — 何も変更せず終了します')
  return { filed: [], appendedTo: [], resolvedLogProposal: null }
}

const findings = rawFindings.map((f, i) => {
  const mapKey = f.source === 'check' ? `check:${f.checkKey ?? ''}` : (f.dimension ?? '')
  const category = Object.prototype.hasOwnProperty.call(categoryMap, mapKey) ? categoryMap[mapKey] : defaultCategory
  return {
    index: i + 1,
    category,
    source: f.source === 'check' ? `check:${f.checkKey ?? '(不明)'}` : `review:${f.dimension ?? '(不明)'}`,
    severity: f.severity ?? '(未指定)',
    title: f.title ?? '(タイトル不明)',
    file: f.file ?? null,
    detail: f.detail ?? '',
  }
})

phase('起票')

const RESULT_SCHEMA = {
  type: 'object',
  required: ['filed', 'appendedTo', 'resolvedLogProposal'],
  properties: {
    filed: {
      type: 'array',
      description: '新規起票した項目',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: {
          id: { type: 'string', description: '採番した ID (例: B9)' },
          title: { type: 'string' },
        },
      },
    },
    appendedTo: {
      type: 'array',
      description: '重複照合により既存項目へ追記した先の項目',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: {
          id: { type: 'string', description: '追記先の既存 ID' },
          title: { type: 'string', description: '追記先の既存タイトル' },
        },
      },
    },
    resolvedLogProposal: {
      type: ['string', 'null'],
      description: '解決済みログへの移動提案 (unified diff 形式のテキスト)。提案が無ければ null',
    },
  },
}

const recordModel = config.models?.docSync ?? 'sonnet'
const result = await agent(
  `既知課題ドキュメント ${issuesPath} に、以下の所見一覧を起票してください。作業はカレント作業ディレクトリ(=リポジトリルート)で行い、編集してよいファイルは ${issuesPath} のみです。

## 手順(必ずこの順で、所見を1件ずつ逐次処理すること。並列化・一括採番は禁止)

1. bash で \`date '+%Y-%m-%d'\` を実行し、結果を起票日として使う。
2. ${issuesPath} を全文読む。「未解決（バックログ）」と「解決済みログ」の2部構成になっている。既存項目の記法(見出し・bullet の書き方)を観察し、以降の追記はそれに合わせること。
3. 所見一覧を index 順に1件ずつ処理する:
   a. **重複照合**: 未解決セクションの既存項目(この実行で自分が直前に起票した項目も含む)に、同一ファイル・同一現象を指す項目があれば、新規起票せずその項目の bullet 末尾に追記するに留める(例: \`- 追記(<起票日>, severity: <severity>, <source> 由来): <今回の所見の要点>\`)。追記した先は appendedTo に {id, title} で記録する。場所が同じでも現象が別なら重複ではない。
   b. **新規起票**: 重複が無ければ、所見に指定されたカテゴリ接頭辞(category)の既存 ID を「未解決（バックログ）」と「解決済みログ」の**両セクションから**走査し(同一カテゴリの ID が両セクションに分散しているため)、最大番号 + 1 を新 ID とする。この実行内で自分が直前に採番した ID も走査対象に含め、連番を衝突させないこと。
4. 新規起票は「未解決（バックログ）」セクションの末尾(「## 解決済みログ」見出しの直前)に、次の形式で追記する:

\`\`\`markdown
### <category><番号>. <タイトル>

- severity: <severity>（<source> 由来、起票日: <起票日>）
- 場所: <file>（file が null の場合は「該当なし」とし、detail から関連ファイルが分かれば「関連: ...」を添える）
- 現象: <detail を基にした事実の記述>
- 対応方針: <detail から対応案が読み取れればそれを書く。読み取れなければ「未検討、要壁打ち」>
\`\`\`

   起票した項目は filed に {id, title} で記録する。
5. **解決済みログへの移動提案**: 照合の過程で、既存の未解決項目がすでに解決済みと確認できる明確な根拠(コード上の実装済み証跡など)を得た場合のみ、その項目を解決済みログの表へ移す変更案を unified diff 形式のテキストとして resolvedLogProposal に返す。**移動をファイルへ反映することは絶対に禁止**(提案のみ)。該当が無ければ null を返す。

## 制約

- ${issuesPath} 以外のファイルを変更しないこと
- 既存項目の削除・並べ替え・書き換えをしないこと(重複照合による bullet 追記と、未解決セクション末尾への新規追記のみ)
- 所見の内容を要約で歪めないこと(detail の事実関係を保つ)

## 所見一覧

${JSON.stringify(findings, null, 2)}`,
  {
    label: 'known-issues起票',
    phase: '起票',
    schema: RESULT_SCHEMA,
    model: recordModel,
  }
)

if (!result) {
  throw new Error(
    `known-issues 起票エージェントが結果を返しませんでした。${issuesPath} の状態を確認してから再実行してください`
  )
}

// 戻り値契約 {filed, appendedTo, resolvedLogProposal} に正規化する
const filed = Array.isArray(result.filed)
  ? result.filed.map(e => ({ id: String(e?.id ?? ''), title: String(e?.title ?? '') }))
  : []
const appendedTo = Array.isArray(result.appendedTo)
  ? result.appendedTo.map(e => ({ id: String(e?.id ?? ''), title: String(e?.title ?? '') }))
  : []
const resolvedLogProposal =
  typeof result.resolvedLogProposal === 'string' && result.resolvedLogProposal.trim().length > 0
    ? result.resolvedLogProposal
    : null

log(
  `新規起票: ${filed.length} 件 / 既存へ追記: ${appendedTo.length} 件 / 解決済みログ移動提案: ${resolvedLogProposal ? 'あり' : 'なし'}`
)

return { filed, appendedTo, resolvedLogProposal }
