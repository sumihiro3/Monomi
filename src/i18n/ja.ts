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

  // pr.*（PR 状態表示ラベル。FR-05c で追加、FR-05d detail-view で使用）
  'pr.none': 'PR なし',
  'pr.awaitingReview': 'レビュー待ち',
  'pr.changesRequested': '修正を要求',
  'pr.approved': '承認済み',
  'pr.merged': 'マージ済み',
  // release-27 FR-05d: draft PR の区別表示（detail-view のみで使用）
  'pr.draft': 'ドラフト',

  // detail.*
  'detail.overview': '概要',
  'detail.eventHistory': 'イベント履歴',
  'detail.noEvents': '(イベントがありません)',
  'detail.fetchFailed': '詳細の取得に失敗しました: {error}',
  'detail.loading': '読み込み中…',
  'detail.elapsedSuffix': '{age}経過',
  'detail.running': '実行中',
  'detail.terminal': 'ターミナル',
  'detail.runningKind.workflow': 'ワークフロー',
  'detail.runningKind.agent': 'エージェント',
  'detail.runningKind.skill': 'スキル',

  // help.*
  'help.title': 'キーバインド',
  'help.filterToggle': '一覧: 状態フィルタのトグル（複数選択可）',
  'help.moveOrScroll': '一覧: カーソル移動 / 詳細: イベント履歴スクロール',
  'help.openDetail': '一覧: プロジェクト詳細を開く',
  'help.moveProject': '詳細: 隣接プロジェクトへ移動',
  'help.toggleWrap': '詳細: イベント行の折り返し/切り詰め切替',
  'help.focusTerminal': '一覧 / 詳細: セッション実行中のターミナルへフォーカス移動',
  'help.back': '戻る / ヘルプを閉じる',
  'help.toggleHelp': 'ヘルプの表示/非表示',
  'help.quit': '終了',

  // app.*
  'app.errorPrefix': 'エラー: ',
  'app.watching': 'WATCHING',

  // list.*
  'list.empty': '(該当するインスタンスがありません)',

  // focus.*（release-23-terminal-focus FR-05。notFound/failed は Ghostty 特有のつまずき
  // （アクセシビリティ許可・環境変数）の案内を含む）
  'focus.otherDevice':
    'このセッションは別デバイス上で実行中です。フォーカスは同一デバイスのセッションでのみ動作します。',
  'focus.noTerminalInfo': 'このセッションのターミナル情報がありません。',
  'focus.sessionClosed':
    'このセッションは既に終了しています。フォーカスするターミナルがありません。',
  'focus.tmuxDetached': 'tmux セッションに接続中のクライアントがありません。',
  'focus.notFound':
    'ターミナルタブが見つかりませんでした。Ghostty をお使いの場合は、monomi を実行しているアプリのアクセシビリティ許可（システム設定 → プライバシーとセキュリティ → アクセシビリティ）を付与し、環境変数 CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 を設定してください。',
  'focus.unsupported': 'このプラットフォームではフォーカスに対応していません。',
  'focus.failed':
    'ターミナルへのフォーカスに失敗しました。Ghostty をお使いの場合は、monomi を実行しているアプリのアクセシビリティ許可（システム設定 → プライバシーとセキュリティ → アクセシビリティ）を付与し、環境変数 CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 を設定してください。',

  // cli.*
  'cli.usage': `Monomi — a status dashboard for Claude Code across machines

使い方:
  monomi                          稼働中 instance をダッシュボード表示（Ink）
  monomi hub                       hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
  monomi hub stop                  稼働中の hub を停止（SIGTERM・終了確認後 pid ファイル削除）
  monomi hub status                hub の状態を表示（稼働中(pid/port)・停止中・stale pid）
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
  'cli.hub.addrInUse':
    'monomi hub: 起動に失敗しました — ポートが既に使用されています (EADDRINUSE)。hub が既に稼働中の可能性があります。`monomi hub status` で確認してください。\n\n元のエラー: {message}',
  'cli.hubAutostart.timeout':
    'monomi: hub の自動起動に失敗しました — タイムアウト内に疎通確認できませんでした。{hubLogFile} を確認するか、`monomi hub status` で状態を確認、または `monomi hub` で手動起動してください。',
  'cli.hubStatus.running': 'hub は稼働中です（pid {pid}, port {port}, version {version}）。',
  'cli.hubStatus.runningPidUnknown':
    'hub は稼働中です（port {port}, version {version}。pid は不明）。',
  'cli.hubStatus.versionUnknown': '不明',
  'cli.hubStatus.stopped': 'hub は稼働していません。',
  'cli.hubStatus.stale':
    'hub は稼働していません — stale な pid ファイルが見つかりました（pid {pid}）。次回 hub 起動時に自動的に上書きされます。',
  'cli.hubStop.stopped': 'hub を停止しました（pid {pid}）。',
  'cli.hubStop.timedOut':
    'hub（pid {pid}）へ SIGTERM を送信しましたが、待機時間内に終了しませんでした。まだ稼働中の可能性があります。`monomi hub status` で確認するか、再度お試しください。',
  'cli.hubStop.alreadyStopped': 'hub は稼働していません。停止処理は不要です。',
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
  'cli.installHooks.weztermWslHint':
    "ヒント: Windows で WezTerm を使っていますか? Windows 側の .wezterm.lua に `WSLENV = 'WEZTERM_PANE'` を追記すると `f` キーでのペイン単位フォーカスが使えます（README の「WezTerm: pane-level focus」節を参照）。",
  'cli.uninstallHooks.success':
    'Monomi のフックを削除しました: {settingsPath} から {removed} 件除去',
  'cli.setupPrompt.confirm': 'install-hooks を実行しますか? [Y/n] ',
  'cli.setupPrompt.notice':
    'ステータスレポート用のフックがまだ登録されていません。有効にするには `monomi install-hooks` を実行してください。',
  'cli.setupPrompt.installFailure':
    'フックの自動インストールに失敗しました（{message}）。再試行するには `monomi install-hooks` を実行してください。',

  // autoUpdate.*（起動時の hub 版照合・自動再起動 notice、release-25-auto-update FR-02 AC-7）
  'autoUpdate.hubRestarted':
    'hub が旧版（{hubVersion}）だったため、現在の版（{selfVersion}）へ自動的に再起動しました。',
  'autoUpdate.restartFailed':
    'hub の自動更新に失敗しました — 待機時間内に停止できなかったため、旧版（{hubVersion}）のまま稼働を継続しています。`monomi hub status` で確認するか、`monomi hub stop` を試してから再度起動してください。',
  'autoUpdate.cliOutdated':
    'hub の方が新しい版（{hubVersion}）で稼働しています（この CLI は {selfVersion}）。`npx monomi-cli@latest` などで CLI を更新してください。',
  'autoUpdate.hubMismatchSuppressed':
    'hub の版（{hubVersion}）と CLI の版（{selfVersion}）が異なりますが、auto_update が無効なため自動更新は行いませんでした。有効にするには ~/.monomi/config.yml に `auto_update: true` を設定するか、手動で hub を再起動してください。',

  // autoUpdate.reporter*（起動時の reporter 版マーカー照合・自動再配置 notice、release-25-auto-update FR-03）
  'autoUpdate.reporterUpdated':
    'reporter スクリプト（~/.monomi/monomi-report.sh）が旧版（{reporterVersion}）だったため、現在の版（{selfVersion}）へ自動的に再配置しました。',
  'autoUpdate.reporterMismatchSuppressed':
    'reporter スクリプト（~/.monomi/monomi-report.sh）の版（{reporterVersion}）と CLI の版（{selfVersion}）が異なりますが、auto_update が無効なため自動再配置は行いませんでした。有効にするには ~/.monomi/config.yml に `auto_update: true` を設定するか、`monomi install-hooks` を手動で実行してください。',
  'autoUpdate.reporterNewerThanCli':
    '設置済みの reporter スクリプト（~/.monomi/monomi-report.sh）の方が新しい版（{reporterVersion}）です（この CLI は {selfVersion}）。`npx monomi-cli@latest` などで CLI を更新してください。',
  'autoUpdate.reporterUpdateFailed':
    'reporter スクリプト（~/.monomi/monomi-report.sh）の自動更新に失敗しました（{message}）。旧版（{reporterVersion}）のまま稼働を継続しています。`monomi install-hooks` を手動で実行して再試行してください。',

  // autoUpdate.remoteHubOutdated（child のリモート hub 版ずれ可視化、release-25-auto-update FR-04）
  'autoUpdate.remoteHubOutdated':
    '接続中の hub が旧版です（hub: {hubVersion} / この CLI: {selfVersion}）。hub デバイス側で更新してください（この CLI からリモートの hub を再起動することはできません）。',
} satisfies Record<TranslationKey, string>
