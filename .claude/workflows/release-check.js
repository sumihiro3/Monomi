export const meta = {
  name: 'release-check',
  description: 'リリース前検査: 検証コマンドを並列実行して失敗を集約報告',
  whenToUse: 'コミット・リリース前の最終検査。修正はせず検査結果の報告のみ行う',
  phases: [
    { title: '設定読み込み', detail: 'workflow.config.json の取得と検証', model: 'haiku' },
    { title: '検査', detail: '検査コマンドを並列実行', model: 'haiku' },
  ],
}

// モデル使い分けの方針: コマンド実行と結果報告のみの軽量タスク = haiku (config.models で上書き可)

// args は JSON 文字列で渡ってくる場合があるためパースする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error('args を JSON として解釈できません')
  }
}
input = input || {}

// ---- config ブートストラップ (全エンジン共通パターン) ----
phase('設定読み込み')
let config = input.config
if (!config) {
  const loaded = await agent(
    'カレントリポジトリの .claude/workflow.config.json を読んでください。存在すれば {exists: true, config: <ファイル内容そのまま>} を、存在しなければ {exists: false} を返すこと。内容の要約・省略・補完は禁止。',
    {
      label: 'config読込',
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

// 検査コマンドは config.checks (プロジェクト固有値) からのみ取得する
const CHECKS = config.checks
if (!Array.isArray(CHECKS) || CHECKS.length === 0) {
  throw new Error('config.checks が未定義または空です。workflow.config.json に検査コマンドを定義してください')
}

const CHECK_SCHEMA = {
  type: 'object',
  required: ['check', 'passed', 'detail', 'failedItems'],
  properties: {
    check: { type: 'string' },
    passed: { type: 'boolean' },
    detail: { type: 'string', description: '成功時は一言、失敗時はエラーの要点(該当箇所つき)。表示専用の自由文' },
    failedItems: {
      type: 'array',
      items: { type: 'string' },
      description:
        '失敗箇所の構造化リスト (file:line・テスト名・エラーコード等の文字列)。成功時は空配列。収束判定の入力になるため失敗時は必ず列挙すること',
    },
  },
}

phase('検査')
const checkModel = config.models?.check ?? 'haiku'
const results = await parallel(
  CHECKS.map(c => {
    const where =
      c.cwd && c.cwd !== '.' ? `カレント作業ディレクトリ配下の ${c.cwd} で` : 'カレント作業ディレクトリ(リポジトリルート)で'
    return () =>
      agent(
        `${where} \`${c.cmd}\` を実行し、結果を報告してください。失敗しても修正せず、check="${c.key}" として成否のみ返すこと。` +
          `成否は必ずコマンドの exit code で判定すること (exit 0=成功。警告が出ていても exit 0 なら成功とする。自分の品質判断を混ぜない)。` +
          `失敗時は failedItems に失敗箇所 (ファイル:行・テスト名・エラーコード等) を文字列配列で必ず列挙し、detail にエラーの要点を書くこと。` +
          `成功時は failedItems を空配列にすること。コマンド自体が実行できない場合 (コマンド不存在・起動失敗等) も passed=false とし、failedItems にその旨を含めること。`,
        { label: c.key, phase: '検査', schema: CHECK_SCHEMA, model: checkModel }
      )
  })
)

// 偽グリーン防止: エージェントが null を返した検査 (実行失敗・スキップ) は結果を捨てず failed として計上する。
// CHECKS 側を基準に走査するため、結果の欠落がそのまま失敗に現れる
const checks = CHECKS.map((c, i) => {
  const r = Array.isArray(results) ? results[i] : null
  if (!r) {
    return {
      check: c.key,
      passed: false,
      detail: '検査エージェントが結果を返しませんでした (実行失敗またはスキップ)',
      failedItems: [`agent-failure: ${c.key} の検査結果が得られませんでした`],
    }
  }
  return {
    check: r.check ?? c.key,
    passed: r.passed === true,
    detail: r.detail ?? '',
    failedItems: Array.isArray(r.failedItems)
      ? r.failedItems
      : r.passed === true
        ? []
        : [`schema-violation: ${c.key} の failedItems が未報告です`],
  }
})

// 結果数 ≠ 検査数は検査基盤の異常なので、個別成否によらず passed=false にする
const countMismatch = !Array.isArray(results) || results.length !== CHECKS.length
if (countMismatch) {
  log(`検査結果数 (${Array.isArray(results) ? results.length : 0}) が検査数 (${CHECKS.length}) と一致しません — passed=false として扱います`)
}

const failed = checks.filter(c => !c.passed)
log(failed.length === 0 ? (countMismatch ? '結果数不一致のため失敗扱い' : '全検査パス') : `${failed.length} 件の検査が失敗`)

return {
  passed: !countMismatch && failed.length === 0,
  results: checks,
  failed,
}
