# release-23 実機 E2E 検証手順（ターミナルフォーカス）

release-23-terminal-focus の受け入れ基準のうち、実機でしか検証できない項目のチェックリスト。

成功基準: **同一デバイス上でセッションを選択し `f` キーを押したとき、そのセッションが稼働しているターミナルタブが前面化される**こと。別デバイスのセッション選択時は `f` が無効化され理由 notice が表示される。

単機ユニットテスト・統合テストで検証済みの項目（focus-target 検証 / AppleScript エスケープ / DB マイグレーション / API 露出）は再確認不要。ここでは実ターミナル・実 OS での動作と UI フィードバックだけを見る。

## 前提

- 対象環境で `pnpm build` と `pnpm test` が通っていること
- 手動で `monomi` CLI を起動し「ダッシュボード（list / detail 両ビュー）を見ながら検証」する環境。自動テストでは不可能な UI 層と OS 連携を検証するため

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

- [x] hub が `http://0.0.0.0:47632` で起動（2026-07-15 確認。**注意: 常駐 hub が旧ビルドのままだと `terminal` が保存されず「情報なし」になる。必ず新ビルドで再起動すること**）
- [x] `~/.monomi/{config.yml,monomi.db,token}` が生成される（既存環境で列マイグレーション適用を確認）
- [x] フック登録が成功（7 フック確認: `grep "monomi-report.sh" ~/.claude/settings.json`）

## 1. Terminal.app 検証（macOS）

Terminal.app 複数タブでのフォーカス移動・TTY 一致判定。

### 1.1 タブ準備

```sh
# Terminal.app で 3 つのタブを開く
# タブ1: 任意のプロジェクトで Claude Code セッション開始（permission プロンプトなど）
# タブ2: 別プロジェクトで Claude Code セッション開始
# タブ3: 通常シェル（control group）
```

### 1.2 フォーカス検証

別ターミナルでダッシュボード起動:

```sh
node dist/cli.js        # list ビュー表示
```

検証ステップ:

- [x] ダッシュボードに複数セッション（タブ1・タブ2 各々）がリスト表示される
- [x] タブ1 のセッション行を選択し、ダッシュボード下部に ` f focus` ヒントが表示される
- [x] `f` キーを押す → タブ1 が前面に出て、Terminal.app ウィンドウが active になる
- [x] タブ2 のセッション行を選択し、`f` キーを押す → タブ2 が前面に出る
- [x] detail ビューを開いた状態（Enter キー）でも `f` キーが動作する

（2026-07-16 実機確認済み）

メモ:

- TTY 一致で正しいタブが選ばれることを確認。誤ったタブ（通常シェル等）は選ばれない
- 連続で複数回 `f` を押しても安定動作（一度に1タブのみ前面化）

## 2. Ghostty 検証（macOS、環境あれば）

Ghostty + OSC タイトルタグによるフォーカス移動。**Ghostty フォーカスはアクセシビリティ許可が前提**。

### 2.1 準備

```sh
# Ghostty が起動している場合、以下の設定を確認
# ~/.claude/settings.json に手動で以下を追記（install-hooks は自動設定しない）
#   "env": {
#     "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"
#   }

# Ghostty でタブを開く（Terminal.app と同様に複数タブで Claude Code セッション）
```

### 2.2 アクセシビリティ許可確認

macOS System Preferences → Security & Privacy → Accessibility:

- [ ] Ghostty が許可一覧に存在するか
- [ ] `System Events` が許可一覧に存在するか

存在しない場合、Ghostty でフォーカス操作を試みると失敗し、notice に「アクセシビリティ許可」ヒントが表示される。

### 2.3 フォーカス検証

ダッシュボートで Ghostty タブのセッション行を選択:

- [ ] フッターに ` f focus` ヒントが表示される
- [ ] `f` キーを押す → Ghostty ウィンドウが前面化する
- [ ] OSC タイトルタグ（`monomi:<tty_basename>`）が一時的に埋め込まれ、後に消去される（ユーザーには見えないが、`ps aux | grep Ghostty` で確認可能）
- [ ] 複数タブがある場合、正しいタブが選ばれる

失敗ケース（環境・バージョン差で起こりうる）:

- [ ] Ghostty の Window メニュー構成が異なる場合、notice に失敗理由とヒント（「アクセシビリティ許可を確認」等）が表示される
- [ ] リトライ後も失敗時は自動消去（約 4 秒）

## 3. tmux 検証（任意の環境）

tmux session 内での pane フォーカス。attach / detach 両ケース。

### 3.1 tmux session 準備

```sh
# tmux session を新規作成
tmux new-session -d -s "test-monomi" -x 200 -y 50

# session 内で複数 window / pane を作成
tmux new-window -t test-monomi -n "proj1"
tmux send-keys -t test-monomi:proj1 "cd /some/project1 && bash" Enter

tmux new-window -t test-monomi -n "proj2"
tmux send-keys -t test-monomi:proj2 "cd /some/project2 && bash" Enter

# client として attach
tmux attach-session -t test-monomi
```

tmux 内のそれぞれの pane で Claude Code セッションを開始（複数ウィンドウ × 複数プロジェクト）。

### 3.2 フォーカス検証（attach 状態）

別ターミナル（tmux 外）でダッシュボード起動:

```sh
# tmux の外側から実行
node dist/cli.js
```

検証:

- [ ] tmux 各 pane のセッションがダッシュボールに表示される
- [ ] ダッシュボールでセッション行を選択し `f` キーを押す → tmux の対応 pane が前面に来て、client が自動選択される
- [ ] 複数 client が接続している場合、`client_activity` が最新の client が選ばれる
- [ ] 別 window への遷移も動作する

### 3.3 フォーカス検証（detach 状態）

tmux session から detach:

```sh
# tmux 内で Ctrl-b d
```

その状態でダッシュボールでセッション行を選択し `f` キー:

- [ ] `tmux_detached` notice が表示される（「tmux がこのセッションに接続していない」等のメッセージ）

その後 attach し直す:

```sh
tmux attach-session -t test-monomi
```

- [ ] 再度 `f` キーでフォーカスが動作する

## 4. 別デバイス行の動作検証

複数デバイスが hub に接続している場合、別デバイスのセッション選択時 `f` は無効化されることを検証。

### 4.1 複数デバイス環境がある場合

hub: Mac mini、child: MacBook など（前述「デバイスペアリング」を参照）

Mac mini 側でダッシュボール起動:

```sh
node dist/cli.js
```

検証:

- [ ] 自デバイス行（DEVICE が `localhost` 等）を選択し `f` → フォーカス実行
- [ ] 別デバイス行（DEVICE が MacBook など）を選択し `f` → フォーカス実行されず、notice に「別デバイスの行です」等の理由が表示される
- [ ] フッターヒント ` f focus` は自デバイス行選択時のみ表示。別デバイス行選択時は表示されない
- [ ] 別デバイス行の detail ビューでも `f` は無効

### 4.2 複数デバイス環境がない場合

自デバイスのみの場合は以下を確認:

- [ ] `device_id` が config.yml に記録されている（`cat ~/.monomi/config.yml`）
- [ ] ダッシュボール上でセッション行の DEVICE 列が自デバイス ID と一致
- [ ] `f` キーが動作する

## 5. WSL2 前面化検証（Windows + WSL2、環境あれば）

> **注記（2026-07-16）**: WSL2 対応は Windows Terminal 前面化から WezTerm（タブ/ペイン単位）へ方針転換した（known-issues **U17**）。本節の検証は任意のまま未実施でよい。

WSL2 内の Claude Code セッションから Windows Terminal のウィンドウ前面化。

### 5.1 準備

WSL2 ディストロ内で:

```sh
cd /opt/dev/Monomi
# WSL2 内でも pnpm build・install-hooks を実行
pnpm build
mkdir -p ~/.monomi && cp reporter/monomi-report.sh ~/.monomi/monomi-report.sh
node dist/cli.js install-hooks

# Claude Code セッションを開始（WSL ターミナルで実行）
```

### 5.2 フォーカス検証

ダッシュボール（Windows ホスト側 / WSL2 側のいずれでもよい）でセッション行を選択:

- [ ] `f` キー押下で Windows Terminal ウィンドウが前面化する（best-effort。タブ特定はスコープ外）
- [ ] WSL ディストロ名が `terminal.wsl_distro` に正しく記録される

失敗ケース:

- [ ] `wsl-strategy` が利用できない環境では `unsupported_platform` notice が表示される

## 6. 旧 reporter との互換性検証

旧 reporter（`terminal` 捕捉なし）で送られたセッション行の動作。

### 6.1 旧 reporter シミュレーション

DB に既存データがあり、新 reporter との混在がある場合を想定。

検証:

- [ ] 旧 reporter で送られたセッション（`terminal` フィールドが null）をダッシュボールで選択
- [ ] `f` キー押下で「情報なし」notice が表示される（「このセッションのターミナル情報が記録されていません」等）
- [ ] ダッシュボール表示で特に異常がない（null 値で落ちないこと）

### 6.2 新旧混在時の DB 動作

新 hub で旧 reporter ペイロード、旧 hub で新 reporter ペイロードを受け取った場合:

- [ ] schema 互換性チェック: `rawEventPayloadSchema` が `.optional()` で旧ペイロードを受理（200 OK）
- [ ] DB マイグレーション: 新列が正しく追加され、既存データとの共存で落ちない

テスト実行で確認:

```sh
pnpm test -- --testNamePattern="migration|schema"
```

## 7. ゲート（フォーカス実行不可）の検証

以下の条件下では `f` が無効化されることを確認。

### 7.1 stale TTY（`status.display === 'closed'`）

セッションが `closed`（idle/stale）状態で:

- [ ] ダッシュボール一覧の closed 行を選択し `f` キー → notice に「セッションが終了しています」等のメッセージ

### 7.2 terminal 情報なし

ペイロードに `terminal: null` または欠落した場合:

- [ ] `f` キー → notice に「情報なし」メッセージ

### 7.3 検証不合格（悪意ある値）

ユニットテストで検証済み。実機では以下の簡易チェック:

- [ ] `utils/validate-focus-target.ts` が攻撃文字列（`../../../etc/passwd` など）を拒否
- [ ] 単機ユニットテストで「インジェクション試行が rejected」を確認:
  ```sh
  pnpm test -- --testNamePattern="focus-target.*injection"
  ```

## 8. notice の表示・消去検証

フォーカス実行時の notice 表示・自動消去。

検証:

- [ ] 成功時: notice 非表示（タブ移動自体がフィードバック）
- [ ] 失敗時: 理由別 notice 表示（`focus.tmuxDetached`/`focus.notFound`/`focus.unsupported`/`focus.failed`）
- [ ] notice は約 4 秒で自動消去
- [ ] アンマウント後 setState による warning が console に出ない（cleanup ガード正常）

## 9. ヘルプオーバーレイの検証

ダッシュボール内で `?` キーを押してヘルプ表示:

- [ ] `f` キーに関する行が記載されている
- [ ] `focus.` で始まる i18n キーが `en.ts` と `ja.ts` の両方に存在
- [ ] 日本語環境（`locale: ja`）でも Ghostty アクセシビリティ許可のヒントが表示される

実行:

```sh
# en.ts と ja.ts の i18n キーが一致することを確認
pnpm run lint
```

## 10. 統合検証（主観的なワークフロー確認）

以下のワークフロー全体が滑らかに動作することを主観的に確認。

1. ダッシュボール起動 → セッション一覧表示
2. セッション行選択 → detail ビュー表示
3. 異なるセッション行を選択（←→ キー） → 対応ターミナルが前面化
4. 別デバイス行選択 → notice 表示・ヒント非表示
5. 閉じたセッション選択 → notice 表示
6. help 表示（?） → `f` キー説明・ヒント確認

チェック:

- [ ] 操作が自然・遅延なし
- [ ] error メッセージが適切・ユーザーが対処可能な情報を含む
- [ ] UI に異常（レイアウト崩れ・文字化け等）がない

## 結果記録

| 日付 | 実施者 | 環境                    | Terminal.app | Ghostty | tmux | WSL2 | 旧 reporter | メモ |
| ---- | ------ | ----------------------- | ------------ | ------- | ---- | ---- | ----------- | ---- |
| 2026-07-16 | sumihiro | macOS (Terminal.app)    | [x]          |         |      |      | [ ]         | f キーでタブ前面化を確認。前提: 常駐 hub の新ビルド再起動が必要（旧 hub だと terminal が strip され「情報なし」になる） |
|      |        | macOS (Ghostty)         |              | [ ]     |      |      |             |      |
|      |        | macOS (tmux)            | [ ]          |         | [ ]  |      |             |      |
|      |        | WSL2 + Windows Terminal |              |         |      | [ ]  |             |      |

---

## 実装者向け: 手動検証チェックリスト

以下の項目を実装後・PR 前に実機で必ず確認してください。

- [ ] `f` キーが list ビューで動作する（Terminal.app で複数タブ確認）
- [ ] `f` キーが detail ビューで動作する
- [ ] 別デバイス行では `f` が無効化される（複数デバイス環境がある場合）
- [ ] notice が正しく表示・消去される
- [ ] ヘルプに `f` と `focus.*` が記載されている
- [ ] `pnpm test` と `pnpm run lint` が通る
- [ ] console に `setState after unmount` warning がない

Terminal.app・tmux・別デバイスの項目は実機受け入れ試験（AC-5）として必須確認項目。Ghostty・WSL2 は環境がある場合に確認。
