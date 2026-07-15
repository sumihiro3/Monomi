# release-23-terminal-focus 要件定義

- リリース識別子: `release-23-terminal-focus`
- ステータス: 確定
- 作成日: 2026-07-15
- 対応する設計・参照資料: [実装計画](plan.md) / `docs/known-issues.md` **U9** / 参考実装 [claude-code-monitor](https://github.com/onikan27/claude-code-monitor)（方式調査済み）

## 背景と目的

複数プロジェクトで Claude Code を並行運用していると、ダッシュボードで「権限待ち」「次の指示待ち」に気づいてから該当ターミナルのタブを手で探すコストが大きい。ダッシュボードでプロジェクト（instance）を選択中にキー 1 発（`f`）で、そのセッションが実行中のターミナルタブへフォーカスを移せるようにする（既知課題 **U9** の対応）。

方式は claude-code-monitor の調査結果に基づく: reporter がフック実行時に TTY 等のターミナル特定情報を捕捉して hub へ送り、CLI がフォーカス時に AppleScript（Terminal.app: tty 一致 / Ghostty: OSC タイトルタグ + System Events）と tmux switch-client で該当タブを前面化する。

## スコープの確定（壁打ちでの決定事項）

| 論点 | 決定 |
|---|---|
| 対象ターミナル | **Terminal.app / Ghostty / tmux 併用**。iTerm2・VS Code は対象外だが、strategy の配列追加のみで拡張できる構造にする |
| 対応 OS | **macOS + WSL2**。WSL2 は Windows Terminal のウィンドウ前面化どまりの best-effort。Linux ネイティブは対象外 |
| 別デバイスのセッション選択時 | `f` キー無効化 + 理由メッセージ（notice）表示。フッターヒントも同一デバイス選択時のみ表示（device_id 照合）。フォーカス移動は CLI と同一マシンのセッションに限定 |
| 捕捉タイミング | 毎フックイベントで捕捉（`--resume` で同一 session_id が別 TTY で再開しうるため SessionStart 限定は不可） |
| `sessions.pid` の充填 | 今回もしない（フックの ppid チェーンに中間シェルが挟まり pid 同定が脆い。紐付けは TTY で足りる）。将来の stale-TTY 緩和策として温存 |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`（Ghostty 前提設定） | install-hooks で自動設定しない（全ターミナルで動的タイトルを殺す副作用が大きい）。README 記載 + フォーカス失敗時の notice ヒントで案内 |

## 機能要件

本リリースの全 FR は既知課題 **U9** に対応する。

### FR-01: reporter のターミナル特定情報の捕捉（優先度: 必須）

- 場所: `reporter/monomi-report.sh`、`reporter/monomi-report.test.sh`
- AC-1: 毎フックイベントで、bash 3.2 互換の `resolve_tty()`（`$$` から ppid チェーンを最大 15 段辿り、`ps -o tty=` が `??`/空以外を返した最初の値に `/dev/` を前置）により TTY を解決し、ペイロードの `terminal.tty` に設定する。非 TTY 実行（CI 等）では null になる
- AC-2: `$TERM_PROGRAM`・`$TMUX_PANE`・`$TMUX` の socket（`${TMUX%%,*}`）・`$WSL_DISTRO_NAME`・`$WT_SESSION` を捕捉し、`terminal` オブジェクト（`tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session`、取得不能は null）としてペイロードへ含める。`tmux_pane`/`tmux_socket` は `$TMUX` が非空のときのみ設定する
- AC-3: jq 経路と bash フォールバック経路の両方で `terminal` を組み立てる。bash フォールバックでは各値に `json_escape` を適用する
- AC-4: `terminal` 追加後も SessionEnd のワースト実行時間テスト（< 3000ms）が通る

### FR-02: hub のイベントスキーマ・DB 拡張（優先度: 必須）

- 場所: `src/hub/dto.ts`、`src/db/ddl.ts`、`src/db/migrations.ts`（新規）、`src/db/database.ts`、`src/domain/entities.ts`、`src/db/repositories/session-repository.ts`、`src/hub/event-ingestion-service.ts`
- AC-1: `rawEventPayloadSchema` に `terminal` を `.nullable().optional()` のネストオブジェクト（各フィールドに max 長付き）として追加する。`terminal` キーを含まない旧 reporter のペイロードが引き続き 2xx で受理される
- AC-2: `sessions` テーブルに `tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session`（TEXT）・`terminal_seen_at`（INTEGER）を追加する
- AC-3: 新規 `src/db/migrations.ts` の `applyMigrations(db)` が `PRAGMA table_info(sessions)` で欠落列のみ `ALTER TABLE ADD COLUMN` する冪等マイグレーションを行い、`openDatabase()` が DDL 適用直後に呼ぶ。「旧 DDL 相当の DB へ適用で列追加」「再実行で冪等」「新規 DDL と ALTER 適用済み旧 DB の table_info 一致」をテストで固定する
- AC-4: `session-repository.ts` に `updateTerminal(sessionId, info, at)` を追加し、`toSession()` の写像を拡張する（`Session.terminal` は `src/domain/entities.ts` に追加）
- AC-5: `ingest()` は `payload.terminal` が undefined/null でないときのみ `updateTerminal` を呼ぶ（旧 reporter の欠落で既存値を NULL 上書きしない。新 reporter の明示スナップショットは `tty: null` でもそのまま採用する）

### FR-03: hub API へのターミナル情報の露出（優先度: 必須）

- 場所: `src/hub/dto.ts`、`src/hub/instance-status-service.ts`
- AC-1: `TerminalDto`（snake_case wire）を新設し、`SessionDto` に `terminal: TerminalDto | null` を追加する。変換は `toTerminalDto()`（「ドメイン型→薄い変換→wire DTO」パターン踏襲）
- AC-2: `buildRow()` が代表セッションの terminal を `session.terminal` に充填する。情報なしは null（CLI は null/欠落を「情報なし」として扱う後方互換方針）

### FR-04: CLI フォーカス実行モジュール（優先度: 必須）

- 場所: `src/cli/focus/`（新規: `focus-service.ts`、`focus-target.ts`、`osascript.ts`、`applescript.ts`、`terminal-app-strategy.ts`、`ghostty-strategy.ts`、`tmux-strategy.ts`、`wsl-strategy.ts` と各テスト）
- AC-1: `focus-target.ts` が wire DTO を厳格検証して `FocusTarget` へ写す: `tty` は `/^\/dev\/[A-Za-z0-9._\/-]+$/` かつ `..` 非含有、`tmux_pane` は `/^%\d+$/`、`tmux_socket` は絶対パスかつ制御文字・引用符なし。不合格は「情報なし」に縮退する。インジェクション文字列の拒否をテストで固定する
- AC-2: AppleScript への文字列埋め込みは `escapeAppleScriptString()`（`\` と `"` のエスケープ）を必ず経由し、子プロセス起動は `execFile`（非 shell）で行う。外部プロセスはコンストラクタ/引数注入の `ExecFileFn` 型で差し替え可能にする（`hub-autostart.ts` の `SpawnFn` パターン踏襲）
- AC-3: terminal-app-strategy: AppleScript で Terminal.app の windows/tabs を走査し `tty of aTab` 一致でタブ選択 + ウィンドウ前面化 + activate。osascript の stdout `true` で成功判定する
- AC-4: ghostty-strategy: TTY デバイスファイルへ OSC タイトルタグ（`monomi:<tty basename>`）を書き込み → System Events で Ghostty の Window メニューをタグ名で検索してクリック（2 回 + AXRaise）→ 成否によらず finally でタグを消去する。失敗時は 1 回リトライする
- AC-5: tmux-strategy: `tmux -S <socket> list-clients` でクライアントを解決し、0 件なら `tmux_detached`、複数なら `client_activity` 最大を採用。`switch-client`/`select-window`/`select-pane` を実行し、クライアント TTY を返す
- AC-6: focus-service のディスパッチ: `tmux_pane` があれば先に tmux 側を切り替えて外側クライアント TTY で続行 → darwin では `term_program` ヒントで並べ替えた総当たり（Terminal.app / Ghostty）→ WSL（`WSL_DISTRO_NAME` または `/proc/version` の `microsoft`）では wsl-strategy → それ以外は `unsupported_platform`。結果は `FocusResult`（`ok | no_terminal | tmux_detached | not_found | unsupported_platform | error`）で返す
- AC-7: wsl-strategy: `powershell.exe` 経由で Windows Terminal のウィンドウを前面化する（best-effort。タブ単位の特定はスコープ外）
- AC-8: strategy は共通インターフェイス（ヒント一致判定 + `focus(tty)`）を持ち、iTerm2 等の追加が配列への追加のみで済む構造にする

### FR-05: CLI 配線 — `f` キー・device_id 照合・notice 表示（優先度: 必須）

- 場所: `src/cli/key-binding-controller.ts`、`src/cli/components/app-view.tsx`、`src/cli/components/help-overlay.tsx`、`src/cli.ts`、`src/i18n/en.ts`、`src/i18n/ja.ts`
- AC-1: `KeyBindingHost` に `focusTerminal()` を追加し、`f` が list / detail 両ビューで `focusTerminal` にディスパッチされ `handleKey` が `true` を返す
- AC-2: 選択行の `device.id` が CLI 自身の device_id（`loadConfig().deviceId ?? deriveDeviceId(os.hostname())`）と異なる場合、フォーカス実行を呼ばず理由 notice（`focus.otherDevice`）を表示する
- AC-3: `status.display === 'closed'` の行（stale TTY 誤爆防止）、terminal 情報なし/検証不合格の行では、それぞれ理由 notice でゲートしフォーカス実行を呼ばない
- AC-4: フォーカス成功時は notice を出さず（タブ移動自体がフィードバック）、失敗時のみ理由別 notice（`focus.tmuxDetached`/`focus.notFound`/`focus.unsupported`/`focus.failed` 等）を表示する。notice は約 4 秒で自動消去され、タイマーの cleanup とアンマウント後 setState 防止ガードを持つ
- AC-5: フッターヒントは同一デバイスの行を選択中のときのみ ` f focus` 相当の表示を出す
- AC-6: ヘルプオーバーレイに `f` の行を追加し、`focus.*`/`help.focusTerminal` の i18n キーが `en.ts`（authoritative）と `ja.ts` の両方に存在する（Ghostty 失敗時の文言にはアクセシビリティ許可と `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` のヒントを含める）
- AC-7: `runDashboard()` が localDeviceId と FocusService（既定実装）を `AppView` へ注入し、テストでは mock の `focusRunner` を注入して「同一デバイス行で呼ばれる / 別デバイス行で呼ばれない / notice 表示 / フッター出し分け」を検証する

### FR-06: ドキュメント整備と実機検証チェックリスト（優先度: 必須）

- 場所: `docs/ARCHITECTURE.md`、`docs/design/class-diagram.md`、`docs/known-issues.md`、`README.md`、`README.ja.md`、`docs/releases/release-23-terminal-focus/e2e-verification.md`（新規）
- AC-1: ARCHITECTURE.md に reporter のターミナル捕捉・sessions 新列と冪等マイグレーション・payload 例の `terminal`・`session.terminal`・`f` キー・フォーカス機能（strategy 構成とセキュリティ検証）の記述を追加し、段階リリース表に release-23 行を足す
- AC-2: known-issues.md の U9 を解決済みへ移動し、「Ghostty フォーカスはアクセシビリティ許可と `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` の手動設定が前提（自動設定しない設計判断）」を新規起票する
- AC-3: README.md / README.ja.md に `f` キーの使い方・macOS の権限・Ghostty 利用時の `~/.claude/settings.json` への env 手動追記手順を記載する
- AC-4: `e2e-verification.md` に実機チェックリスト（Terminal.app 複数タブ / Ghostty + アクセシビリティ許可 / tmux attach・detach / 別デバイス行の notice とヒント非表示 / WSL2 前面化 / 旧 reporter 行の「情報なし」notice）を作成する
- AC-5: 実機受け入れ試験（手動検証必須）— e2e-verification.md のチェックリストのうち Terminal.app・tmux・別デバイスの項目を実機で確認すること（Ghostty・WSL2 は環境が用意でき次第でよい）

## 非機能要件

- **性能**: reporter の追加処理は `ps` 2〜3 回 + 環境変数参照のみに抑え、SessionEnd 高速経路のワースト実行時間テスト（< 3000ms）を維持する（FR-01 AC-4）
- **セキュリティ**: reporter 由来の値は「認証済みだが信頼しない」（S9/S12 と同じ脅威モデル）。focus-target の厳格検証 + AppleScript エスケープ + `execFile`（非 shell）の三段防御とする（FR-04 AC-1/AC-2）
- **互換性**: 旧 reporter ↔ 新 hub、新 reporter ↔ 旧 hub の混在で双方向に 400 を出さない（zod optional / strip）。DB は既存ファイルに対する冪等マイグレーションで、ダウングレード時も列が余るだけで動作に影響しない

## スコープ外

- iTerm2 / VS Code 統合ターミナルへのフォーカス対応（strategy 追加で将来対応可能な構造のみ用意）
- Linux ネイティブ（X11/Wayland）対応
- `sessions.pid` の充填（将来の stale-TTY 緩和策として列のみ温存）
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` の install-hooks による自動設定
- `wt_session` を使った Windows Terminal のタブ単位フォーカス（データ捕捉のみ行う）
- ネストした tmux（tmux in tmux）の解決

## 未解決事項

- Ghostty の Window メニュー構成・System Events 挙動はバージョン差がありうる。実機検証（FR-06 AC-5）で確認し、動かない場合は notice のヒント文言で案内する（リリースブロッカーにはしない）

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-23-terminal-focus", config: <.claude/workflow.config.json の内容>}})
```
