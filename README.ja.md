# Monomi

[English README is here](./README.md)

複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード。

Mac mini 上の hub と MacBook 等の child をペアリングし、child 側のセッション状態も hub の `monomi` ダッシュボードに横断表示できる（LAN 断時は Tailscale へ自動フォールバック。詳細は `docs/releases/release-3-multi-device-pairing/requirements.md` を参照）。

## 対応環境

- 動作確認環境: macOS のみ
- reporter（Claude Code フックから hub へ状態を報告する bash スクリプト）は bash 前提で動作し、macOS / Linux / WSL2 で動く
- 必要 Node.js バージョン: `>=22.5.0`（`package.json` の `engines.node` と一致。`npx`/`monomi` はいずれも起動時にこのバージョンを検査し、満たさない場合はエラー終了する）
- 注意: npm 10.8.2 など古い npm では `npm install -g monomi-cli` が `Exit handler never called!`（npm 自体の既知バグ）で失敗することがある。発生した場合は npm を最新化してから再実行すること。

## クイックスタート

グローバルインストールなしで、その場で試せる。

```sh
npx monomi-cli
```

これ1コマンドで次まで完結する。

1. hub が不在なら自動起動する（`~/.monomi/`＝config.yml・SQLite DB・token を初回生成し、hostname ベースの `device_id` とローカル用 token を発行。既に起動中なら何もしない）
2. Claude Code のフックが未登録なら「`install-hooks` を実行しますか? [Y/n]」と確認する（承諾でフック登録・reporter 配置まで実行。拒否した場合は次回以降再確認せず案内のみ表示。非対話端末では確認せず案内のみで続行）
3. `monomi` ダッシュボードを表示する

自動起動した hub はダッシュボードを終了しても常駐し続ける（端末を閉じても動き続ける detached プロセス）。以後 2 台目以降のデバイスを増やすには、そのマシンから `monomi pair` するだけでよい（後述「デバイスのペアリング（child 追加）」を参照）。

このマシンで日常的に使うなら、都度の `npx` 解決コストを避けるため恒常インストールを推奨する。

```sh
npm install -g monomi-cli
```

グローバルインストール後は `npx monomi-cli` の代わりに `monomi` コマンドが直接使える（動作は同一）。

## hub の起動と常駐化

hub の起動は既定で自動化されている。`monomi`（または `npx monomi-cli`）を引数なしで実行すると、既定ポート（`47632`）に疎通できなければ自パッケージ内の hub を detached で自動起動し、疎通確認できてからダッシュボードを表示する（起動に失敗した場合は `~/.monomi/hub.log` を案内するエラーを表示する）。自動起動した hub はダッシュボード終了後も常駐し続け、次回以降の起動では自動起動をスキップしてそのまま接続する。

既に hub に疎通できる場合も、`monomi` はその hub のバージョンを実行中の CLI と照合し、自動的に同期させる（詳細は後述の「自動アップデート（hub・reporter）」を参照）。

明示的に hub だけを起動・停止・確認したい場合は次のコマンドを使う。

```sh
monomi hub           # hub API サーバを起動（フォアグラウンド）
monomi hub status    # 稼働状態を表示（稼働中(pid/port/version)・停止中・stale pid）
monomi hub stop      # 稼働中の hub を停止（SIGTERM・終了確認後 pid ファイル削除）
```

ポートは `~/.monomi/config.yml` の `port`、待受アドレスは `bind`（例 `127.0.0.1` に戻す）で上書きできる。`role: child` を設定したデバイスで `monomi hub` を実行するとエラー終了する。

マシン再起動後もこのマシンを常時 hub として待ち受けさせたい場合（オプション。自動起動があるため通常は不要）は、launchd の LaunchAgent を手動設定する。まず `which node` と `which monomi`（グローバルインストール済みの場合）で絶対パスを確認し、`~/Library/LaunchAgents/com.monomi.hub.plist` を作成する。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.monomi.hub</string>
  <key>ProgramArguments</key>
  <array>
    <!-- `which node` の出力に置き換える -->
    <string>/absolute/path/to/node</string>
    <!-- `which monomi` の出力に置き換える -->
    <string>/absolute/path/to/monomi</string>
    <string>hub</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- ~ は展開されないので絶対パスで指定する -->
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.monomi/hub.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.monomi/hub.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.monomi.hub.plist    # 有効化（次回ログイン以降も自動起動）
launchctl unload ~/Library/LaunchAgents/com.monomi.hub.plist  # 無効化
```

`ProgramArguments` は `#!/usr/bin/env node` のシェバン解決に launchd の最小 PATH が依存しないよう、node の絶対パスを明示する形にしている。launchd が既に hub を起動している状態で `monomi`/`npx monomi-cli` を実行しても、既存 hub への疎通確認が先に成功するため二重起動はしない。

## フックの登録（reporter 連携）

Claude Code のフックから hub へ状態を報告するには `install-hooks` を実行する。

```sh
monomi install-hooks
```

`install-hooks` は bash レポーター（`~/.monomi/monomi-report.sh`、既存ファイルは上書き・実行権限を付与）を配置したうえで、`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Notification` / `Stop` / `SessionEnd` の7フックを `~/.claude/settings.json` へ冪等に登録する（既存の他ツール由来のフックは維持される）。レポーター配置に失敗した場合はフック登録前に異常終了する。除去する場合は `monomi uninstall-hooks` を実行する（フックのみ除去。レポーター本体は残る）。

フック登録後は、配置済みの reporter も `monomi` 起動のたびに自動で最新版に保たれる（詳細は後述の「自動アップデート（hub・reporter）」を参照）。

## デバイスのペアリング（child 追加）

MacBook など2台目以降のデバイス（child）を hub に接続するには、hub 側でコードを発行し、child 側でそれを使ってペアリングする。

```sh
# hub 側（Mac mini）
monomi hub pair
```

`monomi hub pair` は6桁コード（TTL 5分・5回失敗で無効化）と、検出できた到達先候補 URL（LAN / Tailscale）を表示する。

```sh
# child 側（MacBook）
monomi pair --code <code> [--hub <url> ...]
```

`--hub` は複数指定でき、指定順が到達優先順になる（省略時は hub 側が提示した候補を使う）。成功すると `~/.monomi/config.yml` に `role: child` / `hub_endpoints` / 自動生成 `device_id` が、token ファイルには発行された token が保存される（いずれも `chmod 600`）。

登録済みデバイスの管理は hub 側で行う。

```sh
monomi hub devices list          # 登録デバイス一覧（id・role・token有効/失効・last_seen）
monomi hub devices revoke <id>   # 該当デバイスの token を失効（以後そのデバイスは401）
```

## 自動アップデート（hub・reporter）

`monomi` は起動のたびに、稼働中の hub と配置済みの reporter スクリプトが実行中の CLI と同じバージョンかどうかを確認し、両者を同期させる。これにより `npm install -g monomi-cli` / `npx monomi-cli@latest` でアップグレードしても、旧バージョンのプロセスやスクリプトが取り残されない。

- **hub**（hub ロールのみ）: 自動起動時の疎通確認で hub のバージョンも取得し、CLI のバージョンと比較する。hub が旧版の場合（またはバージョンを応答しない旧ビルドの hub の場合。これも旧版扱い）は、graceful に停止（`monomi hub stop` と同じ SIGTERM）したうえで現在の版で再起動し、更新結果を notice で表示する。hub が CLI より新しい場合は hub をそのまま稼働させ、CLI 側のアップデート（例: `npx monomi-cli@latest`）を促す notice を表示する。graceful 停止が時間内に完了しない場合は強制終了せず、警告 notice を表示したうえで旧版 hub の稼働を継続する（更新は次回起動時に再試行される）。
- **reporter**: 配置済みの `~/.monomi/monomi-report.sh` はバージョンマーカーを保持している。これが CLI より古い場合（またはこの機能導入前のファイルでマーカー自体が無い場合）は自動的に再配置し、更新結果を notice で表示する。マーカーが現在の版と一致していれば何もしないため、最新版 reporter への手動編集は保全される。
- **child デバイス**: child はリモートの hub を再起動できないため、代わりにポーリング応答のたびに hub のバージョンを監視し、hub が旧版だと判明すると、そのデバイス上で hub 側の更新を促す notice を常時表示する（ポーリングのたびに重複表示はしない）。

これらの notice はダッシュボード上部の常時表示バナーに表示される。hub・reporter の自動アップデートを止めて notice の表示のみにしたい場合は、`~/.monomi/config.yml` で `auto_update: false` を設定する（既定値: `true`。詳細は後述の設定テーブルを参照）。

## 使い方

```
monomi                          稼働中 instance をダッシュボード表示（Ink。hub 不在なら自動起動）
monomi hub                      hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
monomi hub stop                 稼働中の hub を停止（SIGTERM・終了確認後 pid ファイル削除）
monomi hub status               hub の状態を表示（稼働中(pid/port/version)・停止中・stale pid）
monomi hub pair                 6桁ペアリングコードを発行し到達先候補 URL を表示（hub 側）
monomi hub devices list         登録デバイス一覧を表示（トークン有効/失効つき）
monomi hub devices revoke <id>  device のトークンを失効（以後その token は 401）
monomi pair --code <code> [--hub <url> ...]  hub とペアリングし token+設定を保存（child 側）
monomi install-hooks            Claude Code の7フックを ~/.claude/settings.json へ登録
monomi uninstall-hooks          Monomi 起因のフックのみ除去
monomi --version, -v            バージョンを表示
monomi --help, -h               このヘルプを表示
```

ダッシュボード（`monomi` 引数なし）のキー操作:

| キー             | 動作                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `1`-`6`          | 状態フィルタの切り替え（複数選択可、一覧表示中のみ）                   |
| `j`/`k`, `↑`/`↓` | 一覧: カーソル移動 / 詳細: イベント履歴を1行スクロール                 |
| `Enter`          | instance を選択して詳細を表示                                          |
| `←`/`→`          | 詳細: 一覧の並び順で隣接する instance へ移動                           |
| `w`              | 詳細: イベント行の折り返し⇔切り詰め表示を切り替え（既定は切り詰め）    |
| `f`              | セッションが動作しているターミナルタブをフォーカス（同一デバイスのみ） |
| `esc`            | 戻る（ヘルプを閉じる／詳細から一覧へ）                                 |
| `?`              | ヘルプ表示                                                             |
| `q`              | 終了                                                                   |

一覧カードには、ブランチ行とステータス行の間に instance の作業ディレクトリを示す `path` 行も表示される。ホームディレクトリは `~` に短縮表示され（例: `/Users/alice/project` → `~/project`）、それでもパスがカード幅に収まらない場合は、末尾ではなく中間を省略する形（`start…end`）で切り詰められる。これにより、似た名前の worktree を区別する手がかりになりやすい末尾のディレクトリ名が見えるようにしている。

一覧カードの末尾行には instance が現在実行中の Workflow / Agent / Skill 名を `▶ <name>` 形式で表示する（実行中でなければ `-`）。詳細ビューの概要 BOX にも同じ情報を `<name> (workflow|agent|skill)` 形式で表示する。開始時刻を取得できる場合は経過時間を末尾に付記する（一覧カード `▶ <name> (<経過時間>)`、詳細ビュー `<name> (workflow|agent|skill) <経過時間>`）。

## ターミナルフォーカス（`f` キー）

セッション行を選択した状態で `f` キーを押すと、そのセッションが動作しているターミナルウィンドウが前面に出て、対応するタブがフォーカスされる。これは、実行している CLI と同一マシン上のセッションでのみ動作する。別デバイスのセッション行を選択して `f` を押した場合は、画面にメッセージが表示されるだけで何も起きない（終了済みのセッション、ターミナル情報がないセッション、検出されたターミナルアプリが現在起動していない場合も同様）。Terminal.app・Ghostty・tmux に対応している。

Monomi がセッションの動作先ターミナルアプリを検出できた場合、セッションの一覧カードでデバイス名の隣にそのアプリ名を表示し（例: `device-name (Ghostty)`）、詳細ビューでは `Terminal` フィールドとして表示する。これにより、`f` を押す前に何が対象になるかを確認できる。

### macOS: 必要な権限許可

Monomi がターミナルウィンドウをプログラムから前面化するには、macOS のアクセシビリティ許可が必要。以下で許可を与える。

**システム設定 → プライバシーとセキュリティ → アクセシビリティ**:

- `monomi`（Monomi CLI プロセス）を追加
- `System Events` を追加（Ghostty・tmux のフォーカスに必須）

許可を与えていない状態でフォーカスを試みると、画面にヒントメッセージが表示される。

### Ghostty: 環境変数の手動設定

Ghostty を使う場合、`~/.claude/settings.json` に一度だけ環境変数を手動追加し、ターミナルタイトル操作を有効にする必要がある。

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"
  }
}
```

> **なぜ自動設定でなく手動か？** タイトル操作方式は動的ターミナルタイトルをグローバルに無効化する必要があり、すべての Claude Code セッションに影響する。予期しない副作用を防ぐため、Monomi は自動設定しない設計にしている。この設定がない状態で Ghostty フォーカスを試みると、失敗時にヒントメッセージが表示される。

設定を追加したら、Claude Code セッションを再起動する。

### Linux / WSL2

- **ネイティブ Linux（X11/Wayland）**: 現在サポートしていない。
- **WSL2**: Windows Terminal ウィンドウの前面化は best-effort で対応。タブ単位のフォーカスはサポート対象外。
- **tmux（全プラットフォーム）**: 対応している。tmux が detach 状態の場合は、セッションに到達不可能であることを示すメッセージが表示される。

## 設定 (`~/.monomi/config.yml`)

CLI の表示言語は既定で English。日本語表示にするには `locale: ja` を明示的に設定するか、OS の言語設定から自動判定させる（macOS はシステムの言語設定（`AppleLocale`）を優先し、取得できない場合のみ `LANG` 環境変数を見る。macOS 以外は `LANG` のみ。旧バージョンから引き継ぐ既存ユーザーは、日本語表示を維持するためにこの設定の追記が必要）。

| キー                                  | 既定値                 | 説明                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `role`                                | `hub`                  | `hub`（サーバ側）または `child`（`monomi pair` で自動設定される接続側）                                                                                                                                      |
| `port`                                | `47632`                | hub API の待受ポート                                                                                                                                                                                         |
| `bind`                                | `0.0.0.0`              | hub の待受アドレス。`127.0.0.1` にすると同一マシンからのみ待受                                                                                                                                               |
| `locale`                              | （未設定時に自動判定） | CLI の表示言語。`ja` または `en`。未設定時は OS の言語設定（macOS は `AppleLocale` 優先・`LANG` フォールバック、それ以外は `LANG`）から自動判定し、判定できない場合は `en` にフォールバック                  |
| `hub_endpoints`                       | （なし）               | `role: child` のときの hub 到達先候補（優先順のブロックシーケンス。§下記例）                                                                                                                                 |
| `device_id`                           | （自動生成）           | 未指定なら hub 起動時 / ペアリング時に hostname ベースで自動生成                                                                                                                                             |
| `auto_update`                         | `true`                 | `monomi` 起動のたびに hub・reporter を実行中の CLI バージョンへ自動で同期させるか。`false` にすると、実際の更新は行わずに notice の表示のみになる（詳細は前述の「自動アップデート（hub・reporter）」を参照） |
| `watch_interval`                      | `3s`                   | ダッシュボード watch モードのポーリング間隔                                                                                                                                                                  |
| `escalation_thresholds.active`        | `2h`                   | active 状態から放置(stale)へ昇格するまでの時間                                                                                                                                                               |
| `escalation_thresholds.approval_wait` | `6h`                   | 権限待ちから放置へ昇格するまでの時間                                                                                                                                                                         |
| `escalation_thresholds.next_wait`     | `24h`                  | 次の指示待ちから放置へ昇格するまでの時間                                                                                                                                                                     |
| `escalation_thresholds.pr_wait`       | `72h`                  | PR レビュー待ちから放置へ昇格するまでの時間                                                                                                                                                                  |

期間は `500ms` / `3s` / `30m` / `2h` / `1d` のように単位付き文字列で指定する。

`hub_endpoints` は `monomi pair` 実行時に自動で書き込まれるが、手動編集する場合はブロックシーケンス記法（1行1URL）にする（bash reporter が行単位で読むため）。

```yaml
role: child
hub_endpoints:
  - http://192.168.1.100:47632
  - http://100.64.0.1:47632
```

## アップデート

```sh
npm update -g monomi-cli
```

## アンインストール

以下の順で行う（DB・token を含む `~/.monomi` は最後にまとめて削除する）。

```sh
monomi uninstall-hooks     # 1. Claude Code の settings.json から Monomi 起因のフックのみ除去
monomi hub stop            # 2. 稼働中の hub を停止（launchd で常駐化していた場合は launchctl unload も行う）
npm uninstall -g monomi-cli  # 3. グローバルパッケージを削除（グローバルインストールしていた場合のみ）
rm -rf ~/.monomi           # 4. config.yml・SQLite DB・token・reporter を含め全データを削除
```

`~/.monomi` を削除すると、稼働履歴を保持している SQLite DB・ペアリング済みデバイスの token もすべて失われる。他デバイスと共有中の hub の場合は削除前に影響範囲を確認すること。

## ドキュメント

- 設計の権威仕様: `docs/ARCHITECTURE.md`（`docs/monomi-handoff.md` は設計経緯を記録した凍結資料であり、現行仕様の参照先ではない）
- 機能要件サマリー: `docs/REQUIREMENTS.md`（機能軸での現状要約。詳細は各 `docs/releases/release-N/requirements.md`）
- クラス設計: `docs/design/class-diagram.md`
- 開発ワークフロー: `docs/development-workflow.md`
- 開発者向けセットアップ: `docs/development.md`
- リリース要件: `docs/releases/`（`release-1-single-machine-wedge/`・`release-2-biome-migration/`・`release-3-multi-device-pairing/`・`release-4-cli-dashboard-ux/`・`release-5-docs-restructure/`・`release-6-detail-view-redesign/`・`release-7-session-status-reliability/`・`release-8-dashboard-freshness/`・`release-9-i18n/`・`release-23-terminal-focus/`）
- E2E 検証チェックリスト: `docs/releases/release-N/e2e-verification.md`（複数デバイス・ターミナルフォーカス機能の手動受け入れ試験手順）
- 既知の課題: `docs/known-issues.md`
