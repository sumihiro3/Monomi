# release-21-known-issues-cleanup 要件定義

- リリース識別子: release-21-known-issues-cleanup
- ステータス: 確定
- 作成日: 2026-07-13
- 参照資料: `docs/known-issues.md`（S10・S9・S4・S7・S8・A8・A9）、`src/cli/memory-watchdog.ts`、`src/cli/components/instance-card.tsx`・`detail-view.tsx`、`src/config/paths.ts`、`.github/workflows/publish.yml`・`ci.yml`、`docs/design/class-diagram.md`、`docs/ARCHITECTURE.md`

## 背景と目的

`docs/known-issues.md` に蓄積された低severityのバックログのうち、独立して小粒に片付けられる項目をまとめて解消する security/doc cleanup リリース。個々には後回しにしても実害は限定的だが、放置するほど「対応方針が既に書いてあるのに未着手」の項目が積み上がるため、release-20（B11 OOM対策）完了直後のこのタイミングでまとめて処理する。

対象として当初 S10・S9・S4・S7・S8・A8・A9 の7件を挙げたが、要件壁打ちの過程で **A8（class-diagram.md の `projectRows` シグネチャ齟齬）と A9（ARCHITECTURE.md の段階リリーステーブル欠落）は、release-20 の `sync-docs` ステップで既に修正済み**であることが判明した（`class-diagram.md:600` は現在 `projectRows(rows?: InstanceStatusRow[]) ProjectRow[]`、`ARCHITECTURE.md:528` には release-20 の行が実在する。いずれも git blame 上、release-20 の docs 同期コミット `1a4c51e` で修正済み）。`docs/known-issues.md` 側の記載が更新漏れになっていただけと判断し、本リリースではコード側の再修正ではなく known-issues.md のバックログ整理のみを行う（FR-05）。

実質的なコード変更を伴うのは S10・S9・S4・S7・S8 の5件（FR-01〜FR-04、うちS7/S8はFR-04にまとめる）。

## スコープの確定（壁打ちでの決定事項）

| 論点                   | 決定                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A8/A9 の扱い           | コード・ドキュメント本体は変更しない。既に release-20 の sync-docs で解消済みと確認できたため、known-issues.md 上でバックログから解決済みログへ移動するのみ（FR-05）。                  |
| S10 ローテーション方式 | リネームローテーション。閾値超過時に現行 `cli.log` を `cli.log.old` へリネームしてから新規 `cli.log` へ追記開始する。`cli.log.old` は直近1世代のみ保持し、既存があれば上書きする。      |
| S10 ローテーション閾値 | 10MB（`10 * 1024 * 1024` バイト）。known-issues.md の例示値どおり。現行の増加速度（1年約17MB）なら半年強で1回発生する頻度。                                                             |
| 各 FR の優先度         | 全て必須。本リリースの全スコープが既存バックログの解消であり、一部を見送る理由がないため。                                                                                              |
| S7/S8 の SHA 解決方法  | `gh api repos/<owner>/<repo>/tags` で対象タグ（`v7`/`v6`）が指す commit SHA を実際に取得し、コメントで元のタグ名を併記する形でワークフローファイルへ反映する（推測で SHA を書かない）。 |

## 機能要件

### FR-01: MemoryWatchdog の cli.log ログローテーション（優先度: 必須）

- 場所: `src/cli/memory-watchdog.ts`
- 対応する既知課題: S10（`docs/known-issues.md`）
- `MemoryWatchdog.sample()` は 60 秒間隔で `cli.log` へ無制限に追記し続けており、長期稼働でディスクを消費し続ける。
- AC-1: `sample()` は `appendFileSync` の前に `cli.log` の現在サイズを確認する。ファイルが存在しない場合（初回起動等）はローテーション判定をスキップしそのまま追記する。
- AC-2: `cli.log` のサイズが 10MB（`10 * 1024 * 1024` バイト）以上のとき、追記の前に現行 `cli.log` を `cli.log.old` へリネームする（`cli.log.old` が既に存在する場合は上書きする）。リネーム後、新規行を新しい `cli.log` へ追記する。
- AC-3: ローテーション処理（サイズ確認・リネーム）も既存の `try/catch` の対象内で行い、失敗（ENOSPC・EACCES 等）してもログ記録の失敗として静かに無視し、プロセスを終了させない（既存の AC-4 方針を維持）。
- AC-4: 単体テストで、閾値以上のダミー `cli.log` を事前に用意した状態で `sample()` を呼び出すと、`cli.log.old` に旧内容が退避され、`cli.log` が新規の1行のみになることを確認する。
- AC-5: 単体テストで、閾値未満のときはローテーションが発生せず、`cli.log` に追記され続けることを確認する（既存挙動の回帰なし）。
- AC-6: `cli.log.old` が既に存在する状態でローテーションが再度発生した場合、古い `cli.log.old` が新しい退避内容で上書きされることを確認する。

### FR-02: `project.name` のサニタイズ漏れ解消（優先度: 必須）

- 場所: `src/cli/components/instance-card.tsx`、`src/cli/components/detail-view.tsx`
- 対応する既知課題: S9（`docs/known-issues.md`、CWE-150）
- `instance-card.tsx:67` の `{row.project.name}` と `detail-view.tsx:290` の `<Text bold>{source.project.name}</Text>` が、同一コンポーネント内の `device.name`・`branch`・`session.id`・`path`・`running_work.name` と異なり `sanitizeDisplayText` を経由せず直接描画されている。
- AC-1: `instance-card.tsx` の `project.name` 描画箇所を `sanitizeDisplayText(row.project.name)` に変更する。
- AC-2: `detail-view.tsx` の `project.name` 描画箇所を `sanitizeDisplayText(source.project.name)` に変更する。
- AC-3: 単体テストで、ANSI エスケープシーケンス・制御文字を含む `project.name` を渡した場合に描画結果がサニタイズされることを確認する（`device.name` に対する既存テストと同じパターン）。

### FR-03: `ensureMonomiHome` の TOCTOU 窓解消（優先度: 必須）

- 場所: `src/config/paths.ts`
- 対応する既知課題: S4（`docs/known-issues.md`）
- `ensureMonomiHome` が `fs.mkdirSync(paths.home, { recursive: true })` を `mode` 指定なしで呼び出した直後に `chmodSync(HOME_DIR_MODE)` するため、ディレクトリ新規作成の瞬間に umask 既定パーミッション（通常 `0o755`）で一瞬存在する TOCTOU 窓がある。
- AC-1: `mkdirSync` 呼び出しに `mode: HOME_DIR_MODE` を追加する（`fs.mkdirSync(paths.home, { recursive: true, mode: HOME_DIR_MODE })`）。
- AC-2: 既存の `chmodSync(paths.home, HOME_DIR_MODE)` 呼び出しは削除せず維持する（既存ディレクトリの修復用として引き続き必要、known-issues.md の対応方針どおり）。
- AC-3: 既存の `paths.test.ts` のテストが引き続き通ることを確認する。新規ディレクトリ作成時のパーミッションが `0o700` になることを確認するテストが無ければ追加する。

### FR-04: GitHub Actions のサードパーティ Action を commit SHA へ固定（優先度: 必須）

- 場所: `.github/workflows/publish.yml`、`.github/workflows/ci.yml`
- 対応する既知課題: S7・S8（`docs/known-issues.md`）
- 両ワークフローが `actions/checkout@v7`・`pnpm/action-setup@v6`・`actions/setup-node@v6` という可変メジャータグで固定されており、特に `NPM_TOKEN` を扱う `publish.yml` はサプライチェーンリスクがある。
- AC-1: `publish.yml`・`ci.yml` の `actions/checkout@v7` を `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7` へ変更する（SHA は `gh api repos/actions/checkout/tags` で確認済み）。
- AC-2: 両ファイルの `pnpm/action-setup@v6` を `pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6` へ変更する。
- AC-3: 両ファイルの `actions/setup-node@v6` を `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6` へ変更する。
- AC-4: 変更後、PR 作成に伴い `ci.yml` が実際に GitHub Actions 上で成功することを確認する（手動検証必須） — SHA 固定によるワークフロー実行時の解決失敗は静的検査では検知できないため、PR 上の CI 結果で実地確認する。

### FR-05: known-issues.md の A8・A9 をバックログから解決済みログへ移動（優先度: 必須）

- 場所: `docs/known-issues.md`
- 対応する既知課題: A8・A9（いずれも `docs/known-issues.md`）
- 上記「背景と目的」のとおり、A8・A9 は release-20 の `sync-docs` ステップで既に解消済みであることを確認済み。コード・設計文書側の変更は不要で、known-issues.md のバックログ整理のみを行う。
- AC-1: `docs/known-issues.md` の「未解決（バックログ）」から A8・A9 の項目を削除し、「解決済みログ」テーブルへ移動する。解決リリース欄には `release-20-dashboard-heap-guard（sync-docsによる副次解消。バックログ記載の更新漏れをrelease-21で整理）` のように、release-20 の sync-docs で実質的に解消されていたことを明記する。
- AC-2: 移動時、`docs/design/class-diagram.md:600` の `projectRows` シグネチャが `src/cli/instance-list-store.ts` の実装（`projectRows(rows?: InstanceStatusRow[]): ProjectRow[]`）と一致していること、`docs/ARCHITECTURE.md` の段階リリーステーブルに release-20 の行が存在することを実際に再確認し、差分が無いことをコミットメッセージまたは作業ログで明示する。

## 非機能要件

- ディスク使用量: FR-01 により `cli.log` 系のディスク使用量は概ね閾値の2倍（`cli.log` 10MB + `cli.log.old` 10MB = 最大約20MB）で頭打ちになる。
- 互換性: FR-04 の SHA 固定は挙動を変えない（同一タグが指す commit を固定するだけ）。将来 Action のマイナー/パッチ更新を取り込みたい場合は、SHA を手動で更新する運用になる点は許容する。

## スコープ外

- `hub.log` のログローテーション（known-issues.md S10 の備考で hub.log は起動/停止でログが区切られる点が cli.log と異なると整理済みであり、本リリースでは対象外）。
- known-issues.md のその他の未解決項目（U5・U7・B4・A4・B3・P3・A1〜A3・N1・S5・P8・U9・U11〜U13・N3〜N7 等）。
- Actions の SHA 固定を自動追従させる仕組み（Dependabot 等の導入）。今回は静的な SHA 固定のみ行う。

## 未解決事項

- なし（本リリースの5件はいずれも known-issues.md に既に具体的な対応方針が記載済みで、壁打ちにより実装可能な粒度まで確定した）。

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-21-known-issues-cleanup", config: <.claude/workflow.config.json の内容>}})
```
