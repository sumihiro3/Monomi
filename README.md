# Monomi

複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード。

Mac mini 上の hub と MacBook 等の child をペアリングし、child 側のセッション状態も hub の `monomi` ダッシュボードに横断表示できる（LAN 断時は Tailscale へ自動フォールバック。詳細は `docs/releases/release-3-multi-device-pairing/requirements.md` を参照）。

## 対応環境

- 動作確認環境: macOS のみ
- reporter（Claude Code フックから hub へ状態を報告する bash スクリプト）は bash 前提で動作し、macOS / Linux / WSL2 で動く
- 必要 Node.js バージョン: `>=22.5.0`（`package.json` の `engines.node` と一致。`npx`/`monomi` はいずれも起動時にこのバージョンを検査し、満たさない場合はエラー終了する）

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

明示的に hub だけを起動・停止・確認したい場合は次のコマンドを使う。

```sh
monomi hub           # hub API サーバを起動（フォアグラウンド）
monomi hub status    # 稼働状態を表示（稼働中(pid/port)・停止中・stale pid）
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

## 使い方

```
monomi                          稼働中 instance をダッシュボード表示（Ink。hub 不在なら自動起動）
monomi hub                      hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
monomi hub stop                 稼働中の hub を停止（SIGTERM・終了確認後 pid ファイル削除）
monomi hub status               hub の状態を表示（稼働中(pid/port)・停止中・stale pid）
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

| キー             | 動作                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `1`-`6`          | 状態フィルタの切り替え（複数選択可、一覧表示中のみ）                |
| `j`/`k`, `↑`/`↓` | 一覧: カーソル移動 / 詳細: イベント履歴を1行スクロール              |
| `Enter`          | instance を選択して詳細を表示                                       |
| `←`/`→`          | 詳細: 一覧の並び順で隣接する instance へ移動                        |
| `w`              | 詳細: イベント行の折り返し⇔切り詰め表示を切り替え（既定は切り詰め） |
| `esc`            | 戻る（ヘルプを閉じる／詳細から一覧へ）                              |
| `?`              | ヘルプ表示                                                          |
| `q`              | 終了                                                                |

一覧カードの末尾行には instance が現在実行中の Workflow / Agent / Skill 名を `▶ <name>` 形式で表示する（実行中でなければ `-`）。詳細ビューの概要 BOX にも同じ情報を `<name> (workflow|agent|skill)` 形式で表示する。開始時刻を取得できる場合は経過時間を末尾に付記する（一覧カード `▶ <name> (<経過時間>)`、詳細ビュー `<name> (workflow|agent|skill) <経過時間>`）。

## 設定 (`~/.monomi/config.yml`)

CLI の表示言語は既定で English。日本語表示にするには `locale: ja` を明示的に設定する（旧バージョンから引き継ぐ既存ユーザーは、日本語表示を維持するためにこの設定の追記が必要）。

| キー                                  | 既定値       | 説明                                                                         |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `role`                                | `hub`        | `hub`（サーバ側）または `child`（`monomi pair` で自動設定される接続側）      |
| `port`                                | `47632`      | hub API の待受ポート                                                         |
| `bind`                                | `0.0.0.0`    | hub の待受アドレス。`127.0.0.1` にすると同一マシンからのみ待受               |
| `locale`                              | `en`         | CLI の表示言語。`ja` または `en`                                             |
| `hub_endpoints`                       | （なし）     | `role: child` のときの hub 到達先候補（優先順のブロックシーケンス。§下記例） |
| `device_id`                           | （自動生成） | 未指定なら hub 起動時 / ペアリング時に hostname ベースで自動生成             |
| `watch_interval`                      | `3s`         | ダッシュボード watch モードのポーリング間隔                                  |
| `escalation_thresholds.active`        | `2h`         | active 状態から放置(stale)へ昇格するまでの時間                               |
| `escalation_thresholds.approval_wait` | `6h`         | 権限待ちから放置へ昇格するまでの時間                                         |
| `escalation_thresholds.next_wait`     | `24h`        | 次の指示待ちから放置へ昇格するまでの時間                                     |
| `escalation_thresholds.pr_wait`       | `72h`        | PR レビュー待ちから放置へ昇格するまでの時間                                  |

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

## 開発に参加する場合

開発に参加する場合はリポジトリの [`docs/development.md`](./docs/development.md) を参照。

## ドキュメント

- 設計の権威仕様: `docs/ARCHITECTURE.md`（`docs/monomi-handoff.md` は設計経緯を記録した凍結資料であり、現行仕様の参照先ではない）
- 機能要件サマリー: `docs/REQUIREMENTS.md`（機能軸での現状要約。詳細は各 `docs/releases/release-N/requirements.md`）
- クラス設計: `docs/design/class-diagram.md`
- 開発ワークフロー: `docs/development-workflow.md`
- 開発者向けセットアップ: `docs/development.md`
- リリース要件: `docs/releases/`（`release-1-single-machine-wedge/`・`release-2-biome-migration/`・`release-3-multi-device-pairing/`・`release-4-cli-dashboard-ux/`・`release-5-docs-restructure/`・`release-6-detail-view-redesign/`・`release-7-session-status-reliability/`・`release-8-dashboard-freshness/`・`release-9-i18n/`）
- 既知の課題: `docs/known-issues.md`
