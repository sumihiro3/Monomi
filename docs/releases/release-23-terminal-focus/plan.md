# release-23-terminal-focus 実装計画: `f` キーでセッション実行中ターミナルへフォーカス移動

- 起票元: 既知課題 U9（`docs/known-issues.md`）
- 計画確定日: 2026-07-15（壁打ち済み。要件の確定は本ディレクトリの `requirements.md` が正）
- 参考実装: [claude-code-monitor](https://github.com/onikan27/claude-code-monitor)（方式調査済み）

## 確定スコープ

| 項目                   | 決定                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| 対象ターミナル         | **Terminal.app / Ghostty / tmux 併用**（iTerm2・VS Code は対象外だが strategy 追加で拡張できる構造にする）    |
| 対応 OS                | **macOS + WSL2**（WSL2 は Windows Terminal のウィンドウ前面化どまりの best-effort。Linux ネイティブは対象外） |
| 別デバイスのセッション | **f キー無効化 + 理由メッセージ表示**。フッターヒントも同一デバイス時のみ表示（device_id 照合）               |

## 方式の要点（claude-code-monitor 調査より）

- 紐付けキーは **TTY**（`/dev/ttys003` 等）。フックプロセスは Claude Code の子なので `ps -o tty= -p` で ppid チェーンを辿って解決する（環境変数は使わない）
- **Terminal.app**: AppleScript で windows/tabs を走査し `tty of aTab` 一致 → タブ選択 + ウィンドウ前面化
- **Ghostty**: AppleScript から tty が取れない → TTY デバイスファイルへ OSC タイトルタグ（`\x1b]0;monomi:ttys003\x07`）を一時書き込み → System Events で Window メニューをタグ名検索してクリック（2回 + AXRaise）→ finally でタグ消去。アクセシビリティ権限と `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` が前提
- **tmux**: フックから見える TTY は tmux ペインの pts であり外側タブの TTY ではない → reporter は `$TMUX_PANE`/`$TMUX` を送り、フォーカス時に `tmux list-clients` でクライアント TTY を解決して switch-client + 外側ターミナルを前面化
- AppleScript への文字列埋め込みはサニタイズ必須（インジェクション対策）

## データフロー

```
reporter (bash, 毎フック)
  └─ TTY / TERM_PROGRAM / tmux / WSL を捕捉 → payload.terminal（新設・optional）
       └─ hub: rawEventPayloadSchema → EventIngestionService.ingest
            └─ sessions テーブル新設列へ UPDATE（最新スナップショット）
                 └─ InstanceStatusService.buildRow → SessionDto.terminal
                      └─ CLI: f キー → device_id 照合 → FocusService（strategy 分離）
                           └─ tmux switch-client → osascript (Terminal.app/Ghostty) / powershell.exe (WSL2)
```

## 実装ステップ

### 1. 要件確定・ブランチ

- `docs/releases/release-23-terminal-focus/requirements.md` を FR/AC 形式で確定（`/refine-requirements` 経由）。スコープ外を明記: iTerm2 / VS Code / Linux ネイティブ / `sessions.pid` の充填 / Ghostty 用 env の自動設定 / `wt_session` によるタブ単位フォーカス
- `release-23-terminal-focus` ブランチを main から作成

### 2. reporter（`reporter/monomi-report.sh`）

- **毎フックで捕捉**（SessionStart 限定は不可: `--resume` で同一 session_id が別 TTY で再開しうる）。コストは ps 2〜3 回 + env 参照のみ
- bash 3.2 互換の `resolve_tty()`: `$$` から ppid チェーンを最大 15 段辿り、`ps -o tty=` が `??` 以外を返した最初の値に `/dev/` を前置
- env 捕捉: `$TERM_PROGRAM`（tmux 内は `tmux` になる点に注意）、`$TMUX_PANE` + `$TMUX`（socket は `${TMUX%%,*}`）、`$WSL_DISTRO_NAME`、`$WT_SESSION`（将来用に列だけ確保）
- ペイロードに `terminal` ネストオブジェクトを追加（`tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session`、取得不能は null）。**jq 経路と bash フォールバック（`json_escape` 適用）の両方**に実装
- `sessions.pid` は今回も埋めない（中間シェルが挟まり pid 同定が脆い。TTY で足りる）

### 3. スキーマ / DB

- `src/hub/dto.ts`: `rawEventPayloadSchema` に `terminal` を `.nullable().optional()` で追加（各フィールド max 長付き）。`TerminalDto` 新設、`SessionDto` に `terminal: TerminalDto | null` 追加、`toTerminalDto()` 変換関数（A6 で確立の「ドメイン型→薄い変換→wire DTO」パターン踏襲）
- `src/db/ddl.ts`: `sessions` に `tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session` TEXT、`terminal_seen_at` INTEGER を追加
- **新規 `src/db/migrations.ts`**: 列追加の前例がないため、`PRAGMA table_info(sessions)` で欠落列のみ `ALTER TABLE ADD COLUMN` する冪等 `applyMigrations(db)` を新設。`src/db/database.ts` の `openDatabase()` で `db.exec(DDL)` 直後に呼ぶ。新規 DDL と ALTER 適用済み旧 DB の table_info 一致をテストで固定
- `src/domain/entities.ts`: `Session.terminal` 追加
- `src/db/repositories/session-repository.ts`: `updateTerminal(sessionId, info, at)` + `toSession()` 拡張

### 4. hub

- `src/hub/event-ingestion-service.ts` `ingest()`: `payload.terminal` が **undefined/null でないときのみ** `updateTerminal` を呼ぶ（旧 reporter の欠落で既存値を NULL 上書きしない。新 reporter の明示 snapshot は tty:null でも採用）
- `src/hub/instance-status-service.ts` `buildRow()`: 代表セッションの terminal を `SessionDto.terminal` に充填
- 後方互換: 旧 hub 応答に `terminal` が無ければ CLI は「情報なし」として f 無効化 + notice（`RunningWorkDto.started_at` と同じ混在許容方針）

### 5. CLI フォーカスモジュール（新規 `src/cli/focus/`）

```
focus-service.ts          # 判定 + ディスパッチ（FocusResult = ok | no_terminal | tmux_detached | not_found | unsupported_platform | error）
focus-target.ts           # DTO → FocusTarget の検証付き写像（インジェクション防御の関所）
osascript.ts              # ExecFileFn 型 + runOsascript()（hub-autostart.ts の SpawnFn 注入パターン踏襲）
applescript.ts            # escapeAppleScriptString() + スクリプト組み立て（純粋関数）
terminal-app-strategy.ts  # tty 一致タブ選択 + 前面化
ghostty-strategy.ts       # OSC タイトルタグ + System Events メニュー検索（finally でタグ復元）
tmux-strategy.ts          # list-clients でクライアント TTY 解決（0件→tmux_detached、複数→client_activity 最大）→ switch-client/select-window/select-pane
wsl-strategy.ts           # powershell.exe で Windows Terminal 前面化（best-effort）
```

- ディスパッチ: tmux_pane があれば先に tmux 側を切替え、外側クライアント TTY で続行 → darwin は `term_program` ヒントで並べ替えた**総当たり**（tmux 内は TERM_PROGRAM=tmux でヒント不能のため総当たりが本命）→ WSL は `WSL_DISTRO_NAME` / `/proc/version` で判定
- 検証: `tty` は `/^\/dev\/[A-Za-z0-9._\/-]+$/` + `..` 拒否、`tmux_pane` は `/^%\d+$/`、socket は絶対パス・制御文字/引用符なし。AppleScript 埋め込みは必ずエスケープ経由。子プロセスは `execFile`（非 shell）
- strategy interface（`matchesHint` + `focus(tty)`）で iTerm2 等を配列追加のみで拡張可能に

### 6. CLI 配線

- `src/cli/key-binding-controller.ts`: `KeyBindingHost` に `focusTerminal()` 追加。`handleKey()` の viewMode 共通部（escape/?/q の並び）に `f` 分岐 → **list / detail 両ビューで有効**（`f` は未使用・衝突なし）
- `src/cli/components/app-view.tsx`: props に `localDeviceId` と `focusRunner`（DI、テストで mock）。`focusTerminal` の実装: ①行なし→no-op ②`device.id !== localDeviceId`→notice ③`status.display === 'closed'`→notice（stale TTY 誤爆防止）④terminal 情報なし/検証不合格→notice ⑤実行して失敗時のみ notice。トースト機構は無いので既存 `error` state に倣った時限式 `notice` state（~4s、cleanup + アンマウントガード付き）を追加。`footerHint` は同一デバイス選択時のみ ` f focus` を表示
- `src/cli.ts` `runDashboard()`: `loadConfig().deviceId ?? deriveDeviceId(os.hostname())`（bootstrap.ts と同一規則）と FocusService を注入
- `src/cli/components/help-overlay.tsx`: `HELP_LINES` に f 行追加
- `src/i18n/en.ts`（authoritative）→ `ja.ts`: `help.focusTerminal`、`focus.otherDevice` / `focus.noTerminalInfo` / `focus.sessionClosed` / `focus.tmuxDetached` / `focus.notFound` / `focus.unsupported` / `focus.failed`（Ghostty はアクセシビリティ許可 + `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` のヒント文言）

### 7. ドキュメント同期・検査・PR

- `docs/ARCHITECTURE.md`（reporter 捕捉 / DDL / マイグレーション / payload 例 / f キー / フォーカス strategy の新節 / リリース表に release-23）、`docs/design/class-diagram.md`（FocusService 群 + `SessionRepository.updateTerminal`）、`docs/known-issues.md`（**U9 を解決済みへ**。新規起票: Ghostty の前提設定は手動）、`README.md` / `README.ja.md`（f キー・権限・Ghostty の settings.json `env` 手動追記手順）
- `docs/releases/release-23-terminal-focus/e2e-verification.md`（実機手動チェックリスト。release-3 の運用パターン踏襲）
- `pnpm run lint` / `format:check` / `test` / `build` → logical-commits → PR

**設計判断: `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` は install-hooks で自動設定しない。** 全ターミナルで Claude Code の動的タイトルを殺す副作用が大きく、settings.json への書き込み範囲拡大も避ける（U12 関連）。README + 失敗時 notice で案内する。

## テスト方針

- reporter: `reporter/monomi-report.test.sh` に env 設定 → payload の `terminal` 検証（jq 有無両経路）、旧形式が 2xx のまま、SessionEnd ワースト時間（<3000ms）回帰
- hub/DB: ingestion（更新・欠落時保持・null snapshot）、migrations（旧 DB → 列追加・冪等・新規 DDL と一致）、repository、instance-status-service の写像
- focus: focus-target / applescript の純粋関数（インジェクション文字列の拒否含む）、各 strategy は `ExecFileFn` モックでコマンド・引数・stdout 判定を検証、focus-service のディスパッチ順
- CLI: key-binding-controller（list/detail 両モードで f）、app-view（ink-testing-library: mock focusRunner の呼び出し/非呼び出し、notice 表示、フッター出し分け）
- osascript/powershell の実実行はユニット対象外 → e2e-verification.md の実機チェックリストへ

## 主要リスクと対応

| リスク                                              | 対応                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| TTY 再利用・stale TTY                               | `closed` 中は f をゲート。live での不一致は AppleScript 側で見つからず `not_found` notice（安全側） |
| Ghostty のアクセシビリティ権限 / タイトル上書き競合 | 失敗時 notice に許可手順ヒント。タグ書込→検索は 1 回リトライ、finally で必ずタグ復元                |
| tmux デタッチ中 / 複数クライアント                  | 0件→notice、複数→client_activity 最大を採用                                                         |
| reporter 由来値のインジェクション                   | focus-target の厳格検証 + AppleScript エスケープ + execFile（非 shell）の三段防御                   |
| 旧 reporter / 旧 hub 混在                           | 欠落 = 「情報なし」縮退。zod optional/strip で双方向に 400 を出さない                               |

## 検証（実機）

1. Terminal.app で複数タブ + 複数プロジェクトの Claude Code を起動 → Monomi で選択 → `f` → 該当タブが前面化
2. Ghostty（`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` 設定済み）で同様 + アクセシビリティ許可ダイアログの導線確認
3. tmux: attach 中に別 window のセッションへ `f` → window 切替 + 外側ターミナル前面化。detach 中は notice
4. 別デバイス（Mac mini ⇄ MacBook）の行で `f` → notice、フッターに f ヒントが出ないこと
5. WSL2: Windows Terminal が前面化すること（best-effort）
6. 旧 reporter（terminal 未送信）の行で `f` → 「情報なし」notice
