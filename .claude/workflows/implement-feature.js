export const meta = {
  name: 'implement-feature',
  description: 'リリース要件を入力に、探索→設計→実装→検証を行う機能実装パイプライン',
  whenToUse:
    '確定済み要件を実装するとき。args: {release: "release-1"} でリリース指定、または {task: "..."} で単発タスク指定。スコープを絞る場合は {scope: "..."} を併用。{config: {...}} で設定を直接渡せる。{skipVerify: true} で最終検証(release-check のネスト実行)を省略する(run-release からの起動用)。{auditBaseRef: "<コミットSHA>"} で照合フェーズの基準コミットを指定(run-release が Gate 0.5 リトライ間で基準を保持するために渡す。省略時は実行開始時の HEAD を自分で記録する)',
  phases: [
    { title: '準備', detail: 'config 読込と入力検証', model: 'haiku' },
    { title: '探索', detail: '要件と関連コードの並列調査', model: 'haiku/sonnet' },
    { title: '設計', detail: '実装計画と作業項目への分解', model: 'opus' },
    {
      title: '実装',
      detail:
        'ファイル競合の無い作業項目はバッチ化して並列実装、競合する項目間のみ逐次。失敗項目は 1 回リトライ',
      model: 'config.models.implementLow/Mid/High(複雑度スコアで決定)',
    },
    { title: '照合', detail: '報告された変更ファイルと git 差分の機械照合', model: 'haiku' },
    {
      title: '検証',
      detail: 'release-check ワークフローをネスト実行(skipVerify 指定時は省略)',
      model: 'haiku',
    },
  ],
}

// モデル使い分けの方針: 探索・設計・実装のモデルは config.models から取得する。
// 実装フェーズは複雑度スコア(1-10、設計フェーズが作業項目ごとに採点)を 2 つの閾値で 3 段に分け、
// implementLow / implementMid / implementHigh を割り当てる。閾値を変えるだけで中位モデルの
// 担当範囲を調整できる。LOW_MAX_COMPLEXITY 以下 → implementLow、HIGH_MIN_COMPLEXITY 以上 →
// implementHigh、その間(既定 3-8 の 6 段階、10 段中最も広い帯)は implementMid。
// 上位モデルは「本当に難しい 9-10」だけに絞り、中位モデルの担当範囲を広めにする方針。
const LOW_MAX_COMPLEXITY = 2
const HIGH_MIN_COMPLEXITY = 9

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

phase('準備')

// config ブートストラップ: args.config が無ければリポジトリの workflow.config.json を読む。
// エージェントによる値の捏造を防ぐため、不存在は exists: false で報告させたうえで明示 throw する。
let config = input.config
if (typeof config === 'string') {
  try {
    config = JSON.parse(config)
  } catch (e) {
    throw new Error('args.config を JSON として解釈できません')
  }
}
if (!config) {
  const loaded = await agent(
    'カレントリポジトリの .claude/workflow.config.json を読み、存在すれば {exists: true, config: <ファイル内容そのまま>}、無ければ {exists: false} を返してください。内容の要約・省略・補完は禁止。',
    {
      label: 'config読込',
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
  if (loaded && loaded.exists && loaded.config) config = loaded.config
}
if (!config) {
  throw new Error(
    'workflow.config.json が読めません。args.config を渡すか .claude/workflow.config.json を作成してください'
  )
}
if (config.configVersion !== 1) {
  throw new Error(
    `workflow.config.json の configVersion がエンジン要求版(1)と一致しません: ${config.configVersion}`
  )
}

const MODELS = config.models || {}

// 照合フェーズの基準コミット。run-release から渡される(Gate 0.5 リトライでも 1 回目開始時の
// 基準を保持し、1 回目の試行中の無断コミットをリトライの照合が拾えるようにするため)。
// 単体実行時は探索フェーズで自分の開始時 HEAD を記録する
let auditBaseRef =
  typeof input.auditBaseRef === 'string' && /^[0-9a-f]{7,40}$/i.test(input.auditBaseRef.trim())
    ? input.auditBaseRef.trim()
    : null

/**
 * 複雑度スコア(1-10)から実装フェーズのモデルを決める。
 *
 * @param score 設計フェーズが採点した複雑度(1-10)。
 * @returns config.models の implementLow / implementMid / implementHigh のいずれか。
 */
function modelForComplexity(score) {
  if (score <= LOW_MAX_COMPLEXITY) return MODELS.implementLow || 'haiku'
  if (score >= HIGH_MIN_COMPLEXITY) return MODELS.implementHigh || 'opus'
  return MODELS.implementMid || 'sonnet'
}

// 要件ファイルパスは config のテンプレート({release} プレースホルダ)から組み立てる
const reqPathTemplate = config.requirementsPath || 'docs/releases/{release}/requirements.md'
const reqPath = release ? reqPathTemplate.replace('{release}', release) : null
const target = reqPath
  ? `要件ファイル ${reqPath}${scope ? `(今回のスコープ: ${scope})` : ''}`
  : `タスク: ${taskDesc}`

// エージェントはカレント作業ディレクトリ(=リポジトリルート)前提で動かす。規約文書は config から取得
const conventionsDoc = config.conventionsDoc || 'CLAUDE.md'
// git 状態変更の禁止は実障害由来: 実装サブエージェントが無断で git commit すると変更が HEAD 差分
// から消え、照合フェーズ(run-release Gate 0.5 の入力)で捏造疑いの偽陽性になる
const RULES = `リポジトリはカレント作業ディレクトリ。CLAUDE.md と ${conventionsDoc} の規約に従うこと。git の状態を変更する操作(git add・git commit・git push・git stash 等)は一切禁止 — 変更はファイル編集のみで作業ツリーに残すこと(コミットは後工程が一括で行う)。`

// 実装完了前の format/lint 自走指示に使う検査コマンド一覧。config.checks (プロジェクト固有値) を
// そのまま文字列展開するだけで、コマンド文字列自体はソースにハードコードしない。
// どの key が format/lint に相当するかはエージェント側の判断に委ねる(config.checks の key 命名は
// プロジェクトごとに異なりうるため、エンジン側で固定の key 名と照合しない)。
const checksList = Array.isArray(config.checks) ? config.checks : []
const selfCheckInstruction =
  checksList.length > 0
    ? `\n\n## 作業完了前の自走検査\n以下の検査コマンドのうち format・lint に相当するものを自分で判別し、自分が編集したファイルに対して実行すること。自分の変更に起因する失敗があれば、完了報告の前に整形・修正し、再実行してパスすることを確認してから完了とすること(他者の変更に起因する既存の失敗まで修正する必要はない)。\n${checksList
        .map(
          (c) =>
            `- key=${c.key}: \`${c.cmd}\`${c.cwd && c.cwd !== '.' ? `(${c.cwd} 配下で実行)` : ''}`
        )
        .join('\n')}`
    : ''

phase('探索')
const needHeadCapture = !auditBaseRef
const [reqSummary, codeMap, headReport] = await parallel([
  () =>
    agent(
      `${RULES}\n${target} と CLAUDE.md を読み、実装すべき要件の要点を返してください: 機能要件(受け入れ基準つき)、スコープ外、未解決事項。原文の構造を保ち簡潔に。`,
      { label: '要件読込', phase: '探索', model: 'haiku' }
    ),
  () =>
    agent(
      `${RULES}\n${target} に関連する既存コードを調査してください。関連ファイルパス、既存パターン、再利用できる実装、変更が必要になりそうな箇所を報告してください。`,
      { label: 'コード調査', phase: '探索', agentType: 'Explore', model: MODELS.explore || 'sonnet' }
    ),
  () =>
    needHeadCapture
      ? agent(
          'カレントリポジトリで `git rev-parse HEAD` を実行し、出力のコミット SHA を head として返してください。出力の加工・省略・推測は禁止。',
          {
            label: '開始時HEAD記録',
            phase: '探索',
            schema: { type: 'object', required: ['head'], properties: { head: { type: 'string' } } },
            model: 'haiku',
          }
        )
      : Promise.resolve(null),
])
if (needHeadCapture) {
  const h = headReport && typeof headReport.head === 'string' ? headReport.head.trim() : ''
  auditBaseRef = /^[0-9a-f]{7,40}$/i.test(h) ? h : null
  if (!auditBaseRef) {
    log('注: 実行開始時 HEAD を記録できませんでした。照合は HEAD 差分と未追跡ファイルのみで行います')
  }
}

phase('設計')

// 複雑度採点の較正例は config.complexityRubricExamples から取得する(プロジェクトごとに差し替え可能)
const rubric = config.complexityRubricExamples || {}
const rubricLow = rubric.low ? `(例: ${rubric.low})` : ''
const rubricMid = rubric.mid ? `(例: ${rubric.mid})` : ''
const rubricHigh = rubric.high ? `(例: ${rubric.high})` : ''

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
              rubricLow +
              '。4-7: 典型的な実装(既存パターンの組み合わせ・中程度の分岐、大半の作業項目はここ)' +
              rubricMid +
              '。8-10: 新規のアーキテクチャ判断・複雑な状態管理・レイアウト計算等の新規ロジック・' +
              '既存規約からの逸脱を伴う判断' +
              rubricHigh +
              '。',
          },
        },
      },
    },
  },
}
// 設計出力がプレースホルダ的なジャンクでないかを検査する。
// (既知の事故: 大きな StructuredOutput 送信がペイロード切断され、切り分け用の
// 最小診断ペイロード(summary:"test", items:[{title:"t",...}])がそのまま正式な
// 設計出力として採用され、実装ゼロで終了した。docs/known-issues.md 解決済みログ参照)
function isJunkDesign(d) {
  if (!d || typeof d.summary !== 'string' || d.summary.trim().length < 15) return true
  if (!Array.isArray(d.items) || d.items.length === 0) return true
  return d.items.some((item) => {
    if (!item || typeof item.title !== 'string' || item.title.trim().length < 4) return true
    if (typeof item.description !== 'string' || item.description.trim().length < 8) return true
    if (!Array.isArray(item.files) || item.files.length === 0) return true
    // 拡張子・パス区切りの有無では判定しない(Makefile・Dockerfile・LICENSE 等の
    // 拡張子なしファイルを誤ってジャンク判定してしまうため)。空文字のみ弾く
    return item.files.some((f) => typeof f !== 'string' || f.trim().length === 0)
  })
}

const designPrompt = `${RULES}\n以下の要件と現状調査をもとに実装計画を設計し、実装順に並べた作業項目に分解してください。各項目は独立して検証できる粒度にすること。依存関係がある場合は、依存される側を先に並べること。\n\n## 要件\n${reqSummary}\n\n## 現状調査\n${codeMap}`

let design = await agent(designPrompt, {
  label: '設計',
  phase: '設計',
  schema: DESIGN_SCHEMA,
  model: MODELS.design || 'opus',
})
if (!design) {
  throw new Error('設計エージェントが失敗しました。再実行してください')
}

if (isJunkDesign(design)) {
  log('設計出力がプレースホルダ的で無効と判定されたため、再設計を1回試行します')
  design = await agent(
    `${designPrompt}\n\n前回の出力はプレースホルダ的な内容(極端に短い title/description、意味のない files 等)で無効でした。` +
      `具体的で実行可能な作業項目に分解し直してください。StructuredOutput の送信が大きすぎて失敗する場合は、` +
      `items の description を短く圧縮して再送すること(切り分け用の最小ペイロードを最終出力として送らないこと)。`,
    { label: '設計(再試行)', phase: '設計', schema: DESIGN_SCHEMA, model: MODELS.design || 'opus' }
  )
  if (!design || isJunkDesign(design)) {
    throw new Error(
      '設計エージェントが有効な設計を出力できませんでした(プレースホルダ的な出力が続いています)。要件を分割するか手動で設計を確認してください。'
    )
  }
}
log(`設計完了: ${design.items.length} 作業項目`)

phase('実装')

/** 2つの作業項目が対象ファイルを共有するか(共有があれば同時実行できない)。 */
function filesOverlap(filesA, filesB) {
  const setA = new Set(filesA)
  return filesB.some((f) => setA.has(f))
}

// design.items は実装順(依存順)のリスト。直前までのバッチとファイルが重ならない限り
// 同じバッチにまとめて並列実行し、重なった時点で新しいバッチに区切る。バッチ内は並列、
// バッチ間は逐次(前のバッチが完了してから次を開始)にすることで、ファイル競合を避けつつ
// 元の実装順序(依存関係の前提)も保つ。
const batches = []
for (const item of design.items) {
  const currentBatch = batches[batches.length - 1]
  const conflicts =
    currentBatch && currentBatch.some((existing) => filesOverlap(existing.files, item.files))
  if (currentBatch && !conflicts) {
    currentBatch.push(item)
  } else {
    batches.push([item])
  }
}
log(
  `実装バッチ: ${batches.length}件(${batches.map((b) => b.length).join('+')} 作業項目。` +
    '同一バッチ内は並列実行)'
)

// 完了報告に「変更したファイル一覧」を必ず含めさせる(後段で git 差分と機械照合する)
const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['changedFiles', 'report'],
  properties: {
    changedFiles: {
      type: 'array',
      items: { type: 'string' },
      description: '実際に変更・新規作成したファイル(リポジトリルートからの相対パス)',
    },
    report: { type: 'string', description: '実装内容の要約と判断に迷った点' },
  },
}

/**
 * 作業項目 1 件を実装エージェントに割り当てて実行する。
 *
 * @param item 設計フェーズが生成した作業項目。
 * @param labelPrefix ログ用のラベル接頭辞('実装' または '再実装')。
 * @returns 成功時は {item, complexity, model, changedFiles, report}、失敗時は null。
 */
function runImplementItem(item, labelPrefix) {
  const model = modelForComplexity(item.complexity)
  log(`${labelPrefix}: ${item.title} (複雑度 ${item.complexity} → ${model})`)
  return agent(
    `${RULES}\n次の作業項目を実装してください。テストが必要な変更は同時に書くこと。実装後、実際に変更・新規作成したファイルをリポジトリルートからの相対パスで changedFiles に列挙し、実装内容と判断に迷った点を report で報告してください。実際に編集していないファイルを changedFiles に含めてはいけません。\n\n## 実装方針(全体)\n${design.summary}\n\n## 作業項目\n${item.title}\n${item.description}\n対象ファイル目安: ${item.files.join(', ')}\n\n## 要件(参照用)\n${reqSummary}${selfCheckInstruction}`,
    { label: `${labelPrefix}: ${item.title}`, phase: '実装', schema: IMPLEMENT_SCHEMA, model }
  ).then(
    (r) =>
      r && {
        item: item.title,
        complexity: item.complexity,
        model,
        changedFiles: r.changedFiles || [],
        report: r.report,
      }
  )
}

// 失敗項目はサイレントスキップせず 1 回リトライし、それでも失敗した項目は failedItems に記録する。
// リトライは同一バッチ内で行う(後続バッチが依存する可能性があるため、次バッチ開始前に解消を試みる)
const results = []
const failedItems = []
for (const batch of batches) {
  const batchResults = await parallel(batch.map((item) => () => runImplementItem(item, '実装')))
  const retryTargets = batch.filter((item, idx) => batchResults[idx] === null)
  results.push(...batchResults.filter(Boolean))
  if (retryTargets.length > 0) {
    log(`実装失敗: ${retryTargets.length} 件を 1 回リトライします`)
    const retryResults = await parallel(
      retryTargets.map((item) => () => runImplementItem(item, '再実装'))
    )
    retryTargets.forEach((item, idx) => {
      if (retryResults[idx] === null) {
        log(`実装失敗(リトライ後): ${item.title}(failedItems に記録)`)
        failedItems.push(item.title)
      }
    })
    results.push(...retryResults.filter(Boolean))
  }
}

phase('照合')

/** ファイルパスの表記ゆれ(先頭の ./ や余分な空白)を照合用に正規化する。 */
function normalizePath(p) {
  return p.trim().replace(/^\.\//, '')
}

// 実装エージェントが報告したファイルと実際の git 差分を機械照合する(run-release Gate 0.5 の入力)。
// 実差分 = HEAD 差分 ∪ 未追跡ファイル ∪ 実行開始時 HEAD(auditBaseRef) 起点差分。
// 新規作成ファイルは git diff に現れないため未追跡ファイル一覧を含め、指示に反してエージェントが
// commit してしまった変更は HEAD 差分から消えるため開始時 HEAD 起点差分で拾う。基準を
// merge-base(baseBranch) にしない理由: no-pr 停止後の同一ブランチ再実行で前回実行のコミットまで
// 実差分に混入し、今回触っていないファイルの捏造報告が検証済み扱いになってしまうため
const reportedRaw = results.flatMap((r) => r.changedFiles)
const diffReport = await agent(
  '読み取り専用の差分照合です。リポジトリの状態を変更するコマンドは実行禁止。カレントリポジトリで以下を実行してください:\n' +
    '1. `git diff --name-only HEAD` と `git ls-files --others --exclude-standard` を実行する\n' +
    (auditBaseRef
      ? `2. \`git diff --name-only ${auditBaseRef}\` も実行する(成功したら auditDiffIncluded: true とする。このコマンドが失敗した場合のみスキップし、auditDiffIncluded: false とする)\n`
      : '') +
    '3. 実行した全コマンドの出力ファイルパスを結合・重複除去した配列を files として返す。出力の加工・省略・推測は禁止。\n' +
    '4. `git rev-parse --show-toplevel` の出力(リポジトリルートの絶対パス)を repoRoot として返す。',
  {
    label: '差分照合',
    phase: '照合',
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        auditDiffIncluded: { type: 'boolean' },
        repoRoot: { type: 'string' },
      },
    },
    model: 'haiku',
  }
)
if (auditBaseRef && diffReport && diffReport.auditDiffIncluded !== true) {
  log('注: 開始時 HEAD 起点の差分が取得できなかったため、HEAD 差分と未追跡ファイルのみで照合します')
}

// 絶対パス報告の吸収: プロンプト・スキーマで相対パスを要求しても絶対パスで報告される事故が実際に
// 起きたため、差分照合エージェントが返した repoRoot を接頭辞として機械的に剥がす。repoRoot が
// 取れない場合は従来どおり(絶対パス報告は unverified = 安全側)。正規化は報告側・実差分側の両方へ
// 対称に適用する(git 出力は相対パスのため実質 no-op)
const repoRoot =
  diffReport && typeof diffReport.repoRoot === 'string'
    ? diffReport.repoRoot.trim().replace(/\/+$/, '')
    : null

/** repoRoot 接頭辞つきの絶対パスをリポジトリルート相対へ剥がす(それ以外は素通し)。 */
function stripRepoRoot(p) {
  return repoRoot && p.startsWith(repoRoot + '/') ? p.slice(repoRoot.length + 1) : p
}

/** 照合用の最終正規化: 前後空白 → repoRoot 接頭辞剥がし → 先頭 ./ 除去。 */
function normalizeForAudit(p) {
  return normalizePath(stripRepoRoot(p.trim()))
}

const reported = [...new Set(reportedRaw.map(normalizeForAudit))]
const actualDiff = Array.isArray(diffReport?.files) ? diffReport.files.map(normalizeForAudit) : []
const actualSet = new Set(actualDiff)
// 報告されたのに実差分に現れないファイル = 捏造疑い。差分取得自体に失敗した場合は
// 検証できないため、安全側に倒して報告された全ファイルを unverified とする
const unverified = diffReport ? reported.filter((f) => !actualSet.has(f)) : reported
if (!diffReport) {
  log('差分照合エージェントが失敗したため、報告された全ファイルを unverified 扱いにします')
} else if (unverified.length > 0) {
  log(`照合不一致: ${unverified.length} 件のファイルが報告されたが実差分に現れません(捏造疑い)`)
} else {
  log('照合完了: 報告されたファイルはすべて実差分に存在します')
}

// skipVerify 指定時は最終検証を省略する(run-release から起動される場合、workflow() の
// ネストは 1 段までのため release-check は run-release 側が直接実行する)
let verification = null
if (input.skipVerify !== true) {
  phase('検証')
  verification = await workflow('release-check', { config })
}

return {
  design: design.summary,
  implemented: results.map((r) => r.item),
  failedItems,
  fileAudit: { reported, actualDiff, unverified },
  reports: results,
  verification,
  next:
    failedItems.length > 0
      ? `実装に失敗した作業項目が ${failedItems.length} 件あります。failedItems を確認・対応後、review-changes ワークフローで差分レビューを実施してください`
      : 'review-changes ワークフローで差分レビューを実施してください',
}
