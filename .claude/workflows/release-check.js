export const meta = {
  name: 'release-check',
  description: 'リリース前検査: 検証コマンドを並列実行して失敗を集約報告',
  whenToUse: 'コミット・リリース前の最終検査。修正はせず検査結果の報告のみ行う',
  phases: [{ title: '検査', detail: '検査コマンドを並列実行', model: 'haiku' }],
}

// モデル使い分けの方針: コマンド実行と結果報告のみの軽量タスク = haiku

const CHECK_SCHEMA = {
  type: 'object',
  required: ['check', 'passed', 'detail'],
  properties: {
    check: { type: 'string' },
    passed: { type: 'boolean' },
    detail: { type: 'string', description: '成功時は一言、失敗時はエラーの要点(該当箇所つき)' },
  },
}

// {PLACEHOLDER}: プロジェクトの検証コマンドに置き換えること。
// この配列は要素数固定ではない — プロジェクトの層/言語の数だけ { key, cmd } を自由に追加・削除してよい。
// 単一スタック (例: TS のみ) なら 4 件のままでよいし、Yagura のように Rust+Vue の 2 層構成なら
// 層ごとに fmt/lint/test/build を分けて 6 件以上に増やす (下記コメント参照)。
const CHECKS = [
  { key: 'lint', cmd: 'pnpm run lint' },
  { key: 'format', cmd: 'pnpm run format:check' },
  { key: 'test', cmd: 'pnpm run test' },
  { key: 'build', cmd: 'pnpm run build' },
  // 複数層/複数言語がある場合の追加例 (不要な行は削除、必要な行は複製して増やす):
  // { key: 'backend-fmt', cmd: 'cargo fmt --all -- --check' },
  // { key: 'backend-lint', cmd: 'cargo clippy --workspace --all-targets -- -D warnings' },
  // { key: 'backend-test', cmd: 'cargo test --workspace' },
  // { key: 'e2e', cmd: 'pnpm run test:e2e' },
]

phase('検査')
const results = await parallel(
  CHECKS.map(
    c => () =>
      agent(
        `リポジトリ /opt/dev/Monomi で \`${c.cmd}\` を実行し、結果を報告してください。失敗しても修正せず、check="${c.key}" として成否とエラーの要点(ファイル:行)のみ返すこと。`,
        { label: c.key, phase: '検査', schema: CHECK_SCHEMA, model: 'haiku' }
      )
  )
)

const checks = results.filter(Boolean)
const failed = checks.filter(c => !c.passed)
log(failed.length === 0 ? '全検査パス' : `${failed.length} 件の検査が失敗`)

return {
  passed: failed.length === 0,
  results: checks,
  failed,
}
