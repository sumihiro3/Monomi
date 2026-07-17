export const meta = {
  name: 'review-changes',
  description: '差分を複数次元で並列レビューし、敵対的検証を通った所見のみ報告',
  whenToUse:
    '実装後の差分レビュー。args: {base: "main"} で比較先ブランチを指定(省略時は config.baseBranch)、{config: {...}} で workflow config を直接渡せる。未コミット変更も含めてレビューする',
  phases: [
    { title: '準備', detail: 'workflow config の読み込みと Codex 利用可否の検出' },
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

// Codex 連携の対象判定: config.codexReview.enabled かつ diffPathScope が null(全差分)のときのみ。
// diffPathScope が非 null(モノレポの部分スコープ・Gate2 の絞り込み再レビュー)のときは対象外
// (Codex CLI に --scope <path> 相当が存在しないため)。
const codexEligible = Boolean(config.codexReview && config.codexReview.enabled === true) && diffPathScope === null

// Codex 利用可否の検出は準備フェーズの専用エージェント 1 回に集約する。従来は各次元プロンプト末尾の
// 任意手順だったため、(1)「作業ツリーがクリーン」前提により、コミットが最終工程まで発生しない
// run-release Gate2 では構造的に一度も Codex が使われず、(2) 任意のため各エージェントが正当に
// スキップでき、(3) 未試行と試行失敗が区別できなかった。検出失敗・利用不可は全次元自力レビューへの
// フォールバックであってエラーではない。
let codexDetect = null
if (codexEligible) {
  codexDetect = await agent(
    'OpenAI Codex CLI プラグインの利用可否を機械的に検出してください。読み取りと setup 実行のみで、リポジトリ・設定への変更は一切禁止。以下の手順の各コマンドは必ず実際に bash で実行し、実行していないコマンドの結果を推測・補完してはならない。手順:\n' +
      '0. Claude Code の設定ディレクトリは環境変数で切り替わる場合があるため、以降のパスは必ず bash の `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` 展開で解決すること(未設定なら ~/.claude)\n' +
      '1. `cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"` の enabledPlugins に "codex@<マーケットプレイス名>": true 形式のキーを探す(マーケットプレイス名は環境により異なるため固定文字列で照合しない)。無ければ {available: false, reason: "プラグイン未導入"} で終了\n' +
      '2. `cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json"` の plugins["codex@<マーケットプレイス名>"] から installPath を得る(値が配列なら最初の要素の installPath)。ファイルが無い・読めない・エントリが無い場合は `ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/<マーケットプレイス名>/codex/"*/ 2>/dev/null | sort -V | tail -1` で代替する。どちらでも得られなければ {available: false, reason: "インストールディレクトリ不明"}\n' +
      '3. <installPath>/scripts/codex-companion.mjs の存在を確認する。無ければ {available: false, reason: "codex-companion.mjs 不在"}\n' +
      '4. `node "<installPath>/scripts/codex-companion.mjs" setup --json` を実行する(この bash 呼び出しには明示的にタイムアウトを指定すること。目安 30000ms)。終了コード 0 かつ標準出力 JSON の .ready === true なら available: true、それ以外(タイムアウト・パース不能含む)は available: false とし reason に失敗内容を書く\n' +
      '5. `git status --porcelain` を実行し、出力が空でなければ treeDirty: true、空なら treeDirty: false を必ず報告する\n' +
      `6. \`git merge-base ${base} HEAD\` を実行する(失敗したら \`git merge-base origin/${base} HEAD\` も試す)。いずれか成功したら、そのコミットを <MB> として \`git log --oneline <MB>..HEAD\` の出力が空でなければ branchState: "ahead"、空なら branchState: "none" を必ず報告する。merge-base がどちらも失敗した場合は branchState: "unknown" とする(「先行コミット無し」と「判定不能」を混同しないこと)。branchState はこの手順のコマンド結果のみから決定すること — 現在のブランチ名や origin との ahead/behind 表示(git status 等)から推測してはならない\n` +
      'available: true の場合は companionPath に codex-companion.mjs の絶対パスを返すこと。',
    {
      label: 'codex検出',
      phase: '準備',
      schema: {
        type: 'object',
        required: ['available', 'treeDirty', 'branchState', 'reason'],
        properties: {
          available: { type: 'boolean' },
          companionPath: { type: 'string' },
          treeDirty: { type: 'boolean' },
          branchState: { type: 'string', enum: ['ahead', 'none', 'unknown'] },
          reason: { type: 'string' },
        },
      },
      // 機械タスクだが haiku ではなく sonnet を使う: branchState の誤報告は片側差分の静かな
      // 脱落(偽グリーン)に直結するため。実測で haiku は手順 6 を実行せず、git status の
      // 「origin より N commits ahead」表示を流用して branchState を捏造した
      model: 'sonnet',
    }
  )
}
// branchState は「base より先行したコミットが有る(ahead)/無い(none)/判定できない(unknown)」の
// 3 値。unknown(merge-base 解決失敗: shallow clone・base 未フェッチ・一時的な git エラー等)を
// none と混同すると、dirty ツリーで working-tree 単独モードが選ばれてコミット済み差分が
// レビューされないまま素通りするため、unknown は委譲不可として全次元自力レビューへ倒す
const codexBranchState =
  codexDetect && ['ahead', 'none', 'unknown'].includes(codexDetect.branchState)
    ? codexDetect.branchState
    : 'unknown'
const codexAvailable = Boolean(
  codexDetect &&
    codexDetect.available === true &&
    typeof codexDetect.companionPath === 'string' &&
    codexDetect.companionPath.length > 0 &&
    codexBranchState !== 'unknown'
)
/** codexEligible なのに委譲しない場合の理由(log と戻り値の両方で使う)。利用可能時は null。 */
const codexUnavailableReason = codexAvailable
  ? null
  : !codexDetect
    ? '検出エージェントが結果を返しませんでした'
    : codexDetect.available !== true ||
        typeof codexDetect.companionPath !== 'string' ||
        codexDetect.companionPath.length === 0
      ? codexDetect.reason || '利用不可'
      : `base(${base}) との merge-base が解決できず、コミット済み差分の有無を判定できません`
// モード決定はエンジン側 JS で行う。companion の working-tree モードは未コミット差分のみ、
// --base モードは merge-base 起点のコミット済み差分のみを見る排他仕様で、両方を 1 回で
// カバーする呼び出しは存在しない(--base 指定は --scope より優先されるため併記も不可。
// --scope auto はクリーン時に config.baseBranch ではなく main/master/trunk を自動検出するため
// 使わない)。レビュー契約は「base との差分 + 未コミットの変更」の両方なので、両者が併存する
// 場合(dirty かつ base より先行コミットあり)は両モードを 1 コマンドずつ実行して所見を統合する
// 「both」にする。片側しか無ければそのモードのみ:
//   dirty && ahead → both / dirty && none → working-tree / クリーン → base
// treeDirty・branchState をスキーマ required にしているのは偽グリーン防止: 不明のまま片側
// モードを選ぶと、もう片側の差分が所見ゼロのままレビューを素通りするため、フィールド欠落は
// 検出失敗(codexDetect = null)、branchState: "unknown" は委譲不可 → いずれも自力レビューへ倒す
const codexMode = codexAvailable
  ? codexDetect.treeDirty === true
    ? codexBranchState === 'ahead'
      ? 'both'
      : 'working-tree'
    : 'base'
  : null
if (codexEligible) {
  const modeLabel =
    codexMode === 'both'
      ? `併用モード(作業ツリー差分 + ブランチ差分 base: ${base})`
      : codexMode === 'working-tree'
        ? '作業ツリー差分モード'
        : `ブランチ差分モード(base: ${base})`
  log(
    codexAvailable
      ? `Codex 検出: 利用可能(${modeLabel})`
      : `Codex 検出: 利用不可 — 全次元とも自力レビュー(理由: ${codexUnavailableReason})`
  )
}

/** Codex 委譲手順(検出で利用可能と判定された場合のみ次元プロンプトへ付与)。d.prompt を focus text として渡す。 */
function codexInstructions(d) {
  const wtCmd = `node "${codexDetect.companionPath}" adversarial-review --json --scope working-tree "$FOCUS"`
  const baseCmd = `node "${codexDetect.companionPath}" adversarial-review --json --base "${base}" "$FOCUS"`
  const commands =
    codexMode === 'both' ? [wtCmd, baseCmd] : codexMode === 'working-tree' ? [wtCmd] : [baseCmd]
  const multi = commands.length > 1
  return `

---
## Codex 委譲(必須。コマンドの実失敗時のみ自力レビューへフォールバック)

この次元の一次レビューは OpenAI Codex CLI へ委譲する(利用可否・パスは検出済みの事実)。次のコマンドをこのとおり bash で実行すること${multi ? '(2 本で 1 セット: 未コミット差分とコミット済みブランチ差分の両方をレビューするため、必ず両方実行し所見を統合する)' : ''}。バックグラウンド実行にせず完了を待つこと。各 bash 呼び出しには明示的にタイムアウトを指定すること(目安 600000ms、bash ツールの上限。Codex CLI は数十秒〜数分かかることがあり、ハング時に工程全体が無期限にブロックされるのを防ぐため)。

\`\`\`bash
FOCUS=$(cat <<'CODEX_FOCUS_EOF'
${d.prompt}
CODEX_FOCUS_EOF
)
${commands.join('\n')}
\`\`\`

- 成功条件: ${multi ? '全コマンドについて' : ''}終了コード 0、標準出力が JSON としてパースでき、\`.result.findings\` が配列であること
- 成功した場合: ${multi ? '全コマンドの' : ''}\`.result.findings\` の各要素(severity/title/body/file/line_start/line_end/confidence/recommendation)を次の対応で findings に変換して${multi ? '統合し(同一ファイル・同一内容の重複は 1 件にまとめて)' : ''}返し、返り値のトップレベルに engine: "codex" を含めること
  - severity・title → そのまま
  - file → line_start === line_end なら "<file>:<line_start>"、異なれば "<file>:<line_start>-<line_end>"
  - detail → body。recommendation があれば末尾に改行して「対応案: <recommendation>」を追記してよい
  - この次元の観点に明確に無関係な所見(全く別の懸念領域を指すもの)は除外してよい(他の観点の呼び出しで別途拾われる)
- 失敗した場合(${multi ? 'いずれかのコマンドが' : ''}終了コード非 0・タイムアウト・JSON パース不能・\`.result\` が null・\`.result.findings\` が配列でない)のみ、このプロンプト冒頭の指示どおり自分自身で diff を読んでレビューし、engine: "claude-fallback" を含めること${multi ? '(片方だけ成功した部分的な Codex 所見で代用せず、全差分を自力でレビューし直すこと)' : ''}。上記の実失敗以外の理由で委譲を省略してはならない。`
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
      enum: ['claude', 'codex', 'claude-fallback'],
      description:
        'この次元の一次所見を生成したエンジン。codex = Codex 委譲成功 / claude-fallback = Codex 委譲を試みたがコマンドが実失敗して自力レビュー / claude = Codex 委譲の対象外(無効・利用不可)',
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
    agent(`${DIFF}\n${d.prompt}${codexAvailable ? codexInstructions(d) : ''}`, {
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
    // engine は Codex 委譲の対象外・未指定・不正値のときは claude 扱い(既定挙動と同じ)。
    // claude-fallback(委譲を試みたが実失敗)は観測性のため claude と区別して保持する
    const engine =
      review.engine === 'codex' || review.engine === 'claude-fallback' ? review.engine : 'claude'
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

const codexUsedCount = codexAvailable
  ? DIMENSIONS.reduce((acc, d, i) => acc + (results && results[i] && results[i].engine === 'codex' ? 1 : 0), 0)
  : 0
const codexFallbackCount = codexAvailable
  ? DIMENSIONS.reduce(
      (acc, d, i) => acc + (results && results[i] && results[i].engine === 'claude-fallback' ? 1 : 0),
      0
    )
  : 0
log(
  `確定所見: ${confirmed.length} 件 / 検証不能: ${unverifiable.length} 件 / 実行次元: ${dimensionsRun.length}/${DIMENSIONS.length}` +
    (codexEligible
      ? ` / Codex: ${
          codexAvailable
            ? `使用 ${codexUsedCount}/${DIMENSIONS.length} 次元(委譲失敗フォールバック ${codexFallbackCount} 次元)`
            : `不使用(${codexUnavailableReason})`
        }`
      : '')
)

return {
  confirmed,
  unverifiable,
  dimensionsRun,
  diffPathScope,
  // Codex 委譲の観測性(N11 対応で追加): run ログだけでなく戻り値からも
  // 「非対象/利用不可(理由)/使用数/フォールバック数」を判別できるようにする
  codex: {
    eligible: codexEligible,
    available: codexAvailable,
    mode: codexMode,
    reason: codexEligible ? codexUnavailableReason : null,
    usedCount: codexUsedCount,
    fallbackCount: codexFallbackCount,
  },
  summary:
    (confirmed.length === 0
      ? '確定した所見はありません'
      : `severity 順に対応を検討してください(${confirmed.length} 件)`) +
    (unverifiable.length > 0 ? `。検証不能 ${unverifiable.length} 件あり(内容は unverifiable を参照)` : ''),
}
