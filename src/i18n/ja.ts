import type { TranslationKey } from './en.js'

/**
 * 日本語ロケールの翻訳テーブル（release-9-i18n FR-01 AC-4）。
 *
 * `satisfies Record<TranslationKey, string>` により `en.ts` の `EN`（authoritative）とのキー集合の
 * 過不足を型チェック時に検出する。キーの typo・追加漏れ・削除漏れはここでコンパイルエラーになる
 * （AC-4 のテストシームは型チェックそのものであり、`pnpm vitest` だけでは検出できない点に注意。
 * `pnpm tsc --noEmit` あるいは `pnpm build` で確認する）。
 *
 * @remarks
 * `EN` と同様、このオブジェクトをモジュールスコープの const で定義するのは問題ない
 * （テーブルそのもの）。危険なのは `t()` の呼び出しをモジュールスコープで行うことのみ
 * （`../i18n/index.js` 参照）。
 */
export const JA = {
  // status.*
  'status.active': '稼働中',
  'status.approvalWait': '権限待ち',
  'status.nextWait': '次の指示待ち',
  'status.prWait': 'PRレビュー待ち',
  'status.stale': '放置',
  'status.closed': '終了',

  // detail.*
  'detail.overview': '概要',
  'detail.eventHistory': 'イベント履歴',
  'detail.noEvents': '(イベントがありません)',
  'detail.fetchFailed': '詳細の取得に失敗しました: {error}',
  'detail.loading': '読み込み中…',
  'detail.elapsedSuffix': '{age}経過',

  // help.*
  'help.title': 'キーバインド',
  'help.filterToggle': '一覧: 状態フィルタのトグル（複数選択可）',
  'help.moveOrScroll': '一覧: カーソル移動 / 詳細: イベント履歴スクロール',
  'help.openDetail': '一覧: 詳細（Agent View Lv.1）を開く',
  'help.moveProject': '詳細: 隣接プロジェクトへ移動',
  'help.toggleWrap': '詳細: イベント行の折り返し/切り詰め切替',
  'help.back': '戻る / ヘルプを閉じる',
  'help.toggleHelp': 'ヘルプの表示/非表示',
  'help.quit': '終了',

  // app.*
  'app.errorPrefix': 'エラー: ',

  // list.*
  'list.empty': '(該当するインスタンスがありません)',

  // cli.*
  'cli.usage': `Monomi — a status dashboard for Claude Code across machines

使い方:
  monomi                          稼働中 instance をダッシュボード表示（Ink）
  monomi hub                       hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
  monomi hub pair                  6桁ペアリングコードを発行し到達先候補 URL を表示（hub 側）
  monomi hub devices list          登録デバイス一覧を表示（トークン有効/失効つき）
  monomi hub devices revoke <id>   device のトークンを失効（以後その token は 401）
  monomi pair --code <code> [--hub <url> ...]  hub とペアリングし token+設定を保存（child 側。
                                    --hub は複数指定可、指定順が到達優先順）
  monomi install-hooks              Claude Code の7フックを ~/.claude/settings.json へ登録
  monomi uninstall-hooks            Monomi 起因のフックのみ除去
  monomi --version, -v              バージョンを表示
  monomi --help, -h                 このヘルプを表示`,
  'cli.unknownCommand': 'monomi: 不明なコマンドです: "{command}"',
  'cli.hub.unknownSubcommand': 'monomi hub: 不明なサブコマンドです: "{sub}"',
  'cli.hub.childRoleGuard':
    'monomi hub: このデバイスは role:child として設定されています。`monomi hub` は hub デバイス上でのみ実行するか、~/.monomi/config.yml に role:hub を設定してください。',
  'cli.pair.unknownOption': 'monomi pair: 不明なオプションです: "{option}"',
  'cli.pair.valueRequired': 'monomi pair: {flag} には値が必要です',
  'cli.pair.codeRequired':
    'monomi pair: --code <code> は必須です。hub デバイスで `monomi hub pair` を実行してコードを取得してください。',
  'cli.hubDevices.deviceIdRequired': 'monomi hub devices revoke: <device_id> 引数が必須です。',
  'cli.hubDevices.unknownAction':
    'monomi hub devices: 不明なアクションです: "{action}"。"list" または "revoke <device_id>" を使用してください。',
  'cli.hubDevices.listEmpty':
    'まだ登録済みのデバイスがありません。先に hub を起動する（monomi hub）か、デバイスをペアリングしてください。',
  'cli.hubDevices.revokeSuccess':
    'デバイス "{deviceId}" のトークンを {revoked} 件失効しました。再接続するにはそのデバイスは再度ペアリングが必要です。',
  'cli.installHooks.success':
    'Monomi のフックをインストールしました: {settingsPath} に {added} 件追加（陳腐化した {removed} 件を置き換え）',
  'cli.uninstallHooks.success':
    'Monomi のフックを削除しました: {settingsPath} から {removed} 件除去',
} satisfies Record<TranslationKey, string>
