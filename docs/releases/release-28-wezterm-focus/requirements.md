# release-28-wezterm-focus 要件定義

- リリース識別子: `release-28-wezterm-focus`
- ステータス: 確定
- 作成日: 2026-07-19
- 対応する設計・参照資料: `docs/ARCHITECTURE.md` §14（ターミナルフォーカス）/ `docs/known-issues.md` **U17** / [release-23-terminal-focus requirements.md](../release-23-terminal-focus/requirements.md)（原設計）

## 背景と目的

release-23-terminal-focus で実装した `f` キーによるターミナルフォーカス機能は、WSL2 環境では Windows Terminal のウィンドウ前面化止まりの best-effort で、タブ/ペイン単位の特定ができない（既知課題 **U17**）。U17 起票時点（2026-07-16）の調査で、Windows Terminal 自体に既存タブを外部から特定・選択する API が無く（microsoft/terminal のタブ単位フォーカス要望 #19783 が未実装、`wt focus-tab` はインデックス指定のみで対象特定手段が無く、外部実行で新規タブが開くバグ #19324 もある）、Warp も同様に既存タブへのフォーカス手段が無い（warpdotdev/warp #8611 未実装）ことが判明済みだった。一方 WezTerm は公式 CLI（`wezterm cli list` / `activate-pane --pane-id <id>`）でタブ/ペイン単位の確実な制御ができる。

本リリースは、WSL2 のフォーカス対象を Windows Terminal から WezTerm へ切り替え、あわせて macOS 上で WezTerm を使っているユーザーにも同じ仕組みを適用する（WezTerm はクロスプラットフォームで動作するため、1 つの実装を複数 OS で再利用できる）。壁打ち当初はネイティブ Linux も対象に含めていたが、実機検証を受けてスコープから外した（「スコープの確定」表の追記・「未解決事項」参照）。

**技術的な残存リスク**: WSL の interop 経由で Windows 側の `wezterm.exe cli` を呼び出す方式について、upstream の議論（wezterm/wezterm discussions #6964）では類似の操作（`cli set-user-var`）が WSL からの実行でサイレント失敗する報告があり、`activate-pane` が同様の制約を受けるかは実機検証で確認するまで確証がない（詳細は「未解決事項」）。

## スコープの確定（壁打ちでの決定事項）

| 論点                                                                         | 決定                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WSL2 既存 Windows Terminal 前面化（`wsl-strategy.ts`）の扱い                 | **WezTerm 優先＋フォールバックで温存**。`wezterm_pane` を検出できたときは WezTerm 経由のフォーカスを先に試行し、未検出（未設定/従来ユーザー）またはフォーカス失敗時は既存の Windows Terminal 前面化へフォールバックする（後方互換維持）                    |
| macOS 上の WezTerm ユーザー対応                                              | **同時にスコープへ含める**。現状 macOS の WezTerm ユーザーは `term_program` がどの darwin strategy にもヒットせず `not_found` になっており、同じ実装を `darwinStrategies` へ追加コスト小で再利用できるため                                                 |
| WSL 以外のネイティブ Linux（X11/Wayland）で WezTerm を使っている場合の対応   | **含める**。`wezterm-strategy` は wezterm CLI 呼び出しのみで完結し X11/Wayland のウィンドウ操作 API に依存しないため、既存の「Linux ネイティブ（X11/Wayland）は対象外」という制約（汎用ターミナルの前面化には X11/Wayland API が要る）とは別枠で対応できる |
| tmux と WezTerm を併用している場合（tmux pane が WezTerm pane 内で動く構成） | **スコープ外**。既存の tmux 優先ロジック（`switch-client` → 外側クライアント TTY で以降の判定を続行）はそのまま維持し、WezTerm 側のペイン特定は行わない                                                                                                    |

> **上表「WSL 以外のネイティブ Linux」の決定は、実機検証を受けて撤回した（2026-07-23）。** 壁打ち時点の前提「`wezterm-strategy` は wezterm CLI 呼び出しのみで完結し X11/Wayland のウィンドウ操作 API に依存しない」は、macOS の実機検証で `wezterm cli activate-pane` 単体では OS レベルのウィンドウ前面化が行われないことが判明したことで崩れた（macOS では AppleScript による追加の前面化ステップが必要だった）。ネイティブ Linux 向けに X11/Wayland 非依存な前面化手段を検証できなかったため、未検証のまま「対応」と謳うのを避け、当初 FR-04 AC-4 で追加したネイティブ Linux 対応をスコープから外した（壁打ちでの決定、既知課題 U21）。`focus-service.ts` のディスパッチ構造（`weztermStrategy` オプション）自体は汎用のまま残しており、`cli.ts` から配線していないだけなので、前面化手段が見つかり実機検証できれば再対応できる。詳細はセクション9（未解決事項の後段）参照。

## 機能要件

本リリースの全 FR は既知課題 **U17** に対応する。

### FR-01: reporter が `$WEZTERM_PANE` を捕捉（優先度: 必須）

- 場所: `reporter/monomi-report.sh`、`reporter/monomi-report.test.sh`
- AC-1: 毎フックイベントで `${WEZTERM_PANE:-}` を捕捉し、`terminal.wezterm_pane` としてペイロードへ含める（取得不能・空文字列は null。既存の `tmux_pane`/`wt_session` と同じ捕捉規約）。捕捉タイミングは他のターミナル特定情報と同じく毎フックとする（`--resume` で同一 session_id が別ペインで再開しうるため SessionStart 限定は不可）
- AC-2: jq 経路・bash フォールバック経路（`json_escape` 適用）の両方で `wezterm_pane` を組み立てる
- AC-3: `wezterm_pane` 追加後も SessionEnd 高速経路のワースト実行時間テスト（< 3000ms）が通る
- AC-4: WSL2 環境で `$WEZTERM_PANE` が未設定（Windows 側 `.wezterm.lua` の `WSLENV` 転送設定が無い場合）のとき、`terminal.wezterm_pane` は他の未検出フィールドと同様に null になり、reporter はエラーにしない

### FR-02: hub のイベントスキーマ・DB・API 拡張（優先度: 必須）

- 場所: `src/hub/dto.ts`、`src/db/ddl.ts`、`src/db/migrations.ts`、`src/domain/entities.ts`、`src/db/repositories/session-repository.ts`、`src/hub/event-ingestion-service.ts`
- AC-1: `rawEventPayloadSchema` の `terminal` に `wezterm_pane`（`.nullable().optional()`、max 長つき）を追加する。`wezterm_pane` キーを含まない旧 reporter のペイロードが引き続き 2xx で受理される
- AC-2: `sessions` テーブルに `wezterm_pane`（TEXT）列を追加する
- AC-3: `src/db/migrations.ts` の `TABLE_MIGRATIONS`（`sessions` エントリ）へ `wezterm_pane` を追加し、既存 DB への冪等な列追加（`PRAGMA table_info` 差分適用、再実行しても結果が変わらないこと）をテストで固定する
- AC-4: `session-repository.ts` の `updateTerminal()`/`toSession()` の写像を拡張する（`Session.terminal.weztermPane` を `src/domain/entities.ts` に追加）
- AC-5: `event-ingestion-service.ts` の `ingest()` は、他のターミナルフィールドと同じ規約（旧 reporter の欠落で既存値を NULL 上書きしない。新 reporter の明示スナップショットは `wezterm_pane: null` でもそのまま採用する）で `payload.terminal.wezterm_pane` を `updateTerminal` へ渡す
- AC-6: `TerminalDto`（`src/hub/dto.ts`）に `wezterm_pane: string | null` を追加し、`toTerminalDto()` の変換に含める。`GET /api/v1/instances`・`GET /api/v1/instances/:id` の `session.terminal.wezterm_pane` として露出する

### FR-03: `focus-target.ts` の検証拡張と `wezterm-strategy.ts` 新設（優先度: 必須）

- 場所: `src/cli/focus/types.ts`、`src/cli/focus/focus-target.ts`、`src/cli/focus/wezterm-strategy.ts`（新規）、`src/cli/focus/wezterm-strategy.test.ts`（新規）
- AC-1: `FocusTarget`（`types.ts`）に `weztermPane: string | null` を追加する
- AC-2: `focus-target.ts` に `wezterm_pane` の検証を追加する（`/^\d+$/` のみ許容、それ以外は「情報なし」へ縮退。既存 `tmuxPane` 検証と同じ縮退規約）。シェルメタ文字・空白等を含むインジェクション文字列の拒否をテストで固定する
- AC-3: `wezterm-strategy.ts` に `WeztermFocusStrategy` を新設する。`execFile`（非 shell）で `<command> cli activate-pane --pane-id <weztermPane>` を実行する。`command` はコンストラクタ引数で注入可能にする（呼び出し側が macOS/Linux ネイティブでは `wezterm`、WSL2 では `wezterm.exe` を渡す）
- AC-4: `WeztermFocusStrategy.focus()` は、実行成功（exit 0）を `ok`、バイナリ不在（`ENOENT`）を `not_found`、その他の失敗を `error` として返す
- AC-5: `WeztermFocusStrategy` は既存の `ExecFileFn` 注入パターン（`hub-autostart.ts` の `SpawnFn`・`wsl-strategy.ts` の `ExecFileFn` を踏襲）で実装し、テストでは実プロセスを起動せずコマンド・引数・結果判定を検証する
- AC-6: pane-id は `execFile` の引数配列要素として渡し、shell を経由しない。AC-2 の正規表現検証で数字以外を拒否済みであることと合わせ、シェルインジェクションの経路が無いことをテストで確認する
- AC-7（review-changes 修正）: `execFile` には既定 5000ms のタイムアウトを設定し（`gh` CLI 呼び出しの `GH_EXEC_TIMEOUT_MS` と同じ思想）、タイムアウト（Node の `execFile` `timeout` オプションによる自動 kill）は AC-4 の「その他の失敗」＝ `error` として扱う。`wezterm`/`wezterm.exe` がハングしても `focus()` が無期限に解決しないことをテストで固定する。加えて `WeztermFocusStrategy` インスタンス単位で in-flight ガードを持ち、前回呼び出しが未完了のうちは新規に `execFile` を起動せず進行中の Promise を共有する（`f` キー連打による子プロセス蓄積の防止）
- AC-8（review-changes 修正）: `WeztermFocusStrategyOptions.verifyActivation`（既定 `false`）を追加する。`true` のとき `activate-pane` 成功後に `<command> cli list --format json` を実行し、対象 pane id が結果に実在しなければ `ok` ではなく `error` を返す（一覧取得自体の失敗・解析失敗も同様に `error`）。WSL interop 経由の呼び出しは exit 0 でもサイレント失敗しうる（未解決事項参照）ため `cli.ts` の WSL 用インスタンスでのみ `true` を渡し、`FocusService.focusWsl` の既存 Windows Terminal フォールバックが確実に機能するようにする。darwin/ネイティブ Linux は既定 `false` のまま（挙動変更なし）
- AC-9（実機検証で判明した所見への対応）: `WeztermFocusStrategyOptions.raiseWindow?: () => Promise<void>` を追加する。`wezterm cli activate-pane` は mux 内部のペイン選択のみを変え OS レベルのウィンドウ前面化を行わないことが macOS 実機で判明した（`wezterm cli --help` にも `activate-window` 相当のサブコマンドは無い）ため、`activate-pane`／`verifyActivation` 成功後に前面化を行う関数を注入できるようにする。`raiseWindow` が例外を投げた場合は `activate-pane` 自体の成否に関わらず `error` に丸める。`cli.ts` は darwin インスタンスへ `raiseWeztermWindowDarwin`（AppleScript `tell application "WezTerm" to activate`、System Events で `WezTerm` プロセス存在確認後に実行。B12 と同種のガード。macOS 実機で動作確認済み）、WSL 用インスタンスへ `raiseWeztermWindowWsl`（`wsl-strategy.ts` と同型の `SetForegroundWindow`、`wezterm-gui` プロセス対象。実機で動作確認済み — ただし WezTerm 経由で起動した WSL2 シェルに限る、未解決事項参照）を渡す。ネイティブ Linux 用インスタンスには渡さない（X11/Wayland 依存を避けるため、ペイン切替のみの best-effort）
- AC-10（実機検証で判明した所見への対応）: `WeztermFocusStrategy` のコンストラクタ第1引数を `string | readonly string[]` へ拡張し、配列の場合は先頭から順に候補コマンドを試す。ENOENT（バイナリ不在）のときのみ次候補へ進み、それ以外の失敗は即座に確定する。WezTerm.org 配布の macOS アプリを Homebrew Cask 経由でなく直接インストールした場合、`wezterm` バイナリが PATH に追加されない構成が一般的であることが実機検証で判明したため、`cli.ts` の darwin インスタンスは `['wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm']` を渡す

### FR-04: `focus-service.ts` のディスパッチ再設計（優先度: 必須）

- 場所: `src/cli/focus/focus-service.ts`、`src/cli/focus/types.ts`（`Strategy` インターフェイス）、`src/cli/focus/terminal-app-strategy.ts`、`src/cli/focus/ghostty-strategy.ts`（signature 追従のみ、挙動変更なし）
- AC-1: `Strategy.focus(tty: string)` を `Strategy.focus(target: FocusTarget)` へ拡張する。既存 strategy（Terminal.app・Ghostty）は内部で `target.tty` を参照するよう追従するのみで挙動は変えない。これにより tty ベースでない `WeztermFocusStrategy`（`target.weztermPane` を使う）も同一インターフェイスへ乗せられる
- AC-2: darwin ディスパッチ（`focusDarwin`）の `darwinStrategies` 配列へ `WeztermFocusStrategy`（`command: 'wezterm'`）を追加する。`matchesHint` は `target.termProgram === 'WezTerm'` で判定し、既存の hint 順総当たりロジック（`orderByHint`）はそのまま利用する
- AC-3: WSL2 分岐を「`target.weztermPane` があれば `WeztermFocusStrategy`（`command: 'wezterm.exe'`）を先に試行し、結果が `ok` 以外なら既存の `wslStrategy`（Windows Terminal 前面化）へフォールバックする」形へ変更する。`weztermPane` が無ければ従来どおり即座に `wslStrategy` を呼ぶ（後方互換）
- AC-4: 非 darwin・非 WSL2（ネイティブ Linux 等）の分岐を新設する: `FocusServiceOptions.weztermStrategy` が配線されていれば `target.weztermPane` があるとき試行しその結果を返し、無ければ従来どおり `unsupported_platform` を返す。**（実機検証後に撤回、上記スコープ表の追記・未解決事項参照）** `cli.ts` の既定実装では `weztermStrategy` を意図的に配線しない（既知課題 U21）ため、実際には常に `unsupported_platform` になる。ディスパッチ構造自体（`weztermStrategy` オプションの汎用性）は維持し、`focus-service.test.ts` で動作を検証済み
- AC-5: tmux 経由（`tmuxPane` があるケース）で解決した外側クライアント TTY に対しても、AC-2〜AC-4 の分岐がそのまま適用される（tmux 優先ロジック自体は変更しない）。tmux 併用時の WezTerm ペイン特定はスコープ外のため、`weztermPane` を tmux 切替後に再解決する仕組みは設けない。**（review-changes 修正）** tmux 切替前に捕捉した `weztermPane` は tmux 内側ペインの値であり、切替後の外側クライアントに対応するとは限らない（別クライアントから同一 tmux セッションへ attach していた場合、誤ったペインを前面化しうる）ため、tmux 切替が発生した場合は `weztermPane` を `null` へ縮退させたうえで AC-2〜AC-4 の分岐へ渡す。これにより tmux 併用時は既存の tty ベースフォールバック（Terminal.app/Ghostty/WSL Windows Terminal 前面化）のみが使われ、`WeztermFocusStrategy` のペイン単位フォーカスは呼ばれない（`e2e-verification.md` 5.2 の期待と一致させる）
- AC-6: 既存の darwin/WSL2 の単体テスト（Terminal.app・Ghostty・tmux・従来 WSL 分岐）が signature 変更後も green のまま通ること（回帰なし）
- AC-7（review-changes 修正）: `FocusService.focus()` の TTY 必須判定は「`tty` と `weztermPane` の両方が無いとき」に緩和する（従来は `tty === null` のみで `no_terminal` に確定していた）。reporter が TTY を解決できない環境（WSL2 等）でも `weztermPane` が有効なら WezTerm 経路は機能しうるため（ARCHITECTURE.md §14.3: フィールドごとに独立して機能可否を判定する規約）。`tty` を必要とする `TerminalAppStrategy`/`GhosttyStrategy` は `target.tty === null` を自身で検査し `not_found` を返す（呼び出し側が非 null を保証する前提を廃止する）
- AC-8（実機検証で判明した所見への対応）: `app-view.tsx` の `focusTerminal()` が持つ「`focusRunner` を呼ぶ前の事前ゲート」も AC-7 と同じ条件（`tty`/`tmuxPane`/`weztermPane` のいずれかが有効なら通過）へ揃える。WSL2 実機で `resolve_tty()` が不正な値（`/dev/?`）を返し `tty` 検証が不合格になるケースを実際に確認したが、このとき `weztermPane` は有効だったにもかかわらず、旧ゲート（`tty`/`tmuxPane` のみ判定）が `focusRunner` を一切呼ばず常に `noTerminalInfo` notice へ縮退させていた（`focus-service.ts` 側の AC-7 だけでは救えない、別レイヤーの同型バグ）

### FR-05: ドキュメント整備と実機検証チェックリスト（優先度: 必須）

- 場所: `docs/known-issues.md`、`docs/known-limitations.md`、`README.md`、`README.ja.md`、`docs/releases/release-28-wezterm-focus/e2e-verification.md`（新規）
- 備考: `docs/ARCHITECTURE.md`・`docs/design/class-diagram.md`・`CHANGELOG.md` は `workflow.config.json` の `syncDocs` で自動同期されるため本 FR の対象外
- AC-1: `docs/known-issues.md` の **U17** を解決済みログへ移動する
- AC-2: `docs/known-limitations.md` の「ターミナルフォーカス（`f` キー）」項を更新し、対応ターミナルへ WezTerm（macOS・WSL2・Linux ネイティブ）を追加する。WSL2 では `$WEZTERM_PANE` を WSL 側で見るために Windows 側 `.wezterm.lua` へ `WSLENV` 追記が必要な前提条件（自動設定はしない設計判断。Ghostty の `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`／既知課題 U14 と同種の位置づけ）を明記する
- AC-3: README.md / README.ja.md に WezTerm 利用時の設定手順を記載する（WSL2: `.wezterm.lua` への `WSLENV` 追記例／macOS・Linux ネイティブ: 追加設定不要である旨）
- AC-4: `e2e-verification.md` に実機チェックリストを作成する: macOS+WezTerm／WSL2+WezTerm（`WSLENV` 設定込み）／WSL2 で `wezterm_pane` 未検出時の Windows Terminal フォールバック／ネイティブ Linux+WezTerm／tmux 併用時に意図どおりスコープ外（既存フォールバック）に落ちること
- AC-5: 受け入れ試験(手動検証必須) — e2e-verification.md のチェックリストのうち、少なくとも次を実機で確認すること: (a) WSL2 + WezTerm（`WSLENV` 設定込み）で `wezterm.exe cli activate-pane` が実際に対象ペインを前面化できること、(b) macOS + WezTerm での前面化、(c) WSL2 で `wezterm_pane` 未検出時に既存 Windows Terminal 前面化へ正しくフォールバックすること。**実施結果**: (a)(b)(c) いずれも実機（macOS 実機、Parallels 非搭載の実 Windows 11 Home + WSL2 + WezTerm）で確認済み。詳細は e2e-verification.md・下記「未解決事項」を参照

### FR-06: `install-hooks` 完了時の WezTerm WSL2 ヒント表示（優先度: 推奨）

WSL2 で WezTerm ペイン単位フォーカスを使うための Windows 側 `.wezterm.lua` への `WSLENV` 追記（README 記載済み）は、install-hooks 自体が自動編集しない設計判断（FR-05 AC-2 と同じ理由）のためユーザーが見落としやすい、という壁打ちでのフィードバックに対応する。

- 場所: `src/cli.ts`、`src/i18n/en.ts`、`src/i18n/ja.ts`、`src/cli.test.ts`
- AC-1: `monomi install-hooks`（直接実行）完了後、WSL2 環境（`defaultIsWsl()`）なら README の「WezTerm: pane-level focus」節を参照するヒント（`cli.installHooks.weztermWslHint`）を表示する。非 WSL2（macOS・ネイティブ Linux）では表示しない
- AC-2: `monomi`（引数なし）起動時の初回セットアッププロンプトが承諾されフックがインストールされた場合も、同じ条件でヒントを表示する
- AC-3: `CliDeps` に `isWsl: () => boolean`（既定実装は `focus-service.ts` の `defaultIsWsl()`）を追加し、テストで固定値に差し替え可能にする
- AC-4: WSL2 か否かのみで判定し「実際に WezTerm を使っているか」までは検出しない（install-hooks 実行時点ではまだセッション情報が無いため判定不能。WezTerm を使っていない WSL2 ユーザーにも表示される誤表示を許容する設計判断）

## 非機能要件

- **セキュリティ**: reporter 由来の `wezterm_pane` は「認証済みだが信頼しない」（既存 S9/S12・release-23 と同じ脅威モデル）。厳格な数字のみの正規表現検証（FR-03 AC-2）+ `execFile`（非 shell）実行（FR-03 AC-6）の二段防御とする
- **互換性**: 旧 reporter ↔ 新 hub、新 reporter ↔ 旧 hub の混在で双方向に 400 を出さない（`wezterm_pane` は nullable/optional）。DB は既存ファイルへの冪等マイグレーションで、ダウングレード時も列が余るだけで動作に影響しない
- **互換性**: 既存の Terminal.app／Ghostty／tmux／WSL2（Windows Terminal）の挙動は本リリースで後退させない（FR-04 AC-6 で回帰確認）

## スコープ外

- Windows ネイティブ（WSL を介さない、PowerShell 等の）reporter 対応（既存方針どおりスコープ外のまま。本リリースは既存 WSL2 reporter 経路の拡張に限る）
- **ネイティブ Linux（X11/Wayland）の WezTerm フォーカス対応（壁打ち当初はスコープに含めていたが、実機検証を受けて撤回。既知課題 U21）**
- tmux と WezTerm を併用する構成（tmux pane が WezTerm pane 内で動く場合）でのペイン特定
- iTerm2・VS Code 統合ターミナルへのフォーカス対応
- `wt_session` を使った Windows Terminal のタブ単位フォーカス（データ捕捉のみ引き続き温存。microsoft/terminal #19783 実装待ち）
- ネストした WezTerm 構成（WezTerm 内で別の WezTerm セッションを multiplex する等）の解決

## 未解決事項

以下は当初「未確証のリスク」として記載していたが、release-28-wezterm-focus の実機検証（macOS 実機、Parallels 非搭載の実 Windows 11 Home + WSL2 + WezTerm、2026-07-23）により確証が得られたため、**確定した既知の制約**として記録し直す。

- **確定した制約: WSL2 での WezTerm フォーカスは「両側が WezTerm 経由で起動された WSL2 シェル」の場合のみ確実に動作する。** upstream の議論（wezterm/wezterm discussions #6964）で懸念されていた `wezterm.exe cli` の WSL interop 経由呼び出しのサイレント失敗を実機で再現した: Monomi CLI（ダッシュボード）・対象セッションの Claude Code のいずれかが PowerShell/Windows Terminal 等、WezTerm 以外の Windows ターミナルアプリ経由で起動した WSL2 シェルの場合、`wezterm.exe cli activate-pane` が mux ソケット（`gui-sock-<pid>`）への接続に失敗する（`failed to connect to Socket("gui-sock-<pid>")`）。PID は正しく現在稼働中の `wezterm-gui.exe` を指しており、古いソケット参照ではなく、WSL interop の起動経路に起因する接続失敗と判断した。原因の完全な特定（Windows のセッション分離・名前付きパイプの ACL 等）には至っていない。
  - 一方、Monomi CLI・対象セッションの両方が WezTerm のペイン内から起動された WSL2 シェルの場合は `activate-pane`・`raiseWeztermWindowWsl`（`SetForegroundWindow`）とも成功し、実際にタブが切り替わりウィンドウが前面化・フォーカスされることを確認した
  - コード側の緩和策（FR-03 AC-8 `verifyActivation`）は正しく機能し、この失敗を検知して `error` に丸め、既存の Windows Terminal フォールバックへ進むことを確認した（フォールバック先で Windows Terminal 自体を使っていない場合は `not_found` になる、これも既存設計どおりの挙動）
  - 対応: README.md／README.ja.md／known-limitations.md／ARCHITECTURE.md §14.1 にこの制約を明記した（リリースブロッカーとはしない。既存の対症療法〈フォールバック〉が正しく機能するため）。根本原因の特定・解消は将来の別リリースの検討課題とする
- `wezterm`／`wezterm.exe` バイナリが PATH 上に無い場合の挙動: **macOS で実機確認済みの新規バグとして発見・修正した**（FR-03 AC-10）。WezTerm.org 配布の macOS アプリを Homebrew Cask 経由でなく直接インストールした場合、`wezterm` バイナリが PATH に追加されない構成が一般的であり、修正前は `not_found` に丸まってフォーカスが機能しなかった。既知のインストール先へのフォールバックで解消済み。WSL2 側（Windows）で同種の PATH 不備が起きるかは未確認だが、対症療法（フォールバック候補配列）の構造は流用可能
- **ネイティブ Linux（X11/Wayland）の WezTerm 対応撤回（既知課題 U21）**: macOS の実機検証で `wezterm cli activate-pane` 単体では OS レベルの前面化が行われないと判明し、AppleScript による追加ステップ（`raiseWeztermWindowDarwin`）で解決した。ネイティブ Linux 向けには X11/Wayland 依存を避ける設計判断のためこの種の前面化手段を実装しておらず、実機環境も無く検証できなかった。ペイン内部状態だけ切り替わりウィンドウは前面化されない不完全な体験になる懸念が拭えないため、未検証のまま「対応」と謳うのを避け、当初 FR-04 AC-4 で追加した対応をスコープから外した（`focus-service.ts` のディスパッチ構造自体は維持し `cli.ts` から配線しないだけ）。前面化手段が見つかり実機検証できた時点で再対応を検討する

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-28-wezterm-focus", config: <.claude/workflow.config.json の内容>}})
```
