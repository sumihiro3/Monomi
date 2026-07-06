export const meta = {
  name: 'sync-docs',
  description: '実装差分をドキュメント (README/architecture 等) に同期する',
  whenToUse: '実装・レビュー完了後のドキュメント同期。args: {base: "main", release: "release-1", config: {...}} で差分の比較先・対象リリース・設定を指定(いずれも省略可。config 省略時は .claude/workflow.config.json を読む)',
  phases: [
    { title: '設定読込', detail: 'workflow.config.json の読込と検証', model: 'haiku' },
    { title: '差分把握', detail: '変更内容の要約', model: 'sonnet' },
    { title: '同期', detail: 'ドキュメントを並列更新', model: 'sonnet' },
  ],
}

// モデル使い分けの方針: 設定読込 = haiku / ドキュメント化 = config.models.docSync (既定 sonnet)

// args は JSON 文字列で渡ってくる場合があるためパースする。
// パース失敗を {} へ潰すと base/release/config の指定が黙って消えるため、明示エラーにする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error(
      `sync-docs: args の JSON パースに失敗しました (${e.message})。{base, release, config} 形式の JSON を渡してください`
    )
  }
}
input = input || {}

// config ブートストラップ: args.config 優先、未指定なら .claude/workflow.config.json を読む
phase('設定読込')
let config = input.config
if (!config) {
  const loaded = await agent(
    'カレントリポジトリの .claude/workflow.config.json を読み、存在すれば {exists: true, config: <ファイル内容そのまま>}、無ければ {exists: false} を返してください。内容の要約・省略・補完は禁止。',
    {
      label: 'config読込',
      phase: '設定読込',
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
if (config.configVersion !== 1) {
  throw new Error(
    `workflow.config.json の configVersion (${config.configVersion}) がエンジン要求版 (1) と一致しません`
  )
}

const base = input.base || config.baseBranch || 'main'
const release = input.release || ''
const docSyncModel = (config.models && config.models.docSync) || 'sonnet'
const CWD = 'カレント作業ディレクトリ(リポジトリルート)で作業すること。'

// 同期先・凍結・除外はすべて config.syncDocs から取得する(本文にプロジェクト固有の文書名を置かない)
const syncDocs = config.syncDocs || {}
const targets = Array.isArray(syncDocs.targets) ? syncDocs.targets : []
if (targets.length === 0) {
  throw new Error(
    'config.syncDocs.targets が空です。同期先ドキュメント {path, instruction} を workflow.config.json に定義してください'
  )
}
const untouchable = [
  ...(Array.isArray(syncDocs.frozen) ? syncDocs.frozen : []),
  ...(Array.isArray(syncDocs.excluded) ? syncDocs.excluded : []),
]
const untouchableNote =
  untouchable.length > 0
    ? `\n次の文書は凍結・除外指定のため、内容の乖離があっても変更しないこと: ${untouchable.join(', ')}`
    : ''

phase('差分把握')
const diffSummary = await agent(
  `${CWD}git diff ${base}... と git status / git diff(未コミット分)を確認し、今回の変更内容を要約してください: 追加・変更されたモジュール/機能、ユーザーに見える変更、開発環境の変更(依存関係・ビルドコマンド)。ドキュメント更新の判断材料になる粒度で。${release ? `対象リリース: ${release}` : ''}`,
  { label: '差分要約', phase: '差分把握', model: docSyncModel }
)
if (!diffSummary) {
  throw new Error('差分要約エージェントが失敗しました。差分要約なしでは同期できないため中断します')
}

phase('同期')
const updates = await parallel(
  targets.map(
    t => () =>
      agent(
        `${CWD}以下の変更要約をもとにドキュメントを同期してください。${untouchableNote}\n\n## 同期指示\n${t.instruction}\n\n## 変更要約\n${diffSummary}`,
        { label: `${t.path}更新`, phase: '同期', model: docSyncModel }
      ).then(r => ({ path: t.path, result: r }))
  )
)

// parallel は入力順を保つため、updates[i] は targets[i] に対応する
const failedTargets = updates
  .map((u, i) => (u && u.result ? null : (u && u.path) || targets[i].path))
  .filter(Boolean)
log(
  failedTargets.length === 0
    ? `${targets.length} 件の同期先を処理完了`
    : `同期エージェント失敗: ${failedTargets.join(', ')}`
)

return {
  diffSummary,
  updates,
  failedTargets,
}
