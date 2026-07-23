# release-28 実機 E2E 検証手順（WezTerm フォーカス）

release-28-wezterm-focus の受け入れ基準（requirements.md FR-05 AC-4/AC-5）のうち、実機でしか検証できない項目のチェックリスト。既知課題 **U17**（WSL2 のフォーカス対応を Windows Terminal 前面化から WezTerm へ切り替え）に対応する。

成功基準: **WezTerm を使っている環境（macOS・WSL2）で、セッションを選択し `f` キーを押したとき、そのセッションが稼働している WezTerm ペインが前面化される**こと。WSL2 で `$WEZTERM_PANE` を捕捉できない場合は既存の Windows Terminal 前面化へ正しくフォールバックすること。ネイティブ Linux（X11/Wayland）は実機検証を受けてスコープから外した（既知課題 U21、4節参照）。

## 何を見て・何を見ないか

- 単体テストで検証済みの項目（`focus-target.ts` の `wezterm_pane` 検証・インジェクション拒否 / `WeztermFocusStrategy` のコマンド組み立て・`ENOENT` 判定 / DB マイグレーション冪等性 / API 露出）は再確認不要。ここでは実 WezTerm・実 OS・実 WSL2 interop での動作と UI フィードバックだけを見る
- Terminal.app・Ghostty・tmux・別デバイス行・旧 reporter 互換性など、release-23-terminal-focus で検証済みの既存フォーカス経路の再検証は本ファイルの対象外（回帰確認は `pnpm test` の既存テストスイート — FR-04 AC-6 — で担保する）。`docs/releases/release-23-terminal-focus/e2e-verification.md` を参照
- 本ファイルが対象とするのは release-28 で新規に追加された WezTerm 経路（macOS/WSL2）と、WSL2 での WezTerm→Windows Terminal フォールバックの切り替わりのみ

## 前提

- 対象環境で `pnpm build` と `pnpm test` が通っていること
- 検証対象の環境に WezTerm がインストール済みで、PATH 上で `wezterm`（WSL2 からは Windows 側の `wezterm.exe`）が実行できること
- 手動で `monomi` CLI を起動し「ダッシュボード（list / detail 両ビュー）を見ながら検証」する環境。自動テストでは不可能な UI 層と OS/interop 連携を検証するため

## 0. セットアップ（全環境共通）

```sh
cd /opt/dev/Monomi
pnpm build

# hub を起動（フォアグラウンド）
node dist/cli.js hub
# → "Monomi hub listening on http://0.0.0.0:47632" を確認

# 別ターミナルで自マシンのフックを登録
mkdir -p ~/.monomi && cp reporter/monomi-report.sh ~/.monomi/monomi-report.sh
node dist/cli.js install-hooks
```

チェック:

- [ ] hub が `http://0.0.0.0:47632` で起動（**注意: 常駐 hub が旧ビルドのままだと `terminal.wezterm_pane` が保存されず「情報なし」になる。必ず新ビルドで再起動すること**）
- [ ] `~/.monomi/monomi.db` に `wezterm_pane` 列が追加される（既存 DB でのマイグレーション適用を確認: `sqlite3 ~/.monomi/monomi.db "PRAGMA table_info(sessions)"` に `wezterm_pane` が含まれる）
- [ ] フック登録が成功（`grep "monomi-report.sh" ~/.claude/settings.json`）

## 1. macOS + WezTerm 検証（AC-5 (b)）

WezTerm 複数ペインでのフォーカス移動。追加設定不要であることの確認を含む。

### 1.1 ペイン準備

```sh
# WezTerm で複数タブ/ペインを開く
# タブ1: 任意のプロジェクトで Claude Code セッション開始（permission プロンプトなど）
# タブ2: 別プロジェクトで Claude Code セッション開始
```

### 1.2 フォーカス検証

別ターミナル（Terminal.app 等）でダッシュボード起動:

```sh
node dist/cli.js        # list ビュー表示
```

検証ステップ:

- [x] ダッシュボードに複数セッションがリスト表示され、`Terminal` 欄/カードに `WezTerm` と表示される
- [x] `f` キーを押す → WezTerm ペインが前面に出る（追加設定なしで動作することを確認。ただし当初は前面化されないバグがあり、下記の通り修正済み）
- [x] `~/.monomi/monomi.db` の該当 session 行で `wezterm_pane` に数字の pane id が記録されていることを確認

メモ欄:

```
実施日: 2026-07-23
結果: 検証の過程で2件の実装バグを発見・修正した。

1. WeztermFocusStrategy が OS レベルのウィンドウ前面化を行わない不具合
   `wezterm cli activate-pane` は mux 内部のペイン選択のみを変え、OS のウィンドウマネージャへ
   前面化を要求しないため、exit 0 で成功していても WezTerm ウィンドウが他アプリの後ろに隠れた
   ままだった。`raiseWindow` オプションを追加し、成功後に `osascript -e 'tell application
   "WezTerm" to activate'` を実行するよう修正。修正後は実際にウィンドウが前面化・フォーカスされる
   ことを確認した。

2. wezterm バイナリが PATH に無いと not_found になる不具合
   WezTerm.org から直接ダウンロードしてインストールした場合（Homebrew Cask を使わない場合）、
   wezterm CLI バイナリが PATH に追加されない。`which wezterm` が失敗する環境で実際に再現した。
   command にコマンド候補の配列を渡せるよう修正し、bare `wezterm` が ENOENT のとき
   `/Applications/WezTerm.app/Contents/MacOS/wezterm` へフォールバックするようにして解消。

いずれも修正・テスト追加・再検証済み（focus() result: ok、実際にウィンドウ前面化を目視確認）。
```

## 2. WSL2 + WezTerm 検証（AC-5 (a)、WSLENV 設定込み）

WSL2 内の Claude Code セッションから、WSL 側 interop 経由で Windows 側 `wezterm.exe cli activate-pane` を呼び出しペイン前面化する経路。**upstream 未解決事項**（wezterm/wezterm discussions #6964 のサイレント失敗報告）があるため、本節が最も重要な実機確認項目。

### 2.1 Windows 側 `.wezterm.lua` に WSLENV 設定を追加

README「WezTerm: pane-level focus」節の手順どおり、Windows 側 `.wezterm.lua` に以下を追記:

```lua
config.set_environment_variables = {
  WSLENV = 'WEZTERM_PANE',
}
```

WezTerm を再起動し、新しい WSL2 ペインを開く。

### 2.2 事前確認: `$WEZTERM_PANE` が WSL2 側に届いているか

```sh
# WSL2 内で
echo "$WEZTERM_PANE"
```

- [ ] 空でない数字が出力される（届いていなければ 2.1 の設定・WezTerm 再起動をやり直す）

### 2.3 WSL2 内で Claude Code セッションを開始し reporter 登録

```sh
cd /opt/dev/Monomi
pnpm build
mkdir -p ~/.monomi && cp reporter/monomi-report.sh ~/.monomi/monomi-report.sh
node dist/cli.js install-hooks
# Claude Code セッションを開始（WezTerm の WSL2 ペインで実行）
```

### 2.4 フォーカス検証

ダッシュボード（Windows ホスト側 / WSL2 側のいずれでもよい）でセッション行を選択:

- [x] `terminal.wezterm_pane` が DB に記録されている
- [x] `f` キー押下で **対象の WSL2 ペインが実際に前面化される**（条件つきで確認 — 下記メモ参照）
- [x] Monomi CLI・対象セッションの両方を WezTerm のペイン内から起動した WSL2 シェルで実行した場合、複数ペイン/タブがあっても正しいペインが選ばれる

失敗ケース（upstream 未解決事項が実際に顕在化することを確認）:

- [x] `wezterm.exe cli activate-pane` がサイレント失敗する場合、notice に失敗理由のヒントが表示され、既存 Windows Terminal フォールバックへ落ちること（3節で確認。Windows Terminal 自体を使っていない場合は `not_found` になることも確認）

メモ欄（upstream #6964 との整合性を含め、結果を具体的に記録すること）:

```
実施日: 2026-07-23
環境: 実 Windows 11 Home + WSL2（Ubuntu, VERSION 2）+ WezTerm 20240203-110809-5046fc22
    （Parallels Desktop 上の Windows 11 ARM では nested virtualization 非対応のため WSL2 自体が
    動かず、実機の Windows PC で検証した）

【重要な確認結果】WSL2 での WezTerm フォーカスは「Monomi CLI（ダッシュボード）と対象セッションの
両方が WezTerm のペイン内から起動された WSL2 シェル」の場合にのみ確実に動作する。

- 両方 WezTerm 経由で起動 → activate-pane 成功・タブ切替・ウィンドウ前面化とも確認（focus()
  result: ok）
- どちらか一方でも PowerShell 経由で起動した WSL2 シェル → wezterm.exe cli activate-pane が
  「failed to connect to Socket("gui-sock-<pid>")」で失敗する。PID は実際に稼働中の
  wezterm-gui.exe の PID と一致しており（Get-Process で確認）、古いソケット参照ではない。管理者
  権限の有無でも変わらず再現した。upstream の議論（wezterm/wezterm discussions #6964）にある
  「WSL からの wezterm cli 呼び出しがサイレント失敗する」報告と一致する挙動。原因の完全特定には
  至っていない（Windows のセッション分離等が疑われるが未確証）
- 失敗時、verifyActivation が正しく検知して error に丸め、既存の Windows Terminal フォールバック
  （wslStrategy）へ進むことを確認。ただし Windows Terminal 自体を使っていない環境では
  そちらも not_found になり、結果として前面化されない（これは想定どおりの縮退動作）

別途、実機検証中に app-view.tsx の事前ゲートが weztermPane を考慮していないバグを発見・修正した
（tty 検証不合格（WSL2 の resolve_tty() が `/dev/?` を返すケースで確認）でも weztermPane が
有効なら focusRunner を呼ぶべきところ、旧ゲートは常に noTerminalInfo に縮退させていた）。
```

## 3. WSL2: `wezterm_pane` 未検出時の Windows Terminal フォールバック検証（AC-5 (c)）

`$WEZTERM_PANE` が捕捉できない（WezTerm を使っていない、または 2.1 の WSLENV 設定をしていない）場合に、既存の Windows Terminal 前面化へ正しくフォールバックすることを確認する。

### 3.1 準備

WSL2 内で `$WEZTERM_PANE` が空であることを確認（Windows Terminal を使っている、または WezTerm でも WSLENV 未設定の場合）:

```sh
echo "$WEZTERM_PANE"   # 空であること
```

Claude Code セッションを開始し reporter 登録（未実施なら上記 0 節・2.3 と同様）。

### 3.2 フォーカス検証

- [ ] ダッシュボードの該当セッション行の `terminal.wezterm_pane` が `null`（情報なし）であることを確認
- [ ] `f` キー押下で **WezTerm 経由は試行されず**、既存の Windows Terminal ウィンドウ前面化（best-effort、タブ特定不可）が実行される
- [ ] 動作が release-23 時点の挙動（Windows Terminal 前面化のみ）と変わらないこと

メモ欄:

```
実施日: 2026-07-23
結果: 本節が想定する「wezterm_pane が最初から null」の経路そのものは未実施だが、2節の実機検証で
`wezterm_pane` はある（activate-pane が interop 接続失敗）→ フォールバックとして wslStrategy
（Windows Terminal 前面化）が呼ばれる → Windows Terminal 未使用のため not_found、という経路を
実際に確認した。fallback 先の wslStrategy 自体が正しく起動・実行されることはこれで確認できている。
「wezterm_pane が最初から null」の入口条件（focus-service.ts の分岐）はユニットテストでカバー済み
のため、リリースブロッカーとはしない。
```

## 4. ネイティブ Linux + WezTerm（スコープ外へ変更、実施不要）

**この節は実機検証の結果を受けてスコープから外されました（既知課題 U21）。** macOS の実機検証で `wezterm cli activate-pane` 単体では OS レベルの前面化が行われないことが判明し、macOS では AppleScript による追加ステップで解決したが、ネイティブ Linux 向けの X11/Wayland 非依存な前面化手段は未検証のまま残った。ペイン内部状態だけ切り替わりウィンドウは前面化されない不完全な体験になる懸念が拭えないため、`cli.ts` はネイティブ Linux 向け `weztermStrategy` を意図的に配線しないことにし（`focus-service.ts` のディスパッチ構造自体は汎用のまま維持）、ネイティブ Linux では従来どおり `unsupported_platform` になる。この節のチェックリストは実施不要。前面化手段が見つかり実機検証できた時点で本節を再度有効化する。

## 5. tmux + WezTerm 併用時のスコープ外動作確認

tmux pane が WezTerm pane 内で動く構成（tmux と WezTerm の併用）は本リリースのスコープ外（既存 tmux 優先ロジックのまま）。意図どおりスコープ外へ落ちる、つまり **tmux-strategy による外側クライアント TTY 前面化のみが行われ、WezTerm ペイン単位の特定は行われない**ことを確認する。

### 5.1 準備

```sh
# WezTerm のペイン内で tmux session を開始
tmux new-session -d -s "test-wezterm-tmux" -x 200 -y 50
tmux new-window -t test-wezterm-tmux -n "proj1"
tmux send-keys -t test-wezterm-tmux:proj1 "cd /some/project1 && bash" Enter
tmux attach-session -t test-wezterm-tmux
```

tmux 内で Claude Code セッションを開始。

### 5.2 検証

別ターミナル（tmux 外）でダッシュボード起動し、tmux 内セッション行を選択:

- [ ] `f` キー押下で tmux-strategy が先に動作し、tmux の対応 pane へ切り替わったうえで **外側の WezTerm ウィンドウ**が前面化される（release-23 時点の tmux 経由フォーカスと同じ挙動）
- [ ] WezTerm のペイン単位フォーカス（`wezterm cli activate-pane`）は呼ばれない（tmux 内のペインは WezTerm 側からは 1 つの pane にしか見えないため、tmux 切替後の外側 TTY 前面化のみで完結することを確認）

メモ欄:

```
（実施日・結果・気づいた点をここに記録）
```

## 6. 既存フォーカス経路の回帰確認（簡易）

FR-04 AC-6 により単体テストで回帰なしを確認済みだが、実機でも簡易確認する。

```sh
pnpm test -- --testNamePattern="focus"
```

- [ ] Terminal.app・Ghostty・tmux（WezTerm を使わない既存経路）が release-23 時点と同様に動作する（詳細な実機チェックは `docs/releases/release-23-terminal-focus/e2e-verification.md` 参照、本節では既存テストスイートの green を確認するのみ）

## 結果記録

| 日付       | 実施者   | 環境                                                                 | macOS+WezTerm | WSL2+WezTerm    | WSL2フォールバック  | ネイティブLinux+WezTerm | tmux併用スコープ外 | メモ                                                                                                                                              |
| ---------- | -------- | -------------------------------------------------------------------- | ------------- | --------------- | ------------------- | ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-23 | sumihiro | macOS 実機 / 実 Windows 11 Home + WSL2 + WezTerm（Parallels 非搭載） | [x]           | [x]（条件つき） | [x]（別経路で確認） | N/A（スコープ外へ変更） | [ ]（未実施）      | 2件のバグを発見・修正（1・2節メモ参照）。WSL2 は「両側 WezTerm 経由起動」限定で動作を確認。ネイティブ Linux は既知課題 U21 によりスコープ外へ変更 |

---

## 実装者向け: 手動検証チェックリスト

以下の項目を実装後・PR 前に実機で必ず確認してください（requirements.md FR-05 AC-5、受け入れ試験・手動検証必須）。

- [x] **(a) WSL2 + WezTerm（`WSLENV` 設定込み）で `wezterm.exe cli activate-pane` が実際に対象ペインを前面化できること**（2節。ただし Monomi CLI・対象セッション両方が WezTerm 経由で起動された WSL2 シェルの場合に限る）
- [x] **(b) macOS + WezTerm での前面化**（1節。2件のバグを発見・修正済み）
- [x] **(c) WSL2 で既存 Windows Terminal 前面化へ正しくフォールバックすること**（3節。`wezterm_pane` が最初から null の経路ではなく、WSL interop 接続失敗をトリガーとする経路で確認。フォールバック機構自体の動作は確認済み）
- [x] ネイティブ Linux + WezTerm（4節。実機検証を受けてスコープから外したため実施不要。既知課題 U21）
- [ ] tmux + WezTerm 併用時に意図どおりスコープ外（既存 tmux フォールバック）に落ちること（5節、未実施。ユニットテストでカバー済みのためブロッカーにはしない）
- [x] `pnpm test` と `pnpm run lint` が通る

(a)(b)(c) は release-28-wezterm-focus のリリースブロッカーとなる必須確認項目。tmux 併用は環境がある場合に確認する任意項目。

(a) は upstream の未解決事項（wezterm/wezterm discussions #6964 のサイレント失敗報告）に対する実機確認であるため、結果は 2節のメモ欄に具体的に記録すること。動作しない場合はブロッカーにせず、notice のヒント文言 + Windows Terminal フォールバックへの委譲で対応する（requirements.md「未解決事項」参照）。
