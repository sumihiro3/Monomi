# Monomi

複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボード。

現状は **release-1（single-machine wedge）**: Mac mini 1台・hub 単体構成で、ターミナルに `monomi` と打つと同一マシン上の全プロジェクト/セッションが状態付きで一覧表示される、という中核ループのみをサポートする。複数デバイスのペアリングなど 2 台目以降の構成は未対応（詳細は `docs/releases/release-1-single-machine-wedge/requirements.md` を参照）。

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

初回起動時に `~/.monomi/`（config.yml・SQLite DB・token）を自動生成し、hostname ベースの `device_id` とローカル用 token を発行したうえで `http://127.0.0.1:47632`（既定ポート）で待ち受ける。ポートは `~/.monomi/config.yml` で上書きできる。

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
monomi                  稼働中 instance をダッシュボード表示（Ink）
monomi hub              hub API サーバを起動（DB 初期化 + bootstrap + HTTP）
monomi install-hooks    Claude Code の7フックを ~/.claude/settings.json へ登録
monomi uninstall-hooks  Monomi 起因のフックのみ除去
monomi --version, -v    バージョンを表示
monomi --help, -h       このヘルプを表示
```

ダッシュボード（`monomi` 引数なし）のキー操作:

| キー                       | 動作                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `1`-`5`                    | 状態フィルタの切り替え（複数選択可）                        |
| `w`                        | watch モードのオン/オフ（オン時は数秒おきに一覧を自動更新） |
| `j`/`k`, `↑`/`↓` + `Enter` | instance を選択して詳細（直近のイベントタイムライン）を表示 |
| `?`                        | ヘルプ表示                                                  |
| `q`                        | 終了                                                        |

## 設定 (`~/.monomi/config.yml`)

| キー                                  | 既定値       | 説明                                              |
| ------------------------------------- | ------------ | ------------------------------------------------- |
| `port`                                | `47632`      | hub API の待受ポート                              |
| `device_id`                           | （自動生成） | 未指定なら hub 起動時に hostname ベースで自動生成 |
| `watch_interval`                      | `3s`         | ダッシュボード watch モードのポーリング間隔       |
| `escalation_thresholds.active`        | `2h`         | active 状態から放置(stale)へ昇格するまでの時間    |
| `escalation_thresholds.approval_wait` | `6h`         | 権限待ちから放置へ昇格するまでの時間              |
| `escalation_thresholds.next_wait`     | `24h`        | 次の指示待ちから放置へ昇格するまでの時間          |
| `escalation_thresholds.pr_wait`       | `72h`        | PR レビュー待ちから放置へ昇格するまでの時間       |

期間は `500ms` / `3s` / `30m` / `2h` / `1d` のように単位付き文字列で指定する。

## 開発

```sh
pnpm lint          # eslint
pnpm format:check  # prettier --check
pnpm test          # vitest run
pnpm build         # tsc + dist/cli.js の実行権限付与
```

reporter（bash）のテストは別途 `bash reporter/monomi-report.test.sh` で実行する（詳細は `reporter/README.md`）。

## ドキュメント

- 設計の権威仕様: `monomi-handoff.md`（§0 が実装前レビューで確定した最新仕様）
- クラス設計: `docs/design/class-diagram.md`
- リリース要件・既知の課題: `docs/releases/release-1-single-machine-wedge/`
