# Monomi

複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード。

Mac mini 上の hub と MacBook 等の child をペアリングし、child 側のセッション状態も hub の `monomi` ダッシュボードに横断表示できる（LAN 断時は Tailscale へ自動フォールバック。詳細は `docs/releases/release-3-multi-device-pairing/requirements.md` を参照）。

- 動作確認環境: macOS のみ
- パッケージマネージャ: pnpm

## セットアップ

```sh
pnpm install
pnpm build
```

`pnpm build` は `dist/` に成果物を出力し、`dist/cli.js` に実行権限を付与する。ローカルで `monomi` コマンドとして使うには `dist/cli.js` にパスを通す（例: `npm link` や `pnpm link --global`、もしくは `alias monomi="node $(pwd)/dist/cli.js"`）。

### hub の起動

```sh
monomi hub
```

初回起動時に `~/.monomi/`（config.yml・SQLite DB・token）を自動生成し、hostname ベースの `device_id` とローカル用 token を発行したうえで、既定ポート `47632` の全インターフェース（`0.0.0.0`）で待ち受ける。ポートは `~/.monomi/config.yml` の `port`、待受アドレスは `bind`（例 `127.0.0.1` に戻す）で上書きできる。`role: child` を設定したデバイスで `monomi hub` を実行するとエラー終了する。

### デバイスのペアリング（child 追加）

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

### フックの登録（reporter 連携）

Claude Code のフックから hub へ状態を報告するには、bash レポーターを配置してから `install-hooks` を実行する。

```sh
mkdir -p ~/.monomi
cp reporter/monomi-report.sh ~/.monomi/monomi-report.sh
monomi install-hooks
```

`install-hooks` は `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Notification` / `Stop` / `SessionEnd` の7フックを `~/.claude/settings.json` へ冪等に登録する（既存の他ツール由来のフックは維持される）。除去する場合は `monomi uninstall-hooks` を実行する。

## 使い方

```
monomi                          稼働中 instance をダッシュボード表示（Ink）
monomi hub                      hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
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
| `1`-`5`          | 状態フィルタの切り替え（複数選択可、一覧表示中のみ）                |
| `j`/`k`, `↑`/`↓` | 一覧: カーソル移動 / 詳細: イベント履歴を1行スクロール              |
| `Enter`          | instance を選択して詳細（Agent View Lv.1）を表示                    |
| `←`/`→`          | 詳細: 一覧の並び順で隣接する instance へ移動                        |
| `w`              | 詳細: イベント行の折り返し⇔切り詰め表示を切り替え（既定は切り詰め） |
| `esc`            | 戻る（ヘルプを閉じる／詳細から一覧へ）                              |
| `?`              | ヘルプ表示                                                          |
| `q`              | 終了                                                                |

## 設定 (`~/.monomi/config.yml`)

| キー                                  | 既定値       | 説明                                                                         |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `role`                                | `hub`        | `hub`（サーバ側）または `child`（`monomi pair` で自動設定される接続側）      |
| `port`                                | `47632`      | hub API の待受ポート                                                         |
| `bind`                                | `0.0.0.0`    | hub の待受アドレス。`127.0.0.1` にすると同一マシンからのみ待受               |
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

## 開発

```sh
pnpm lint          # biome lint .
pnpm format:check  # biome format . && prettier --check（Markdown のみ）
pnpm test          # vitest run
pnpm build         # tsc + dist/cli.js の実行権限付与
```

Lint・フォーマットチェックは [Biome](https://biomejs.dev/) に統一した（設定は `biome.jsonc`）。Markdown（`.md`/`.mdx`）のみ Prettier（`.prettierrc`）でチェックする。

reporter（bash）のテストは別途 `bash reporter/monomi-report.test.sh` で実行する（詳細は `reporter/README.md`）。

## ドキュメント

- 設計の権威仕様: `ARCHITECTURE.md`（`monomi-handoff.md` は設計経緯を記録した凍結資料であり、現行仕様の参照先ではない）
- 機能要件サマリー: `REQUIREMENTS.md`（機能軸での現状要約。詳細は各 `docs/releases/release-N/requirements.md`）
- クラス設計: `docs/design/class-diagram.md`
- 開発ワークフロー: `docs/development-workflow.md`
- リリース要件: `docs/releases/`（`release-1-single-machine-wedge/`・`release-2-biome-migration/`・`release-3-multi-device-pairing/`・`release-4-cli-dashboard-ux/`・`release-5-docs-restructure/`・`release-6-detail-view-redesign/`・`release-7-session-status-reliability/`）
- 既知の課題: `docs/known-issues.md`
