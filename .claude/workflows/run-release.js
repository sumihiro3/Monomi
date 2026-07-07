export const meta = {
  name: 'run-release',
  description:
    '要件確定済みリリースの実装→検査→レビュー→起票→文書同期→コミット→PR 作成を全自動実行する統括ワークフロー',
  whenToUse:
    '壁打ちで要件を確定したリリースの全自動実行。args: {release: "release-1", config: {...}, autoApprove: true|false}。autoApprove 省略時は config.automation.autoApprove に従う。false の場合はコミット直前で停止し、コミット分割案と PR 本文案を返す',
  phases: [
    { title: '準備', detail: 'config 読込と入力検証', model: 'haiku' },
    { title: 'Gate0 事前検査', detail: '作業ツリー・ブランチ・要件・config 版数の照合(読み取り専用)', model: 'haiku' },
    { title: 'Gate1 検査ループ', detail: 'release-check と修正の反復(失敗署名による収束判定つき)' },
    { title: 'Gate2 レビューループ', detail: 'review-changes と severity 別の修正・Gate1 再実行' },
    { title: 'PR準備', detail: 'AC 充足検証と PR 本文の生成' },
    { title: 'コミット', detail: '論理単位コミット(autoApprove=false はここで停止)' },
    { title: 'PR作成', detail: 'push と PR 作成(critical 残存時は作成しない)' },
    { title: '通知', detail: '完了・停止の push 通知' },
  ],
}

// モデル使い分けの方針: 読み取り・照合系 = haiku / 修正 = config.models.fix /
// 検証系 checker = config.models.verify / 文書・PR 本文 = config.models.docSync

const ENGINE_CONFIG_VERSION = 1

// args は JSON 文字列で渡ってくる場合があるためパースする(パース失敗は明示エラー)
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error(
      `run-release: args の JSON パースに失敗しました (${e.message})。{release, config, autoApprove} 形式の JSON を渡してください`
    )
  }
}
input = input || {}

const release = input.release
if (!release || typeof release !== 'string') {
  throw new Error('args.release を指定してください(例: {release: "release-1"})')
}

// ---- エージェント起動数の通算カウンタ(AC-5)と消費サマリー ----
// サブワークフロー内の起動数はエンジンから観測できないため、戻り値からの概算(下限)を加算する
let totalAgents = 0
let checkRunsTotal = 0
const consumption = {}

/** フェーズ別の消費カウンタに n を加算し、通算カウンタにも反映する。 */
function addConsumption(key, n) {
  consumption[key] = (consumption[key] || 0) + n
  totalAgents += n
}

/** 通算エージェント起動数が上限に達したか(超過は収束不能と同じ停止経路に入る)。 */
function budgetExceeded() {
  return totalAgents >= maxAgentInvocations
}

/** agent() を消費カウント付きで起動する。 */
function trackedAgent(key, prompt, opts) {
  addConsumption(key, 1)
  return agent(prompt, opts)
}

// advisor(サーバーサイド相談ツール)は応答がストールする既知障害があるため使用を禁止する(2026-07-06 に再現)。
// 完了済みエージェント(bootstrap・preflight・notify)のキャッシュを保護するため、trackedAgent での
// 一律付与はせず、未実行の各呼び出しのプロンプトに個別に付与している
const ADVISOR_BAN =
  'advisor 等のサーバーサイド相談ツールは呼び出さないこと(応答がストールする既知障害があるため)。自身の分析のみで作業を完結すること。'

phase('準備')

// config ブートストラップ: args.config 優先、未指定なら .claude/workflow.config.json を読む。
// 不存在は exists: false で報告させ、値の捏造を防いだうえで明示 throw する
let config = input.config
if (typeof config === 'string') {
  try {
    config = JSON.parse(config)
  } catch (e) {
    throw new Error('args.config を JSON として解釈できません')
  }
}
if (!config) {
  const loaded = await trackedAgent(
    'bootstrap',
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
  if (!loaded || loaded.exists !== true || !loaded.config) {
    throw new Error(
      'workflow.config.json が読めません。args.config を渡すか .claude/workflow.config.json を作成してください'
    )
  }
  config = loaded.config
}
// 注: configVersion の照合は共通パターンでは throw だが、run-release は FR-06 AC-1 により
// 「違反時は何も変更せず通知して return」が必要なため、Gate 0 の違反項目として扱う

const automation = config.automation || {}
const maxFixIterationsCheck = automation.maxFixIterationsCheck ?? 5
const maxFixIterationsReview = automation.maxFixIterationsReview ?? 3
const maxGate1RerunsPerReviewFix = automation.maxGate1RerunsPerReviewFix ?? 2
const maxTotalCheckRuns = automation.maxTotalCheckRuns ?? 10
const maxAgentInvocations = automation.maxAgentInvocations ?? 80
const gateRaw = automation.severityGate || {}
const severityGate = {
  block: Array.isArray(gateRaw.block) ? gateRaw.block : ['critical', 'high'],
  fixOnce: Array.isArray(gateRaw.fixOnce) ? gateRaw.fixOnce : ['medium'],
  backlogOnly: Array.isArray(gateRaw.backlogOnly) ? gateRaw.backlogOnly : ['low'],
}
const autoApprove =
  typeof input.autoApprove === 'boolean' ? input.autoApprove : automation.autoApprove === true
const baseBranch = config.baseBranch || 'main'
const MODELS = config.models || {}
const reqPath = (config.requirementsPath || 'docs/releases/{release}/requirements.md').replace(
  '{release}',
  release
)

// ---- 通知(AC-11): 失敗してもパイプラインを止めない ----
// agent() は失敗時に throw せず null を返すため、結果を検査してログするだけでよい

/** push 通知を送る。bark 送信スクリプトが無ければ osascript にフォールバックする。 */
async function notify(title, message) {
  const r = await trackedAgent(
    'notify',
    'push 通知を bash で送信してください。手順:\n' +
      '1. ls ~/.claude/hooks/ で名前に bark を含む送信スクリプトを探す\n' +
      '2. あればスクリプト本体を読んで入力仕様(stdin の JSON キー・引数等)を把握し、それに従って呼び出して通知を送る\n' +
      '3. スクリプトが無い・必要な入力を揃えられない・送信に失敗した場合は、osascript -e \'display notification "<本文>" with title "<タイトル>"\' にフォールバックする\n' +
      '4. どの手段も失敗した場合も異常終了せず sent: false で報告する\n' +
      `\n通知タイトル: ${title}\n通知本文: ${message}`,
    {
      label: '通知送信',
      phase: '通知',
      schema: {
        type: 'object',
        required: ['sent'],
        properties: {
          sent: { type: 'boolean' },
          method: { type: 'string', description: '使用した送信手段(bark/osascript 等)' },
        },
      },
      model: 'haiku',
    }
  )
  if (!r || r.sent !== true) {
    log(`通知の送信に失敗しましたが処理は継続します: ${title}`)
  }
}

// ---- 起票(AC-6): record-known-issues は新設のため scriptPath 指定で起動する ----
// 注意: workflow() の相対 scriptPath は「親スクリプトのディレクトリ」基準で解決される
// (cwd 基準ではない)。'.claude/workflows/record-known-issues.js' と書くと
// .claude/workflows/.claude/workflows/... に二重解決されて file not found になる
// (2026-07-07 に run-release を絶対パス起動した際の実障害)。同一ディレクトリの
// ファイル名のみを指定すること
const filedIssues = []
let resolvedLogProposal = null

/** 所見を record-known-issues ワークフローで起票し、結果を filedIssues に集約する。 */
async function fileKnownIssues(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return
  const r = await workflow({ scriptPath: 'record-known-issues.js' }, { config, findings })
  addConsumption('triage', 1)
  if (!r) {
    log('record-known-issues が結果を返さなかったため、起票結果を確認できませんでした')
    return
  }
  if (Array.isArray(r.filed)) filedIssues.push(...r.filed)
  if (Array.isArray(r.appendedTo)) filedIssues.push(...r.appendedTo)
  if (r.resolvedLogProposal) resolvedLogProposal = r.resolvedLogProposal
}

/** 停止・完了時の共通処理: 通知を送り、契約どおりの戻り値を組み立てる。 */
async function finishWith(status, stopReason, extra) {
  await notify(`run-release: ${status}`, `${release}: ${stopReason || '完了'}`)
  return {
    status,
    stopReason,
    filedIssues,
    resolvedLogProposal,
    consumption,
    ...(extra || {}),
  }
}

// ---- 収束判定(AC-3): 失敗署名 = check キー + 正規化済み failedItems のソート済み JSON ----

/** release-check の失敗 1 件から収束判定用の署名を作る。 */
function failureSignature(f) {
  const items = Array.isArray(f.failedItems) ? f.failedItems.map((s) => String(s).trim()) : []
  return `${String(f.check || '').trim()}::${JSON.stringify([...items].sort())}`
}

// ---- テスト不変ガード付き修正(maker/checker 分離) ----
const guardViolations = [] // ガード違反の起票用(復元済みでも記録は残す)

/**
 * 修正エージェント(maker)を起動し、fix 前スナップショットとの増分 diff で
 * テストの skip 化・期待値改変・削除がないかを checker に検査させる。
 * 違反したテストファイルはスナップショットから復元する。
 *
 * @param instruction 修正内容の指示文。
 * @param phaseName ログ用のフェーズ名。
 * @param phaseKey 消費カウンタのキー。
 * @returns {fixed, guard, snapshotRef} — fixed は修正エージェントが結果を返したか。snapshotRef は
 *   取得した fix 前スナップショット参照(取得失敗時 null。呼び出し元での差分スコープ算出に使う)。
 */
async function fixWithGuard(instruction, phaseName, phaseKey) {
  // fix 前スナップショット参照の取得(git stash create は作業ツリーを変更しない)
  const snap = await trackedAgent(
    phaseKey,
    ADVISOR_BAN +
      '\ngit stash create を実行し、出力されたコミット ID を ref として返してください。出力が空(未コミット変更なし)の場合は git rev-parse HEAD の出力を ref として返すこと。リポジトリの状態を変更するコマンド(stash push/apply/pop、add、checkout 等)は実行禁止。',
    {
      label: 'fix前スナップショット',
      phase: phaseName,
      schema: {
        type: 'object',
        required: ['ref'],
        properties: { ref: { type: 'string' } },
      },
      model: 'haiku',
    }
  )
  const snapshotRef = snap && typeof snap.ref === 'string' ? snap.ref.trim() : null

  const fixed = await trackedAgent(
    phaseKey,
    `${ADVISOR_BAN}\n${instruction}\n\n制約:\n- あなたは修正の実施者(maker)であり、修正後の合否判定はしない(再検査は別工程が行う)\n- テストの skip 化・既存期待値の意図的な書き換え・テスト削除によって検査を回避することは禁止\n- 修正は必要最小限にすること`,
    { label: '修正', phase: phaseName, model: MODELS.fix || 'sonnet' }
  )

  if (!snapshotRef) {
    log('fix 前スナップショットが取得できなかったため、テスト不変ガードは検査不能として続行します')
    return {
      fixed: fixed !== null,
      guard: { violation: false, files: [], detail: 'スナップショット取得失敗によりガード検査不能' },
      snapshotRef: null,
    }
  }

  const guard = await trackedAgent(
    phaseKey,
    `${ADVISOR_BAN}\nテスト不変ガードの検査です。git diff ${snapshotRef} で直前の fix 作業による増分差分を確認し、そのうちテストファイル(プロジェクトのテスト命名規則・テストディレクトリから自分で判別すること)への変更に、検査を通すことだけを目的とした次の改変が含まれていないか検査してください: (a) テストの skip 化(skip/only の付与・無効化) (b) 既存の期待値の改変 (c) テストケースの削除。実装変更に正当に追随する期待値更新や新規テストの追加は違反ではない。判定基準はこの増分差分のみとし、それ以外の差分は対象外。`,
    {
      label: 'テスト不変ガード',
      phase: phaseName,
      schema: {
        type: 'object',
        required: ['violation', 'files', 'detail'],
        properties: {
          violation: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' }, description: '違反があったテストファイル' },
          detail: { type: 'string' },
        },
      },
      model: MODELS.verify || 'sonnet',
    }
  )

  if (guard && guard.violation === true) {
    const files = Array.isArray(guard.files) ? guard.files : []
    guardViolations.push({
      source: 'check',
      checkKey: 'test-guard',
      severity: 'high',
      title: 'テスト不変ガード違反(fix によるテスト改変を検出)',
      detail: `${guard.detail}${files.length > 0 ? `(対象: ${files.join(', ')}。スナップショットから復元済み)` : ''}`,
    })
    if (files.length > 0) {
      log(`テスト不変ガード違反: ${files.join(', ')} — fix 前の状態に復元します`)
      await trackedAgent(
        phaseKey,
        `${ADVISOR_BAN}\ngit checkout ${snapshotRef} -- ${files.join(' ')} を実行し、テストファイルを fix 前の状態に復元してください。それ以外のファイルには触れないこと。`,
        { label: 'テスト復元', phase: phaseName, model: 'haiku' }
      )
    }
  }
  return {
    fixed: fixed !== null,
    guard: guard || { violation: false, files: [], detail: 'ガード検査エージェントが結果を返しませんでした' },
    snapshotRef,
  }
}

// ---- Gate1 検査ループ(AC-3。最終検査の別枠ループ・レビュー後の再実行にも再利用する) ----

/**
 * release-check → 失敗なら修正 → 再検査を繰り返す。
 * 収束不能条件: 同一失敗署名の 2 回連続出現 / 修正回数上限 / 通算検査回数上限 / エージェント予算超過。
 *
 * @param maxFixes 修正イテレーションの上限回数。
 * @param phaseName ログ用のフェーズ名。
 * @param phaseKey 消費カウンタのキー。
 * @param contextNote 収束不能理由に付記する文脈ラベル。
 * @returns {passed, nonConvergence, reason?, lastCheck} — lastCheck は最後の release-check 結果。
 */
async function gate1Loop(maxFixes, phaseName, phaseKey, contextNote) {
  let prevSignatures = null
  let lastCheck = null
  for (let attempt = 0; ; attempt++) {
    if (checkRunsTotal >= maxTotalCheckRuns) {
      return {
        passed: false,
        nonConvergence: true,
        reason: `release-check の通算実行回数が上限(${maxTotalCheckRuns})に達しました`,
        lastCheck,
      }
    }
    if (budgetExceeded()) {
      return {
        passed: false,
        nonConvergence: true,
        reason: `エージェント起動数が上限(${maxAgentInvocations})を超過しました`,
        lastCheck,
      }
    }
    checkRunsTotal++
    const check = await workflow('release-check', { config })
    addConsumption(phaseKey, check && Array.isArray(check.results) ? check.results.length : 1)
    if (!check) {
      return { passed: false, nonConvergence: true, reason: 'release-check が結果を返しませんでした', lastCheck }
    }
    lastCheck = check
    if (check.passed === true) {
      return { passed: true, nonConvergence: false, lastCheck }
    }
    const failed = Array.isArray(check.failed) ? check.failed : []
    // 収束判定: 直前イテレーションと同一署名の失敗が再出現したら、それ以上修正しても進まないとみなす
    const signatures = failed.map(failureSignature)
    if (prevSignatures && signatures.some((s) => prevSignatures.has(s))) {
      return {
        passed: false,
        nonConvergence: true,
        reason: '直前イテレーションと同一署名の失敗が再出現しました(収束不能)',
        lastCheck,
      }
    }
    prevSignatures = new Set(signatures)
    if (attempt >= maxFixes) {
      return {
        passed: false,
        nonConvergence: true,
        reason: `修正イテレーション上限(${maxFixes})に到達しました${contextNote ? `(${contextNote})` : ''}`,
        lastCheck,
      }
    }
    log(`${phaseName}: 検査失敗 ${failed.length} 件 — 修正を試行します(${attempt + 1}/${maxFixes})`)
    const failText = failed
      .map((f) => `- [${f.check}] ${f.detail}\n  失敗箇所: ${(f.failedItems || []).join(' / ')}`)
      .join('\n')
    await fixWithGuard(`以下のリリース前検査の失敗を修正してください。\n${failText}`, phaseName, phaseKey)
  }
}

// ---- Gate 0 preflight(AC-1): 違反時は何も変更せず通知して return する ----
phase('Gate0 事前検査')
const preflight = await trackedAgent(
  'gate0',
  '読み取り専用の事前検査です。リポジトリへの変更(ファイル編集・状態を変える git 操作)は一切禁止。以下を実行して結果をそのまま報告してください:\n' +
    '1. git status --porcelain の出力(porcelain。空なら空文字列)\n' +
    `2. git branch --show-current の出力(branch)\n` +
    `3. ${reqPath} が存在するか(requirementsExists)。存在する場合、「ステータス: 確定」という記載を含むか(statusConfirmed)`,
  {
    label: 'preflight',
    phase: 'Gate0 事前検査',
    schema: {
      type: 'object',
      required: ['porcelain', 'branch', 'requirementsExists', 'statusConfirmed'],
      properties: {
        porcelain: { type: 'string' },
        branch: { type: 'string' },
        requirementsExists: { type: 'boolean' },
        statusConfirmed: { type: 'boolean' },
      },
    },
    model: 'haiku',
  }
)

const violations = []
if (!preflight) {
  violations.push('preflight エージェントが結果を返しませんでした')
} else {
  if (String(preflight.porcelain || '').trim() !== '') {
    violations.push('作業ツリーがクリーンではありません(未コミットの変更があります)')
  }
  const branch = String(preflight.branch || '').trim()
  if (branch !== release) {
    violations.push(`現在ブランチ(${branch})が args.release(${release})と一致しません`)
  }
  if (branch === baseBranch) {
    violations.push(`現在ブランチが baseBranch(${baseBranch})です。リリースブランチで実行してください`)
  }
  if (preflight.requirementsExists !== true) {
    violations.push(`要件ファイル ${reqPath} が存在しません`)
  } else if (preflight.statusConfirmed !== true) {
    violations.push(`要件ファイル ${reqPath} に「ステータス: 確定」の記載がありません`)
  }
}
if (config.configVersion !== ENGINE_CONFIG_VERSION) {
  violations.push(
    `configVersion(${config.configVersion})がエンジン要求版(${ENGINE_CONFIG_VERSION})と一致しません`
  )
}
if (violations.length > 0) {
  return await finishWith('stopped', `Gate 0 違反: ${violations.join(' / ')}`)
}
log('Gate 0 通過: 作業ツリー・ブランチ・要件・config 版数に問題なし')

// ---- 実装 + Gate 0.5(AC-2): 完了性・捏造疑いの照合。問題があれば 1 回リトライ ----

/** implement-feature の消費エージェント数の概算(下限): 探索2 + 設計1 + 照合1 + 実装項目数。 */
function estimateImplementAgents(r) {
  if (!r) return 1
  return (Array.isArray(r.reports) ? r.reports.length : 0) + 4
}

/** implement-feature の結果から Gate 0.5 の問題点(失敗残存・捏造疑い)を抽出する。 */
function implementProblems(r) {
  if (!r) return ['implement-feature が結果を返しませんでした']
  const problems = []
  if (Array.isArray(r.failedItems) && r.failedItems.length > 0) {
    problems.push(`実装に失敗した作業項目が残っています: ${r.failedItems.join(', ')}`)
  }
  const unverified =
    r.fileAudit && Array.isArray(r.fileAudit.unverified) ? r.fileAudit.unverified : []
  if (unverified.length > 0) {
    problems.push(`変更報告されたのに実差分に現れないファイルがあります(捏造疑い): ${unverified.join(', ')}`)
  }
  return problems
}

let impl = await workflow('implement-feature', { release, config, skipVerify: true })
addConsumption('implement', estimateImplementAgents(impl))
let gate05Problems = implementProblems(impl)
if (gate05Problems.length > 0) {
  log(`Gate 0.5 検出: ${gate05Problems.join(' / ')} — implement-feature を 1 回リトライします`)
  impl = await workflow('implement-feature', {
    release,
    config,
    skipVerify: true,
    scope: `前回実行で未解消の問題の解消に限定: ${gate05Problems.join(' / ')}。既に正しく実装済みの部分は変更しないこと`,
  })
  addConsumption('implement', estimateImplementAgents(impl))
  gate05Problems = implementProblems(impl)
}
if (gate05Problems.length > 0) {
  // 残存は critical 相当(AC-9: Gate 0.5 由来の critical 残存は PR を作らず停止。作業状態は保全)
  await fileKnownIssues(
    gate05Problems.map((p) => ({
      source: 'check',
      checkKey: 'implement',
      severity: 'critical',
      title: '実装工程の完了性違反(Gate 0.5)',
      detail: p,
    }))
  )
  return await finishWith(
    'no-pr',
    `Gate 0.5: 実装工程の完了性違反がリトライ後も解消しません: ${gate05Problems.join(' / ')}`
  )
}
log(`実装完了: ${Array.isArray(impl.implemented) ? impl.implemented.length : 0} 作業項目(Gate 0.5 通過)`)

// ---- Gate 1 検査ループ(AC-3) ----
phase('Gate1 検査ループ')
const checkFindings = [] // 収束不能な検査失敗の起票用
const gate1 = await gate1Loop(maxFixIterationsCheck, 'Gate1 検査ループ', 'gate1', 'Gate1')
if (!gate1.passed) {
  const failed = gate1.lastCheck && Array.isArray(gate1.lastCheck.failed) ? gate1.lastCheck.failed : []
  if (failed.length > 0) {
    failed.forEach((f) =>
      checkFindings.push({
        source: 'check',
        checkKey: f.check,
        severity: 'high',
        title: `検査 ${f.check} が収束せず失敗が残存`,
        detail: `${gate1.reason}。失敗箇所: ${(f.failedItems || []).join(' / ')}`,
      })
    )
  } else {
    checkFindings.push({
      source: 'check',
      checkKey: 'release-check',
      severity: 'high',
      title: 'Gate1 検査ループが収束しませんでした',
      detail: gate1.reason,
    })
  }
  log(`Gate1 収束不能: ${gate1.reason}(所見を起票して継続、PR は draft 以下に降格)`)
}

// ---- Gate 2 レビューループ(AC-4) ----
phase('Gate2 レビューループ')
const backlogFindings = [] // 起票対象(low・残存 medium 等)
const reviewFixed = [] // PR 本文用: 修正対応した所見タイトル
const mediumAttempted = new Set()
let residualBlock = [] // ループ終了時点で未解決の critical/high 所見
let unverifiableDims = []
let gate2NonConvergence = null
// 2 回目以降の再レビューを直前修正の変更ファイルへ絞るスコープ(FR-02)。取得失敗時は null=全差分
let reReviewScope = null

/** 所見の重複照合キー(同一ファイル・同一タイトルは同一所見とみなす)。 */
function findingKey(f) {
  return `${f.file || ''}::${f.title || ''}`
}

/** 所見の severity(欠落時は fixOnce 相当として扱う)。 */
function severityOf(f) {
  return f && typeof f.severity === 'string' ? f.severity : 'medium'
}

/** review-changes の所見を起票用の findings 形式に変換する。 */
function toReviewFinding(f, titleSuffix) {
  return {
    source: 'review',
    dimension: f.dimension,
    severity: severityOf(f),
    title: titleSuffix ? `${f.title}(${titleSuffix})` : f.title,
    file: f.file,
    detail: f.detail,
  }
}

/** 重複を除外しつつ起票対象に追加する。 */
function addBacklog(finding) {
  if (!backlogFindings.some((b) => findingKey(b) === findingKey(finding))) {
    backlogFindings.push(finding)
  }
}

for (let iter = 0; ; iter++) {
  if (budgetExceeded()) {
    gate2NonConvergence = `エージェント起動数が上限(${maxAgentInvocations})を超過しました`
    break
  }
  // 初回(iter=0)は全差分。2 回目以降は前回レビュー以降の変更ファイルへ絞る(取得済みのときのみ)
  const reviewArgs = { base: baseBranch, config }
  if (iter >= 1 && reReviewScope) {
    reviewArgs.diffPathScope = reReviewScope
  }
  const review = await workflow('review-changes', reviewArgs)
  addConsumption(
    'gate2',
    review
      ? Math.max(
          1,
          (Array.isArray(review.dimensionsRun) ? review.dimensionsRun.length : 0) +
            (Array.isArray(review.confirmed) ? review.confirmed.length : 0)
        )
      : 1
  )
  if (!review) {
    gate2NonConvergence = 'review-changes が結果を返しませんでした'
    break
  }
  unverifiableDims = Array.isArray(review.unverifiable) ? review.unverifiable : []
  const confirmed = Array.isArray(review.confirmed) ? review.confirmed : []
  const blockF = confirmed.filter((f) => severityGate.block.includes(severityOf(f)))
  const fixOnceF = confirmed.filter((f) => severityGate.fixOnce.includes(severityOf(f)))
  // low(および gate 対象外の severity)は修正せず起票対象へ
  confirmed
    .filter((f) => !severityGate.block.includes(severityOf(f)) && !severityGate.fixOnce.includes(severityOf(f)))
    .forEach((f) => addBacklog(toReviewFinding(f)))
  // medium: 修正は 1 回だけ試行し、試行後も再出現したら起票対象へ
  fixOnceF
    .filter((f) => mediumAttempted.has(findingKey(f)))
    .forEach((f) => addBacklog(toReviewFinding(f, '修正 1 回試行後も残存')))
  const mediumsToFix = fixOnceF.filter((f) => !mediumAttempted.has(findingKey(f)))

  if (blockF.length === 0 && mediumsToFix.length === 0) {
    residualBlock = []
    log(`Gate2 収束: 修正が必要な所見はありません(イテレーション ${iter + 1})`)
    break
  }
  if (iter >= maxFixIterationsReview) {
    residualBlock = blockF
    mediumsToFix.forEach((f) => addBacklog(toReviewFinding(f, '修正未試行のままループ上限到達')))
    gate2NonConvergence = `レビュー修正イテレーション上限(${maxFixIterationsReview})に到達しました`
    break
  }

  const toFix = [...blockF, ...mediumsToFix]
  log(`Gate2: 修正対象 ${toFix.length} 件(block ${blockF.length} / medium ${mediumsToFix.length})`)
  const fixText = toFix
    .map((f) => `- [${severityOf(f)}/${f.dimension}] ${f.title}\n  対象: ${f.file}\n  ${f.detail}`)
    .join('\n')
  const fixResult = await fixWithGuard(
    `以下のレビュー所見を修正してください。\n${fixText}`,
    'Gate2 レビューループ',
    'gate2'
  )
  mediumsToFix.forEach((f) => mediumAttempted.add(findingKey(f)))
  toFix.forEach((f) => reviewFixed.push(`[${severityOf(f)}] ${f.title}`))

  // critical/high の修正後は Gate1 を別枠上限で再実行してから差分再レビューに戻る
  if (blockF.length > 0) {
    const g1 = await gate1Loop(
      maxGate1RerunsPerReviewFix,
      'Gate2 レビューループ',
      'gate2',
      'レビュー修正後の Gate1 再実行'
    )
    if (!g1.passed) {
      const failed = g1.lastCheck && Array.isArray(g1.lastCheck.failed) ? g1.lastCheck.failed : []
      failed.forEach((f) =>
        checkFindings.push({
          source: 'check',
          checkKey: f.check,
          severity: 'high',
          title: `レビュー修正後の検査 ${f.check} が失敗のまま残存`,
          detail: `${g1.reason}。失敗箇所: ${(f.failedItems || []).join(' / ')}`,
        })
      )
      // 修正の有効性を検査で確認できないため、当該所見は残存扱いにして打ち切る
      residualBlock = blockF
      gate2NonConvergence = `レビュー修正後の Gate1 再実行が収束しません: ${g1.reason}`
      break
    }
  }

  // 次イテレーションの再レビューを、この修正以降の変更ファイルへ絞る(FR-02)。
  // fixResult.snapshotRef は Gate2 修正の前に取得されており、Gate2 修正と直後の Gate1 再実行
  // による変更の両方を包含する。取得失敗・空のときは reReviewScope=null(次回は全差分)。
  const fixSnapshotRef = fixResult.snapshotRef
  if (!fixSnapshotRef) {
    reReviewScope = null
  } else {
    const scopeRes = await trackedAgent(
      'gate2',
      `${ADVISOR_BAN}\ngit diff --name-only ${fixSnapshotRef} と git ls-files --others --exclude-standard の両方を実行し、` +
        'それぞれの出力ファイルパスを結合して重複を除いた一覧を files として返してください。' +
        '前者は直前の修正で変更・削除された追跡ファイル、後者は新規作成の未追跡ファイル(スナップショットに含まれないため必須)です。' +
        'リポジトリの状態を変更するコマンドは実行禁止(読み取り専用)。該当ファイルが無ければ files: [] を返すこと。',
      {
        label: '再レビュースコープ取得',
        phase: 'Gate2 レビューループ',
        schema: {
          type: 'object',
          required: ['files'],
          properties: {
            files: { type: 'array', items: { type: 'string' } },
          },
        },
        model: 'haiku',
      }
    )
    const scopeFiles =
      scopeRes && Array.isArray(scopeRes.files) ? scopeRes.files.filter(Boolean) : []
    // 差分取得の失敗・空配列は安全側に倒して全差分にフォールバック(AC-3)
    reReviewScope = scopeFiles.length > 0 ? [...new Set(scopeFiles)] : null
  }
}
if (gate2NonConvergence) {
  log(`Gate2 収束不能: ${gate2NonConvergence}`)
}

// ---- 起票(AC-6): 未対応所見 + 収束不能分を record-known-issues に渡す ----
const triageFindings = [
  ...backlogFindings,
  ...checkFindings,
  ...guardViolations,
  ...residualBlock.map((f) => toReviewFinding(f, '修正ループ収束不能・残存')),
]
await fileKnownIssues(triageFindings)
log(`起票工程完了: 入力所見 ${triageFindings.length} 件 / 起票・追記 ${filedIssues.length} 件`)

// ---- 文書同期 + 最終検査(AC-7) ----
let syncedDocs = []
let syncFailedTargets = []
if (budgetExceeded()) {
  log(`エージェント起動数が上限(${maxAgentInvocations})を超過しているため文書同期をスキップします`)
} else {
  const sync = await workflow('sync-docs', { base: baseBranch, release, config })
  addConsumption('docs', sync && Array.isArray(sync.updates) ? sync.updates.length + 1 : 1)
  if (!sync) {
    log('sync-docs が結果を返しませんでした(文書同期は未確認のまま続行します)')
  } else {
    syncedDocs = (sync.updates || []).map((u) => u && u.path).filter(Boolean)
    syncFailedTargets = Array.isArray(sync.failedTargets) ? sync.failedTargets : []
  }
}

// 最終検査以降は PR準備(AC-10)に合流させる: 直下の直接エージェントが無い『実装』『起票』『文書同期』は
// meta.phases から削除済みのため、修正ループが起動した場合の phase も PR準備 として扱う
phase('PR準備')

// 最終 release-check: 失敗したら別枠 2 回の修正ループ。収束しなければ起票して draft 降格
const finalGate = await gate1Loop(2, 'PR準備', 'finalCheck', '最終検査')
const finalCheck = finalGate.lastCheck
let finalCheckDegraded = false
if (!finalGate.passed) {
  finalCheckDegraded = true
  const failed = finalCheck && Array.isArray(finalCheck.failed) ? finalCheck.failed : []
  const findings =
    failed.length > 0
      ? failed.map((f) => ({
          source: 'check',
          checkKey: f.check,
          severity: 'high',
          title: `最終検査 ${f.check} が失敗のまま残存`,
          detail: `${finalGate.reason}。失敗箇所: ${(f.failedItems || []).join(' / ')}`,
        }))
      : [
          {
            source: 'check',
            checkKey: 'release-check',
            severity: 'high',
            title: '最終検査が収束しませんでした',
            detail: finalGate.reason,
          },
        ]
  await fileKnownIssues(findings)
  log(`最終検査が収束せず draft PR に降格します: ${finalGate.reason}`)
}

// ---- PR 準備(AC-10): AC 充足検証 checker と PR 本文の生成 ----
const acCheck = await trackedAgent(
  'pr',
  `${ADVISOR_BAN}\nAC 充足検証: 要件ファイル ${reqPath} を読み、各 FR の AC ごとに充足状況を検証してください。\n` +
    '検証は実コードの grep・ファイル内容の実確認・下記の検査出力のみを根拠とし、実装エージェントの自己申告・作業報告文は根拠にしないこと。\n' +
    '要件側で「手動検証必須」と区分されている AC は manualRequired: true とし、自動検証だけで met: true にしないこと。\n' +
    `\n## 直近の検査結果(release-check)\n${JSON.stringify(finalCheck && finalCheck.results ? finalCheck.results : [])}`,
  {
    label: 'AC充足検証',
    phase: 'PR準備',
    schema: {
      type: 'object',
      required: ['items', 'summary'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'met', 'manualRequired', 'evidence'],
            properties: {
              id: { type: 'string', description: 'FR-XX AC-N 形式' },
              met: { type: 'boolean' },
              manualRequired: { type: 'boolean' },
              evidence: { type: 'string', description: '充足判定の根拠(grep 結果・検査出力等)' },
            },
          },
        },
        summary: { type: 'string' },
      },
    },
    model: MODELS.verify || 'sonnet',
  }
)
const acItems = acCheck && Array.isArray(acCheck.items) ? acCheck.items : []
const manualPending = acItems.filter((i) => i.manualRequired === true && i.met !== true)
if (!acCheck) {
  log('AC 充足検証エージェントが結果を返しませんでした(PR 本文には検証不能と明記します)')
}

const residualCritical = residualBlock.filter((f) => severityOf(f) === 'critical')
const residualNonCritical = residualBlock.filter((f) => severityOf(f) !== 'critical')

const prMaterial = {
  release,
  acVerification: acCheck ? { items: acItems, summary: acCheck.summary } : null,
  finalCheck: finalCheck ? { passed: finalCheck.passed, results: finalCheck.results } : null,
  reviewFixed,
  residualFindings: residualBlock.map((f) => `[${severityOf(f)}] ${f.title}(${f.file})`),
  unverifiableDimensions: unverifiableDims,
  filedIssues,
  syncedDocs,
  syncFailedTargets,
  manualPendingAcs: manualPending.map((i) => i.id),
  consumption,
  totalAgents,
}
const prDraft = await trackedAgent(
  'pr',
  ADVISOR_BAN +
    '\nリリース PR の本文(Markdown)とタイトルを生成してください。以下の材料 JSON のみを根拠とし、材料にない充足状況を捏造しないこと。本文には次のセクションを含めること:\n' +
    '1. 概要\n2. FR/AC 充足状況(acVerification の検証結果に基づく表。検証不能な場合はその旨)\n' +
    '3. 最終検査結果(finalCheck)\n4. レビュー所見と対応(reviewFixed / residualFindings / unverifiableDimensions)\n' +
    '5. 起票した known-issues ID(filedIssues)\n6. 更新したドキュメント(syncedDocs / syncFailedTargets)\n' +
    '7. 未実施の手動検証 AC(manualPendingAcs。あれば明記)\n8. 消費サマリー(consumption のフェーズ別エージェント起動数と totalAgents)\n' +
    `\n## 材料\n${JSON.stringify(prMaterial)}`,
  {
    label: 'PR本文生成',
    phase: 'PR準備',
    schema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
    model: MODELS.docSync || 'sonnet',
  }
)
const prTitle = prDraft && prDraft.title ? prDraft.title : release
const prBodyDraft = prDraft ? prDraft.body : '(PR 本文の生成に失敗しました。材料は run-release の戻り値を参照)'

// ---- コミット(AC-8): autoApprove=false はコミット直前で停止して案を返す ----
phase('コミット')
const planRes = await trackedAgent(
  'commit',
  ADVISOR_BAN +
    '\ngit status --porcelain と git diff で現在の未コミット変更を確認し、論理単位のコミット分割案を作ってください。各コミットは message(このリポジトリの既存コミットの文体に合わせる)と files(対象ファイルのリポジトリルート相対パス)で構成し、全変更ファイルをいずれか 1 つのコミットに割り当てること。この段階では git add / git commit を実行しないこと(読み取り専用)。',
  {
    label: 'コミット分割案',
    phase: 'コミット',
    schema: {
      type: 'object',
      required: ['commits'],
      properties: {
        commits: {
          type: 'array',
          items: {
            type: 'object',
            required: ['message', 'files'],
            properties: {
              message: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    model: MODELS.fix || 'sonnet',
  }
)
const commitPlan = planRes && Array.isArray(planRes.commits) ? planRes.commits : []

if (!autoApprove) {
  return await finishWith(
    'stopped',
    'autoApprove=false のためコミット直前で停止しました。commitPlan と prBodyDraft を確認し、/logical-commits(対話承認)でコミットしてください',
    { commitPlan, prBodyDraft }
  )
}

const committed = await trackedAgent(
  'commit',
  ADVISOR_BAN +
    '\n以下のコミット分割案に従って論理単位コミットを実行してください。コミットごとに対象ファイルのみを git add してから git commit すること。push は禁止。分割案が空・不完全な場合は git status で変更を確認し、適切な論理単位で全変更をコミットすること。\n' +
    `\n## コミット分割案\n${JSON.stringify(commitPlan)}`,
  {
    label: 'コミット実行',
    phase: 'コミット',
    schema: {
      type: 'object',
      required: ['commits'],
      properties: {
        commits: {
          type: 'array',
          items: { type: 'string', description: '実行したコミットのハッシュとメッセージ' },
        },
      },
    },
    model: MODELS.fix || 'sonnet',
  }
)
if (!committed) {
  return await finishWith('stopped', 'コミット実行エージェントが失敗しました。作業ツリーの状態を確認してください', {
    commitPlan,
    prBodyDraft,
  })
}

// ---- PR 作成分岐(AC-9) ----
phase('PR作成')
if (residualCritical.length > 0) {
  // critical 残存: PR を作らず停止(コミット済みのブランチ・作業状態は保全し、reset しない)
  return await finishWith(
    'no-pr',
    `critical 所見が残存するため PR を作成せず停止します: ${residualCritical.map((f) => f.title).join(' / ')}`,
    { commitPlan, prBodyDraft }
  )
}
const draftReasons = []
if (residualNonCritical.length > 0) {
  draftReasons.push(`未解決の high 所見 ${residualNonCritical.length} 件`)
}
if (finalCheckDegraded) {
  draftReasons.push('最終検査が収束せず失敗が残存')
}
if (gate2NonConvergence) {
  draftReasons.push(`レビューループ収束不能: ${gate2NonConvergence}`)
}
if (manualPending.length > 0) {
  draftReasons.push(`手動検証必須 AC が未実施: ${manualPending.map((i) => i.id).join(', ')}`)
}
const isDraft = draftReasons.length > 0
const prBody = isDraft
  ? `${prBodyDraft}\n\n## Draft 理由(未解決事項)\n${draftReasons.map((r) => `- ${r}`).join('\n')}`
  : prBodyDraft

const prRes = await trackedAgent(
  'pr',
  ADVISOR_BAN +
    '\nリリースブランチを push して PR を作成してください。手順:\n' +
    `1. git branch --show-current が ${release} であることを確認する(異なれば何もせず pushed: false で報告)\n` +
    `2. \`git push -u origin ${release}\` を実行する。実行してよい push コマンドはこれのみ。${baseBranch} への push・force push は絶対に行わないこと\n` +
    `3. gh pr create --base ${baseBranch}${isDraft ? ' --draft' : ''} で PR を作成する。タイトル: ${prTitle}\n` +
    '   本文は以下の「PR 本文」を一字一句そのまま使うこと(HEREDOC や一時ファイル経由で正確に渡す)\n' +
    '4. 作成された PR の URL を url として報告する\n' +
    `\n## PR 本文\n${prBody}`,
  {
    label: isDraft ? 'draft PR作成' : 'PR作成',
    phase: 'PR作成',
    schema: {
      type: 'object',
      required: ['pushed', 'url'],
      properties: {
        pushed: { type: 'boolean' },
        url: { type: 'string', description: '作成した PR の URL(失敗時は空文字列)' },
      },
    },
    model: MODELS.fix || 'sonnet',
  }
)
if (!prRes || prRes.pushed !== true || !prRes.url) {
  return await finishWith('stopped', 'push または PR 作成に失敗しました。ブランチとリモートの状態を確認してください', {
    commitPlan,
    prBodyDraft,
  })
}

phase('通知')
const prUrl = prRes.url
const status = isDraft ? 'draft-pr' : 'completed'
await notify(
  `run-release: ${status}`,
  `${release}: ${prUrl}${isDraft ? `(draft 理由: ${draftReasons.join(' / ')})` : ''}`
)
log(`run-release ${status}: ${prUrl}(エージェント起動数 概算 ${totalAgents})`)

return {
  status,
  prUrl,
  filedIssues,
  resolvedLogProposal,
  consumption,
  commitPlan,
  prBodyDraft,
}
