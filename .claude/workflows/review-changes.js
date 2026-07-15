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

// diffPathScope: args.diffPathScope を最優先、未指定(null/undefined)時は config.diffPathScope を既定、
// 両方 null/未指定なら全差分。文字列は単一要素配列に正規化する。
let diffPathScope = input.diffPathScope !== undefined && input.diffPathScope !== null
  ? input.diffPathScope
  : config.diffPathScope
if (typeof diffPathScope === 'string') {
  diffPathScope = [diffPathScope]
}
if (!Array.isArray(diffPathScope) || diffPathScope.length === 0) {
  diffPathScope = null
}

const DIFF = diffPathScope
  ? `カレント作業ディレクトリ(=リポジトリルート)でレビューする。レビュー対象は「${base} との差分 + 未コミットの変更」のうち、次のパスに限定する: ${diffPathScope.join(', ')}。git diff ${base}... -- ${diffPathScope.join(' ')} と、git status / git diff(未コミット分)も同じパスに絞って確認すること。`
  : `カレント作業ディレクトリ(=リポジトリルート)でレビューする。レビュー対象は「${base} との差分 + 未コミットの変更」。git diff ${base}... と git status / git diff で対象を確認すること。`

// Codex 連携の対象判定: config.codexReview.enabled かつ diffPathScope が null(全差分)のときのみ、
// 各次元のレビュープロンプトへ Codex 委譲手順を付与する。
// diffPathScope が非 null(モノレポの部分スコープ・Gate2 の絞り込み再レビュー)のときは付与しない
// (Codex CLI に --scope <path> 相当が存在せず、--base 比較も未コミット差分を含められないため)。
const codexEligible = Boolean(config.codexReview && config.codexReview.enabled === true) && diffPathScope === null

/** Codex 委譲手順(codexEligible のときのみプロンプトへ付与)。次元ごとの prompt を focus text として渡す。 */
function codexInstructions(d) {
  return `

---
## Codex 連携(任意・失敗時は自力レビューにフォールバック)

このマシンに OpenAI Codex CLI プラグイン(codex@<マーケットプレイス名>)が導入・認証済みであれば、このレビューの一次生成を Codex の adversarial-review へ委譲してよい。以下を順に行い、いずれかの段階で「利用不可・非対応・失敗」と判断した場合は、理由を詮索せず直ちにこの手順を中断し、このプロンプト冒頭の指示どおり自分自身で diff を読んでレビューすること(=今日までの挙動と同じ)。Codex 経由・自力どちらの経路でも、最終的に返す findings の形式は変わらない。

1. **作業ツリーがクリーンであること**を確認する: bash で \`git status --porcelain\` を実行し、出力が空であること。出力が空でない場合(未コミットの変更がある場合)、Codex の --base 比較は未コミット差分を含められないため、Codex 連携を行わず直ちに自力レビューへ進むこと。
2. Codex プラグインの導入ディレクトリを解決する:
   a. \`cat ~/.claude/settings.json\` 等で \`enabledPlugins\` を確認し、\`"codex@<マーケットプレイス名>": true\` の形のキーを探す(例: \`codex@openai-codex\`)。見つからなければ Codex 未導入とみなし自力レビューへ進む。
   b. 見つかったマーケットプレイス名を使い、\`ls -d ~/.claude/plugins/cache/<マーケットプレイス名>/codex/*/ 2>/dev/null | sort -V | tail -1\` でインストールディレクトリを得る(バージョンは環境により異なるためハードコード禁止)。ディレクトリが見つからない、または \`<ディレクトリ>/scripts/codex-companion.mjs\` が存在しない場合は Codex 未導入とみなし自力レビューへ進む。
3. \`node "<解決したディレクトリ>/scripts/codex-companion.mjs" setup --json\` を実行する。**この bash 呼び出しには明示的にタイムアウトを指定すること(目安 30000ms)**。終了コードが 0 以外、タイムアウトした、標準出力が JSON としてパースできない、または \`.ready !== true\` の場合は Codex 利用不可とみなし自力レビューへ進む。
4. 利用可能であれば、次元プロンプト(下記)をシェルのクォート崩れなく渡すため、bash のクォート付き heredoc で変数に読み込んでから渡すこと(例):
   \`\`\`bash
   FOCUS=$(cat <<'CODEX_FOCUS_EOF'
   ${d.prompt}
   CODEX_FOCUS_EOF
   )
   node "<解決したディレクトリ>/scripts/codex-companion.mjs" adversarial-review --json --base "${base}" "$FOCUS"
   \`\`\`
   (この呼び出しはバックグラウンド実行にせず、完了を待って同期的に扱うこと。--wait は付けなくてよい。このコマンドは Codex CLI の性質上、数十秒〜数分かかることがある。**bash 呼び出しに明示的にタイムアウトを指定すること(目安 600000ms、bash ツールの上限)**。Codex 側・ネットワーク側がハングし応答が返らない場合に、この工程全体が無期限にブロックされるのを防ぐため。)
   終了コードが 0 以外、タイムアウトした、標準出力が JSON としてパースできない、または \`.result\` が null もしくは \`.result.findings\` が配列でない場合は、Codex 呼び出し失敗(タイムアウトも失敗の一種として扱う)とみなし自力レビューへ進む。
5. 成功した場合、\`.result.findings\` の各要素(severity/title/body/file/line_start/line_end/confidence/recommendation を持つ)を、次の対応で findings の要素に変換する:
   - severity → そのまま
   - title → そのまま
   - file → line_start === line_end なら "<file>:<line_start>"、異なれば "<file>:<line_start>-<line_end>"
   - detail → body。recommendation があれば末尾に改行して「対応案: <recommendation>」を追記してよい
   さらに、この観点(「${d.prompt}」)に明確に無関係な所見(全く別の懸念領域を指すもの)は除外し、関連する所見のみを findings に残すこと(他の観点の呼び出しで別途拾われるため、除外してよい)。
6. この手順を実際に使って findings を得た場合、返り値のトップレベルに engine: "codex" を含めること。1〜4 のいずれかで中断し自力レビューへ切り替えた場合は engine: "claude" を含めること。`
}

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
    engine: {
      type: 'string',
      enum: ['claude', 'codex'],
      description: 'この次元の一次所見を生成したエンジン。Codex 連携が無効・非対象・フォールバックした場合は claude',
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
    agent(`${DIFF}\n${d.prompt}${codexEligible ? codexInstructions(d) : ''}`, {
      label: `review:${d.key}`,
      phase: 'レビュー',
      schema: FINDINGS_SCHEMA,
      model: reviewModel,
    }),
  (review, d) => {
    // レビューエージェントが null(失敗・スキップ)を返した次元は throw せず「検証不能」として扱う
    if (!review || !Array.isArray(review.findings)) {
      return { dimension: d.key, ran: false, findings: [], verified: [], engine: null }
    }
    // engine は Codex 連携が対象外・未指定・不正値のときは claude 扱い(既定挙動と同じ)
    const engine = review.engine === 'codex' ? 'codex' : 'claude'
    return parallel(
      review.findings.map(
        f => () =>
          agent(
            `カレントリポジトリで次のレビュー所見を敵対的に検証してください。コードを実際に読み、所見が誤りである可能性を積極的に探すこと。誤検出と思われる場合や再現根拠が弱い場合は isReal: false にすること。\n\n## 所見(${d.key})\n${f.title}\n対象: ${f.file}\n${f.detail}`,
            { label: `verify:${f.file}`, phase: '検証', schema: VERDICT_SCHEMA, model: verifyModel }
          ).then(v => ({ ...f, dimension: d.key, verdict: v }))
      )
    ).then(verified => ({ dimension: d.key, ran: true, findings: review.findings, verified, engine }))
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
        engine: r.engine,
      })
    }
    // isReal: false は誤検出として意図的に破棄する
  })
})

const codexUsedCount = codexEligible
  ? DIMENSIONS.reduce((acc, d, i) => acc + (results && results[i] && results[i].engine === 'codex' ? 1 : 0), 0)
  : 0
log(
  `確定所見: ${confirmed.length} 件 / 検証不能: ${unverifiable.length} 件 / 実行次元: ${dimensionsRun.length}/${DIMENSIONS.length}` +
    (codexEligible ? ` / Codex使用: ${codexUsedCount}/${DIMENSIONS.length}次元` : '')
)

return {
  confirmed,
  unverifiable,
  dimensionsRun,
  diffPathScope,
  summary:
    (confirmed.length === 0
      ? '確定した所見はありません'
      : `severity 順に対応を検討してください(${confirmed.length} 件)`) +
    (unverifiable.length > 0 ? `。検証不能 ${unverifiable.length} 件あり(内容は unverifiable を参照)` : ''),
}
