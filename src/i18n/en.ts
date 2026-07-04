/**
 * 英語ロケールの翻訳テーブル（release-9-i18n FR-01 AC-4）。authoritative / ground truth。
 *
 * `TranslationKey` はこのオブジェクトのキー集合から導出する（{@link TranslationKey}）。
 * ここに無いキーはそもそも `TranslationKey` の型に存在しないため、新しいキーを追加するときは
 * 必ずこのファイルへ先に足し、`ja.ts` の `JA` を `satisfies Record<TranslationKey, string>` で
 * 追随させる（キーの過不足は型チェックで検出される）。
 *
 * アクティブなロケールのテーブルに無いキーは、この `EN` の値へフォールバックする
 * （`../i18n/index.js` の `translate`/`t` 参照。AC-5）。
 *
 * @remarks
 * この `EN` オブジェクト自体をモジュールスコープの const で定義するのは問題ない
 * （テーブルそのものであり、アクティブロケールの解決を経ないため）。危険なのは
 * `t()` の呼び出しをモジュールスコープの const 初期化で行うこと
 * （import 時点のアクティブロケール — 常に既定の `en` — で文言が凍結される）。
 * `t()` は必ず関数内・描画時に評価すること（`../i18n/index.js` 参照）。
 */
export const EN = {
  // status.*（§10.2 の状態ラベル。CLI 表示専用の状態語彙、release-9-i18n FR-02 AC-2 で最優先移行）
  'status.active': 'Active',
  'status.approvalWait': 'Awaiting approval',
  'status.nextWait': 'Awaiting next instruction',
  'status.prWait': 'Awaiting PR review',
  'status.stale': 'Stale',
  'status.closed': 'Closed',

  // detail.*（Agent View Lv.1 詳細ビュー）
  'detail.overview': 'Overview',
  'detail.eventHistory': 'Event History',
  'detail.noEvents': '(No events)',
  'detail.fetchFailed': 'Failed to fetch details: {error}',
  'detail.loading': 'Loading…',
  'detail.elapsedSuffix': '{age} elapsed',

  // help.*（ヘルプオーバーレイ。8行の説明 + タイトル）
  'help.title': 'Key Bindings',
  'help.filterToggle': 'List: toggle status filters (multi-select)',
  'help.moveOrScroll': 'List: move cursor / Detail: scroll event history',
  'help.openDetail': 'List: open project detail',
  'help.moveProject': 'Detail: move to adjacent project',
  'help.toggleWrap': 'Detail: toggle event line wrap/truncate',
  'help.back': 'Back / close help',
  'help.toggleHelp': 'Toggle help',
  'help.quit': 'Quit',

  // app.*（AppView 全体のエラー表示接頭辞・ watching インジケータ）
  'app.errorPrefix': 'Error: ',
  'app.watching': 'WATCHING',

  // list.*（一覧 0 件時の案内）
  'list.empty': '(No matching instances)',

  // cli.*（`monomi` bin の USAGE・エラーメッセージ・成功メッセージ）
  'cli.usage': `Monomi — a status dashboard for Claude Code across machines

Usage:
  monomi                          show running instances as a dashboard (Ink)
  monomi hub                       start the hub API server (DB init + bootstrap + HTTP)
  monomi hub pair                  issue a 6-digit pairing code and show reachable URLs (hub side)
  monomi hub devices list          list registered devices (with token active/revoked status)
  monomi hub devices revoke <id>   revoke a device's token (that token becomes 401 afterwards)
  monomi pair --code <code> [--hub <url> ...]  pair with the hub and save token+config (child side.
                                    --hub may repeat; the order given sets reach priority)
  monomi install-hooks              register Claude Code's 7 hooks into ~/.claude/settings.json
  monomi uninstall-hooks            remove only the hooks Monomi added
  monomi --version, -v              show the version
  monomi --help, -h                 show this help`,
  'cli.unknownCommand': 'monomi: unknown command "{command}"',
  'cli.hub.unknownSubcommand': 'monomi hub: unknown subcommand "{sub}"',
  'cli.hub.childRoleGuard':
    "monomi hub: this device is configured as role:child. Run 'monomi hub' only on the hub device, or set role:hub in ~/.monomi/config.yml.",
  'cli.pair.unknownOption': 'monomi pair: unknown option "{option}"',
  'cli.pair.valueRequired': 'monomi pair: {flag} requires a value',
  'cli.pair.codeRequired':
    'monomi pair: --code <code> is required. Get a code with `monomi hub pair` on the hub device.',
  'cli.hubDevices.deviceIdRequired':
    'monomi hub devices revoke: a <device_id> argument is required.',
  'cli.hubDevices.unknownAction':
    'monomi hub devices: unknown action "{action}". Use "list" or "revoke <device_id>".',
  'cli.hubDevices.listEmpty':
    'No devices registered yet. Start the hub (monomi hub) or pair a device first.',
  'cli.hubDevices.revokeSuccess':
    'Revoked {revoked} token(s) for device "{deviceId}". That device must pair again to reconnect.',
  'cli.installHooks.success':
    'Monomi hooks installed: {added} entry(ies) in {settingsPath} ({removed} stale entry(ies) replaced)',
  'cli.uninstallHooks.success': 'Monomi hooks removed: {removed} entry(ies) from {settingsPath}',
} as const

/** 翻訳キーの型。{@link EN} のキー集合から導出する（release-9-i18n FR-01 AC-4）。 */
export type TranslationKey = keyof typeof EN
