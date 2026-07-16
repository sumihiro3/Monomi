import os from 'node:os'
import path from 'node:path'

/**
 * Monomi 起因のフックであることを示すセンチネル（マーカー）。
 *
 * FR-01 の未解決事項（冪等マージの共存判定基準）を「Monomi 起因マーカー方式」で確定する。
 * settings.json は JSON でありコメントを持てないため、マーカーは **command 文字列末尾の
 * bash コメント** として埋め込む。`bash ... #monomi:v1` の `#` 以降はシェルでは無視される一方、
 * 文字列としては部分一致で確実に判別できる。
 *
 * この方式を選ぶ理由:
 *  - Claude Code が settings.json を読み書き（往復）しても、command 文字列は逐語的に保存される
 *    ため、マーカーが消えない。フックエントリに独自フィールドを足す方式は、zod 等のスキーマで
 *    未知キーが除去されるとマーカーごと失われ、冪等性判定が壊れうる。
 *  - コメント非対応の JSON でも、シェル実行時に副作用を持たずに識別子を運べる。
 *
 * バージョン接尾辞（`:v1`）は将来フック定義を作り替える際、旧世代マーカーを一括除去してから
 * 再登録する（remove-then-add）ための世代識別に使う。
 */
export const MONOMI_HOOK_MARKER = '#monomi:v1'

/**
 * install-hooks が登録する reporter スクリプトの既定パス（**`resolvePaths()` を無指定で呼んだ
 * ときの既定 home、`~/.monomi` に reporter を配置する場合専用**）。
 *
 * reporter/README.md の「install-hooks からの登録」契約に合わせ `~/.monomi/monomi-report.sh` を
 * 既定にする。`~` は Claude Code がフックを実行するシェルで語頭展開されるため、そのまま使える。
 * テストや配置換えのため {@link buildHookDefinitions} の引数で上書きできる。
 *
 * install-hooks.ts の配置ロジック（`fs.copyFileSync`/`fs.chmodSync`）は `~` を展開できない Node の
 * `fs` API を直接使うため絶対パスの `paths.home`（`resolvePaths()`、`MONOMI_HOME` 環境変数を反映）
 * で配置先を解決する。`MONOMI_HOME` などで `paths.home` が既定と異なる場合、フック command 文字列
 * にはこの定数ではなく `paths.home` 起点の絶対パスを使う必要がある（`installHooks` 内の
 * `defaultReporterScriptFor` が担う）。両者が乖離すると reporter は配置されるのにフックが別パス
 * を呼び出し、状態レポートがサイレントに失敗する（FR-02）。
 */
export const DEFAULT_REPORTER_SCRIPT = '~/.monomi/monomi-report.sh'

/** Claude Code の `~/.claude/settings.json` の既定パス。 */
export function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

/**
 * 1 個の Monomi フック定義。settings.json の 1 matcher グループ（1 command エントリ）に対応する。
 */
export interface MonomiHookDefinition {
  /** フックイベント名（`settings.json` の `hooks` 直下のキー）。 */
  event: string
  /** matcher 文字列。省略時は matcher なしのグループ（全発火にマッチ）。 */
  matcher?: string
  /** 登録する command 文字列（マーカー込み）。 */
  command: string
}

/**
 * matcher を持たない一般フックのイベント名（§4 のうち release-1 で観測するもの）。
 *
 * `SessionStart`/`UserPromptSubmit`/`Stop`/`SessionEnd` は matcher を取らない。
 * `PreToolUse`/`PostToolUse` は matcher `*`（全ツール）で別途登録する。
 */
const PLAIN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const

/** matcher `*`（全ツールにマッチ）で登録するツール系フックイベント名。 */
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'] as const

/**
 * `Notification` フックの matcher 別サブタイプ（§0.5）。
 *
 * `permission_prompt` → 権限待ち、`idle_prompt` → 次の指示待ち。reporter へは
 * `--subtype <値>` で matcher を明示的に渡す（reporter/README.md の呼び出し規約）。
 */
const NOTIFICATION_SUBTYPES = ['permission_prompt', 'idle_prompt'] as const

/**
 * reporter スクリプトを起動する command 文字列を組み立てる。マーカーは常に末尾へ付く。
 *
 * @param reporterScript reporter スクリプトのパス。
 * @param subtype `Notification` の matcher（`--subtype` で渡す）。省略時は付けない。
 * @returns `bash <script> [--subtype <subtype>] #monomi:v1` 形式の command。
 */
export function buildHookCommand(reporterScript: string, subtype?: string): string {
  const base = subtype ? `bash ${reporterScript} --subtype ${subtype}` : `bash ${reporterScript}`
  return `${base} ${MONOMI_HOOK_MARKER}`
}

/**
 * ある command 文字列が Monomi 起因かどうかをマーカーで判定する。
 *
 * @param command settings.json 内の command 文字列。
 * @returns Monomi マーカーを含むなら `true`。
 */
export function isMonomiCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes(MONOMI_HOOK_MARKER)
}

/**
 * 同梱 reporter スクリプト内の版マーカー行にマッチする正規表現（release-25-auto-update FR-03）。
 *
 * `MONOMI_HOOK_MARKER`/{@link isMonomiCommand} と同じ「機械可読マーカーを1箇所に集約する」先例に
 * 倣う。reporter は bash スクリプトでコメントを構造化データとして扱えないため、行頭からの
 * 変数代入 `MONOMI_REPORTER_VERSION="<値>"` そのものをマーカーとして使う（reporter/monomi-report.sh
 * 冒頭の変数群を参照）。キャプチャグループは値（バージョン文字列、プレースホルダの場合もある）。
 */
const REPORTER_VERSION_LINE_RE = /^MONOMI_REPORTER_VERSION="([^"]*)"$/m

/**
 * reporter スクリプトのテキストへ版マーカーの値を注入する（配置時 = `deployReporterScript` から
 * 呼ぶ。ビルド時の版同期は不要にするための実行時注入）。
 *
 * マーカー行が見つからない場合（改変・旧世代の reporter 等）は何もせず入力をそのまま返す —
 * reporter 本体の配置自体は失敗させない（FR-03 の「reporter を壊さない」方針に合わせる）。
 *
 * @param scriptText reporter スクリプトの全文。
 * @param version 注入するバージョン文字列（`MONOMI_VERSION`）。
 * @returns マーカー行の値を置き換えた全文（マーカー無しなら入力そのまま）。
 */
export function injectReporterVersion(scriptText: string, version: string): string {
  return scriptText.replace(REPORTER_VERSION_LINE_RE, `MONOMI_REPORTER_VERSION="${version}"`)
}

/**
 * 設置済み reporter スクリプトのテキストから版マーカーの値を取り出す（起動時の版照合 /
 * `ensureReporterUpToDate` から呼ぶ）。
 *
 * マーカー行が無い（旧世代の reporter・手動改変で行ごと消えた等）場合は `undefined` を返す。
 * 呼び出し側（`version-compare.ts` の `compareVersion`）はこれを「版不明」として扱い、
 * 更新経路では `'older'` と同じ扱いにする（「版不明 = 旧版」ポリシー）。
 *
 * @param scriptText 設置済み reporter スクリプトの全文。
 * @returns マーカー行の値（プレースホルダのまま・空文字列のこともある）。マーカー行が無ければ `undefined`。
 */
export function extractReporterVersion(scriptText: string): string | undefined {
  const match = REPORTER_VERSION_LINE_RE.exec(scriptText)
  return match ? match[1] : undefined
}

/**
 * release-1 で登録する Monomi フック定義一式を返す。
 *
 * 7 フックイベント（`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/
 * `Notification`/`Stop`/`SessionEnd`）を網羅する。`Notification` は matcher 別に 2 エントリ
 * （`permission_prompt`/`idle_prompt`）へ分割するため、定義数は 8 になる。
 *
 * @param reporterScript reporter スクリプトのパス（既定 {@link DEFAULT_REPORTER_SCRIPT}）。
 * @returns フック定義の配列。
 */
export function buildHookDefinitions(
  reporterScript: string = DEFAULT_REPORTER_SCRIPT
): MonomiHookDefinition[] {
  const definitions: MonomiHookDefinition[] = []

  for (const event of PLAIN_EVENTS) {
    definitions.push({ event, command: buildHookCommand(reporterScript) })
  }

  for (const event of TOOL_EVENTS) {
    definitions.push({ event, matcher: '*', command: buildHookCommand(reporterScript) })
  }

  for (const subtype of NOTIFICATION_SUBTYPES) {
    definitions.push({
      event: 'Notification',
      matcher: subtype,
      command: buildHookCommand(reporterScript, subtype),
    })
  }

  return definitions
}
