# release-28-wezterm-focus 要件定義

- リリース識別子: `release-28-wezterm-focus`
- ステータス: 確定
- 作成日: 2026-07-19
- 対応する設計・参照資料: `docs/ARCHITECTURE.md` §14（ターミナルフォーカス）/ `docs/known-issues.md` **U17** / [release-23-terminal-focus requirements.md](../release-23-terminal-focus/requirements.md)（原設計）

## 背景と目的

release-23-terminal-focus で実装した `f` キーによるターミナルフォーカス機能は、WSL2 環境では Windows Terminal のウィンドウ前面化止まりの best-effort で、タブ/ペイン単位の特定ができない（既知課題 **U17**）。U17 起票時点（2026-07-16）の調査で、Windows Terminal 自体に既存タブを外部から特定・選択する API が無く（microsoft/terminal のタブ単位フォーカス要望 #19783 が未実装、`wt focus-tab` はインデックス指定のみで対象特定手段が無く、外部実行で新規タブが開くバグ #19324 もある）、Warp も同様に既存タブへのフォーカス手段が無い（warpdotdev/warp #8611 未実装）ことが判明済みだった。一方 WezTerm は公式 CLI（`wezterm cli list` / `activate-pane --pane-id <id>`）でタブ/ペイン単位の確実な制御ができる。

本リリースは、WSL2 のフォーカス対象を Windows Terminal から WezTerm へ切り替え、あわせて macOS・ネイティブ Linux 上で WezTerm を使っているユーザーにも同じ仕組みを適用する（WezTerm はクロスプラットフォームで動作するため、1 つの実装を複数 OS で再利用できる）。

**技術的な残存リスク**: WSL の interop 経由で Windows 側の `wezterm.exe cli` を呼び出す方式について、upstream の議論（wezterm/wezterm discussions #6964）では類似の操作（`cli set-user-var`）が WSL からの実行でサイレント失敗する報告があり、`activate-pane` が同様の制約を受けるかは実機検証で確認するまで確証がない（詳細は「未解決事項」）。

## スコープの確定（壁打ちでの決定事項）

| 論点                                                                       | 決定                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WSL2 既存 Windows Terminal 前面化（`wsl-strategy.ts`）の扱い              | **WezTerm 優先＋フォールバックで温存**。`wezterm_pane` を検出できたときは WezTerm 経由のフォーカスを先に試行し、未検出（未設定/従来ユーザー）またはフォーカス失敗時は既存の Windows Terminal 前面化へフォールバックする（後方互換維持） |
| macOS 上の WezTerm ユーザー対応                                            | **同時にスコープへ含める**。現状 macOS の WezTerm ユーザーは `term_program` がどの darwin strategy にもヒットせず `not_found` になっており、同じ実装を `darwinStrategies` へ追加コスト小で再利用できるため |
| WSL 以外のネイティブ Linux（X11/Wayland）で WezTerm を使っている場合の対応 | **含める**。`wezterm-strategy` は wezterm CLI 呼び出しのみで完結し X11/Wayland のウィンドウ操作 API に依存しないため、既存の「Linux ネイティブ（X11/Wayland）は対象外」という制約（汎用ターミナルの前面化には X11/Wayland API が要る）とは別枠で対応できる |
| tmux と WezTerm を併用している場合（tmux pane が WezTerm pane 内で動く構成） | **スコープ外**。既存の tmux 優先ロジック（`switch-client` → 外側クライアント TTY で以降の判定を続行）はそのまま維持し、WezTerm 側のペイン特定は行わない                     |

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

### FR-04: `focus-service.ts` のディスパッチ再設計（優先度: 必須）

- 場所: `src/cli/focus/focus-service.ts`、`src/cli/focus/types.ts`（`Strategy` インターフェイス）、`src/cli/focus/terminal-app-strategy.ts`、`src/cli/focus/ghostty-strategy.ts`（signature 追従のみ、挙動変更なし）
- AC-1: `Strategy.focus(tty: string)` を `Strategy.focus(target: FocusTarget)` へ拡張する。既存 strategy（Terminal.app・Ghostty）は内部で `target.tty` を参照するよう追従するのみで挙動は変えない。これにより tty ベースでない `WeztermFocusStrategy`（`target.weztermPane` を使う）も同一インターフェイスへ乗せられる
- AC-2: darwin ディスパッチ（`focusDarwin`）の `darwinStrategies` 配列へ `WeztermFocusStrategy`（`command: 'wezterm'`）を追加する。`matchesHint` は `target.termProgram === 'WezTerm'` で判定し、既存の hint 順総当たりロジック（`orderByHint`）はそのまま利用する
- AC-3: WSL2 分岐を「`target.weztermPane` があれば `WeztermFocusStrategy`（`command: 'wezterm.exe'`）を先に試行し、結果が `ok` 以外なら既存の `wslStrategy`（Windows Terminal 前面化）へフォールバックする」形へ変更する。`weztermPane` が無ければ従来どおり即座に `wslStrategy` を呼ぶ（後方互換）
- AC-4: 非 darwin・非 WSL2（ネイティブ Linux 等）の分岐を新設する: `target.weztermPane` があれば `WeztermFocusStrategy`（`command: 'wezterm'`）を試行しその結果を返し、無ければ従来どおり `unsupported_platform` を返す
- AC-5: tmux 経由（`tmuxPane` があるケース）で解決した外側クライアント TTY に対しても、AC-2〜AC-4 の分岐がそのまま適用される（tmux 優先ロジック自体は変更しない）。tmux 併用時の WezTerm ペイン特定はスコープ外のため、`weztermPane` を tmux 切替後に再解決する仕組みは設けない
- AC-6: 既存の darwin/WSL2 の単体テスト（Terminal.app・Ghostty・tmux・従来 WSL 分岐）が signature 変更後も green のまま通ること（回帰なし）

### FR-05: ドキュメント整備と実機検証チェックリスト（優先度: 必須）

- 場所: `docs/known-issues.md`、`docs/known-limitations.md`、`README.md`、`README.ja.md`、`docs/releases/release-28-wezterm-focus/e2e-verification.md`（新規）
- 備考: `docs/ARCHITECTURE.md`・`docs/design/class-diagram.md`・`CHANGELOG.md` は `workflow.config.json` の `syncDocs` で自動同期されるため本 FR の対象外
- AC-1: `docs/known-issues.md` の **U17** を解決済みログへ移動する
- AC-2: `docs/known-limitations.md` の「ターミナルフォーカス（`f` キー）」項を更新し、対応ターミナルへ WezTerm（macOS・WSL2・Linux ネイティブ）を追加する。WSL2 では `$WEZTERM_PANE` を WSL 側で見るために Windows 側 `.wezterm.lua` へ `WSLENV` 追記が必要な前提条件（自動設定はしない設計判断。Ghostty の `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`／既知課題 U14 と同種の位置づけ）を明記する
- AC-3: README.md / README.ja.md に WezTerm 利用時の設定手順を記載する（WSL2: `.wezterm.lua` への `WSLENV` 追記例／macOS・Linux ネイティブ: 追加設定不要である旨）
- AC-4: `e2e-verification.md` に実機チェックリストを作成する: macOS+WezTerm／WSL2+WezTerm（`WSLENV` 設定込み）／WSL2 で `wezterm_pane` 未検出時の Windows Terminal フォールバック／ネイティブ Linux+WezTerm／tmux 併用時に意図どおりスコープ外（既存フォールバック）に落ちること
- AC-5: 受け入れ試験(手動検証必須) — e2e-verification.md のチェックリストのうち、少なくとも次を実機で確認すること: (a) WSL2 + WezTerm（`WSLENV` 設定込み）で `wezterm.exe cli activate-pane` が実際に対象ペインを前面化できること、(b) macOS + WezTerm での前面化、(c) WSL2 で `wezterm_pane` 未検出時に既存 Windows Terminal 前面化へ正しくフォールバックすること

## 非機能要件

- **セキュリティ**: reporter 由来の `wezterm_pane` は「認証済みだが信頼しない」（既存 S9/S12・release-23 と同じ脅威モデル）。厳格な数字のみの正規表現検証（FR-03 AC-2）+ `execFile`（非 shell）実行（FR-03 AC-6）の二段防御とする
- **互換性**: 旧 reporter ↔ 新 hub、新 reporter ↔ 旧 hub の混在で双方向に 400 を出さない（`wezterm_pane` は nullable/optional）。DB は既存ファイルへの冪等マイグレーションで、ダウングレード時も列が余るだけで動作に影響しない
- **互換性**: 既存の Terminal.app／Ghostty／tmux／WSL2（Windows Terminal）の挙動は本リリースで後退させない（FR-04 AC-6 で回帰確認）

## スコープ外

- Windows ネイティブ（WSL を介さない、PowerShell 等の）reporter 対応（既存方針どおりスコープ外のまま。本リリースは既存 WSL2 reporter 経路の拡張に限る）
- tmux と WezTerm を併用する構成（tmux pane が WezTerm pane 内で動く場合）でのペイン特定
- iTerm2・VS Code 統合ターミナルへのフォーカス対応
- `wt_session` を使った Windows Terminal のタブ単位フォーカス（データ捕捉のみ引き続き温存。microsoft/terminal #19783 実装待ち）
- ネストした WezTerm 構成（WezTerm 内で別の WezTerm セッションを multiplex する等）の解決

## 未解決事項

- WSL2 の interop 経由で Windows 側の `wezterm.exe cli activate-pane` を実行した際の信頼性は、upstream の議論（wezterm/wezterm discussions #6964）で類似操作（`cli set-user-var`）がサイレント失敗する報告があり、完全な確証がない。実装後の実機検証（FR-05 AC-5(a)）で確認し、動作しない場合は notice のヒント文言で案内しつつ Windows Terminal フォールバックへ委ねる（リリースブロッカーにはしない）
- `wezterm`／`wezterm.exe` バイナリが PATH 上に無い場合（インストーラーが PATH に追加しない構成等）の挙動は `not_found` 相当に丸める設計だが、README にトラブルシューティング注記が追加で必要かは実機検証後に判断する

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-28-wezterm-focus", config: <.claude/workflow.config.json の内容>}})
```
