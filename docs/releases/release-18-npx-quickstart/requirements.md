# release-18-npx-quickstart — 要件定義

- リリース識別子: `release-18-npx-quickstart`
- ステータス: 確定
- 作成日: 2026-07-07
- 対応する設計・参照資料: `docs/ARCHITECTURE.md`（hub 起動・status 導出・install-hooks）、`docs/known-issues.md`（U10・U8・S6・A6）、`docs/releases/release-17-npm-distribution/requirements.md`（パッケージング・bin 二層構造の前提）

## 背景と目的

release-17 で npm 配布基盤（パッケージング・CI・publish ワークフロー）は整ったが、npm への初公開は本リリース完了後まで保留と決定した（2026-07-07 ユーザー決定）。理由は導入体験: 現状は `npm i -g` → `monomi hub` 起動 → `monomi install-hooks` → 常駐化 と複数ステップを要し、「まず1台で試す」ユーザーへの第一印象が弱い。

本リリースは2本柱で構成する:

1. **npx 一発クイックスタート（U10）**: `npx monomi-cli` 一発で、初回セットアップ（フック登録の確認）→ hub 自動起動 → ダッシュボード表示まで完結させる。そのマシンがそのまま hub になり、複数台化は「別マシンから `monomi pair` するだけ」に格下げされる
2. **稼働中 Workflow 名表示の改善（U8・S6・A6）**: バックグラウンド Workflow 稼働中に `▶ <name>` 表示が消灯・別 Skill 名に化けるバグの修正と、経過時間表示の追加

前提となる技術的事実（要件確定前に実データで確認済み）:

- バックグラウンド Workflow の subagent が発火するフックイベントは**メインセッションと同一の session_id** で hub に届く（2026-07-07 実測）。現行イベントスキーマではメインループ操作と subagent 活動を区別できない
- reporter は hub 不達時に outbox へ退避し復帰後に再送するため、hub がダッシュボードと同時にしか稼働しない期間があってもイベントは欠損しない
- hub の初回起動 bootstrap（`~/.monomi/` 生成・token 発行）は既存実装がそのまま使える。npx キャッシュ実行でも `import.meta.url` から自パッケージ内の実体パスを解決できる

## スコープの確定（壁打ちでの決定事項）

| 論点                          | 決定                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hub 自動起動のタイミング      | 初回セットアップ時だけでなく**常時挙動**とする。`monomi`（引数なし）実行時に hub 疎通を確認し、不在なら detached spawn（自己修復設計）。`role: child` のマシンでは行わない                  |
| 初回の install-hooks          | **確認プロンプト付き**（`~/.claude/settings.json` を書き換える侵襲的操作のため無断実行しない）。フック未登録を検知したら Y/n で確認、非 TTY 環境ではプロンプトを出さず案内のみ              |
| マシン再起動後の hub 自動起動 | launchd 登録は**実装しない**（自己修復=次回 `monomi` 実行時の再 spawn で十分とする）。ただし常時稼働させたい人向けに **launchd の手動設定例を README に記載**する                           |
| hub の bind 既定              | 現行の `0.0.0.0` + token 認証を維持（「いつでも別マシンから pair できる」ため。127.0.0.1 縮小案は不採用）                                                                                   |
| U8 の修正方式                 | **導出規則の変更のみ**（DB スキーマ・reporter 変更なし）。subagent 識別による精緻化は known-issues に新規起票して将来へ                                                                     |
| 表示改善の範囲                | U8 バグ修正 + **経過時間表示**（`▶ run-release (12m)`）+ **S6 解消**（kind フォールバックのサニタイズ漏れ）。ネスト表示（run-release ▸ review-changes）は現行イベントで識別困難なため対象外 |
| A6 の同時解消                 | 経過時間表示で `RunningWork` の wire 表現に手を入れるため、この機会に `RunningWorkDto` を新設して DTO 変換を挟み A6 を解消する                                                              |
| README の常駐記述             | pm2 前提の記述を撤去し、launchd の手動設定例に置き換える（自動復旧が主経路になるため常駐は任意の上級者向け設定に格下げ）                                                                    |
| npm 初公開                    | 本リリースのスコープ外（マージ後の運用ステップ。release-17 で整備済みの手順書どおり `pnpm version:minor` → tag push）                                                                       |

## 機能要件

### FR-01: hub の自動起動（自己修復）（優先度: 必須）

- 場所: `src/cli.ts`（`case undefined` のダッシュボード起動経路）、`src/cli/hub-autostart.ts`（新規）

known-issues **U10** 対応の中核。`monomi`（引数なし）実行時、ダッシュボード表示の前に以下を行う:

1. config の `role` を判定。`child` なら何もしない（従来どおり `hub_endpoints` へ接続）
2. `role: hub`（既定）なら、設定 port への疎通を確認する
3. 不在なら、自パッケージ内の CLI 実体（`import.meta.url` 起点で解決）を `process.execPath` で `hub` サブコマンド起動する。spawn は detached + `unref()` とし、stdout/stderr は `~/.monomi/hub.log` へ追記リダイレクトする
4. 起動完了をリトライ付き疎通確認で待ってからダッシュボードへ進む。タイムアウト時は hub.log の場所を示すエラーで異常終了する
5. 既に hub が稼働中（疎通成功）の場合は何も spawn しない（既存の手動運用・pm2/launchd 運用と共存）

受け入れ基準:

- AC-1: `role: hub` かつ hub 不在で `monomi` を実行すると、hub が spawn されダッシュボードが表示される（spawn・疎通を DI で差し替えたユニットテストで検証）
- AC-2: hub が既に稼働中の場合は spawn せずダッシュボードへ直行する
- AC-3: `role: child` のマシンでは spawn を行わない
- AC-4: spawn 後の疎通確認がタイムアウトした場合、`~/.monomi/hub.log` への参照を含む分かりやすいエラーで exit code 1 終了する
- AC-5: 受け入れ試験（手動検証必須） — `~/.monomi` と hub プロセスが無いクリーン状態から `monomi` 一発で、hub 自動起動・token 自動発行・ダッシュボード表示・自セッションの表示まで到達すること

### FR-02: hub のライフサイクル管理（pid・stop・status）（優先度: 必須）

- 場所: `src/hub/serve.ts`（pid 書き込み）、`src/cli.ts`（サブコマンド追加）、`src/hub/hub-lifecycle.ts`（新規）

known-issues **U10** 対応。自動 spawn した hub を管理する手段を設ける:

- hub 起動時に `~/.monomi/hub.pid` を書き込み、正常終了時に削除する
- `monomi hub status`: pid ファイルとプロセス生存確認・port 疎通を突き合わせ、稼働状態（稼働中 pid/port・停止中・stale pid）を表示する
- `monomi hub stop`: pid のプロセスへ SIGTERM を送り、猶予付きで終了を確認して pid ファイルを掃除する。停止していなければその旨を表示する
- stale pid（ファイルはあるがプロセス不在）は status/自動起動の双方で自己回復する（無視して上書き）
- hub 起動が port 使用中（EADDRINUSE）で失敗した場合は「既に稼働中の可能性」を示すエラーメッセージにする

受け入れ基準:

- AC-1: `monomi hub status` が稼働中・停止中・stale pid の3状態を正しく報告する（ユニットテスト）
- AC-2: `monomi hub stop` が稼働中の hub を停止し pid ファイルを削除する。停止済みの場合はエラーにせずその旨を表示する
- AC-3: stale pid が残った状態でも FR-01 の自動起動が正常に機能する
- AC-4: `--help` のコマンド一覧に `hub stop`/`hub status` が追記されている（i18n の en/ja 両方）

### FR-03: 初回セットアップの確認プロンプト（install-hooks）（優先度: 必須）

- 場所: `src/cli.ts`（ダッシュボード起動経路）、`src/install-hooks/install-hooks.ts`（未登録検知の再利用）

known-issues **U10** 対応。ダッシュボード起動時に Monomi のフックが `~/.claude/settings.json` に未登録であることを検知したら、TTY 環境では「install-hooks を実行しますか? [Y/n]」の確認プロンプトを表示し、承諾時のみ `install-hooks`（release-17 の reporter 自動配置を含む）を実行する。

- 拒否された場合はその選択を `~/.monomi` 配下に永続化し、以後の起動では再プロンプトせず1行の案内表示のみとする
- 非 TTY 環境ではプロンプトを出さず、未登録の案内のみ表示して続行する
- プロンプト文言は i18n キー化する（en/ja）

受け入れ基準:

- AC-1: フック未登録 + TTY で確認プロンプトが表示され、承諾で install-hooks が実行される（DI でプロンプト・installHooks を差し替えたテスト）
- AC-2: 拒否が永続化され、次回起動では再プロンプトされない（案内1行のみ）
- AC-3: フック登録済みの環境ではプロンプトも案内も表示されない
- AC-4: 非 TTY ではプロンプトを出さない

### FR-04: running-work 消灯境界の再設計（U8 修正）（優先度: 必須）

- 場所: `src/status/running-work-resolver.ts`、`src/hub/instance-status-service.ts`（駆動側）、`docs/known-issues.md`（U8 を解決済みへ移動 + 精緻化の新規起票）

known-issues **U8** 対応。バックグラウンド Workflow はツール呼び出しが数秒で完結し直後の `Stop` が消灯境界になるため、本体が subagent 活動で raw_state=ACTIVE を維持したまま稼働中でも `running_work` が null（または境界より新しい Skill/Agent 名）になる。導出規則を次のとおり変更する:

- **Workflow 候補**: `Stop`/`UserPromptSubmit`/`Notification(idle_prompt)` を消灯境界としない。`SessionEnd` のみで消灯する（既存のページング上限の範囲で最新の `PreToolUse|Workflow` まで遡る）
- **Skill/Agent（fallback）候補**: 従来の境界規則（`Stop`/`UserPromptSubmit`/`idle_prompt`/`SessionEnd` で打ち切り）を維持する
- **優先順位**: 境界を跨いで見つけた Workflow は、境界内の Skill/Agent より優先する（今回の実障害「run-release 稼働中に investigate 表示」の直接解消）
- ACTIVE ゲート（非 ACTIVE は導出しない）は従来どおり維持する
- トレードオフを仕様として明記する: Workflow 完了後もセッションが稼働し続ける間は名前が残り得る（完了シグナルが現行フックに存在しないため）。この精緻化（reporter による subagent 識別等）は known-issues に新規起票して将来対応とする

受け入れ基準:

- AC-1: 実障害シナリオの回帰テスト — `PreToolUse|Workflow` → `PostToolUse` → `Stop` → 他ツールイベント群 → `UserPromptSubmit` → `PreToolUse|Skill` の順のイベント列で、running_work が Workflow 名になる
- AC-2: `SessionEnd` 以降は Workflow 候補が消灯し null になる
- AC-3: 非 ACTIVE（NEXT_WAIT/APPROVAL_WAIT/CLOSED）では従来どおり導出しない（既存テストが green のまま）
- AC-4: Skill/Agent の fallback は従来の境界規則のままである（既存テストで担保）
- AC-5: `docs/known-issues.md` の U8 が解決済みログへ移動し、精緻化（subagent 識別）が新規項目として未解決バックログに起票されている
- AC-6: `docs/ARCHITECTURE.md` の running-work 導出規則の記述が新仕様（候補種別ごとの境界の非対称とトレードオフ）に更新されている

### FR-05: 経過時間表示と RunningWorkDto の分離（A6 解消）（優先度: 必須）

- 場所: `src/status/running-work-resolver.ts`（`startedAt` の追加）、`src/hub/dto.ts`（`RunningWorkDto` 新設）、`src/hub/instance-status-service.ts`（変換）、`src/cli/components/instance-card.tsx`・`src/cli/components/detail-view.tsx`（表示）、`docs/known-issues.md`（A6 を解決済みへ移動）

known-issues **A6** 対応を含む。稼働中の作業名に経過時間を添える:

- `RunningWork` に開始時刻（採用した `PreToolUse` イベントの `occurred_at`）を追加する
- wire 層に `RunningWorkDto` を新設し、status レイヤーの `RunningWork` から明示的な変換関数を挟む（A6 の指摘どおり `StatusDto`/`StatusResult` と同じ分離パターンに揃える）
- CLI 表示: 一覧カードは `▶ <name> (<経過時間>)`、詳細ビューは既存の `<name> (workflow)` 形式に経過時間を追加する。経過時間の表記はプロジェクト既存の期間表記（`3s`/`30m`/`2h` 系）に合わせる

受け入れ基準:

- AC-1: 一覧カードと詳細ビューの両方で稼働中作業の経過時間が表示される（ink-testing-library のコンポーネントテスト）
- AC-2: `dto.ts` に `RunningWorkDto` と変換関数が存在し、status レイヤーの型を wire に直接使用していない
- AC-3: `docs/known-issues.md` の A6 が解決済みログへ移動している
- AC-4: `docs/design/class-diagram.md` が新しい型構成に同期されている

### FR-06: running_work.kind フォールバックのサニタイズ（S6 解消）（優先度: 必須）

- 場所: `src/cli/components/detail-view.tsx`（`runningWorkKindLabel`）、`docs/known-issues.md`（S6 を解決済みへ移動）

known-issues **S6** 対応。未知の `kind` 値をそのまま返すフォールバックパスを `sanitizeDisplayText()` 経由に変更する（CWE-150 対策。`running_work.name` と同水準に揃える）。

受け入れ基準:

- AC-1: ANSI エスケープを含む未知 kind 値がサニタイズされて描画されるテストが追加されている
- AC-2: `docs/known-issues.md` の S6 が解決済みログへ移動している

### FR-07: README・ドキュメントのクイックスタート再構成（優先度: 必須）

- 場所: `README.md`、`docs/development.md`（必要なら）、`docs/ARCHITECTURE.md`（起動フローの追記）

known-issues **U10** 対応の仕上げ。README の導入手順を npx 一発に再構成する:

- クイックスタート: `npx monomi-cli` 一発（初回プロンプト→ダッシュボードまで）を冒頭に。恒常利用向けに `npm install -g monomi-cli` も併記する
- hub の手動起動・常駐の節: 自動起動が既定であることを説明し、pm2 前提の記述を撤去して**マシン再起動後も常駐させたい人向けの launchd 手動設定例**（コピペ可能な plist と `launchctl` コマンド）に置き換える
- `monomi hub stop`/`status` をコマンド一覧・アンインストール手順（hub 停止を追加）に反映する

受け入れ基準:

- AC-1: README のクイックスタートが `npx monomi-cli` 起点で記述され、pm2 前提の常駐記述が撤去されている
- AC-2: launchd の設定例がコピペ可能な形で記載されている
- AC-3: アンインストール手順に `monomi hub stop` が含まれている
- AC-4: 受け入れ試験（手動検証必須） — README のクイックスタート記載手順だけを見て、クリーン環境で導入〜ダッシュボード表示まで到達できること（FR-01 AC-5 と併せて実施）

## 非機能要件

- **互換性**: 既存の運用（`monomi hub` 手動起動・pm2/launchd 常駐・child ペアリング済み構成）を壊さない。hub 稼働中の自動起動はスキップされ、config.yml・DB スキーマ・hub API の既存フィールドは変更しない（`running_work` への `started_at` 追加は後方互換な追加フィールドとする。hub と CLI のバージョン混在時は経過時間が非表示になるだけで従来表示は維持する）
- **セキュリティ**: spawn するのは自パッケージ内の CLI 実体のみ（外部パス・環境変数由来のコマンドを実行しない）。pid ファイルの値はプロセス生存確認を経てからシグナル送信する（無検証 kill をしない）。`~/.monomi/hub.log` は home の 0o700 に守られる範囲に置く
- **性能**: FR-04 の境界跨ぎスキャンは既存のページング上限を維持し、非 ACTIVE instance に追加のイベント読み取りを発生させない（P3・P8 を悪化させない）

## スコープ外（やらないと決めたこと）

- launchd への自動登録コマンド（手動設定例の記載のみ。将来リリースで検討）
- reporter による subagent 由来イベントの識別（U8 精緻化。known-issues へ新規起票して将来対応）
- ネストした Workflow/Agent の階層表示（現行イベントでは識別困難）
- npm への実 publish（本リリースのマージ後、release-17 で整備した手順書どおりに実施する運用ステップ）
- Windows ネイティブ対応（reporter が bash 前提である現状は不変）

## 未解決事項（実装中に判断が必要な点）

- **`Notification(idle_prompt)` の扱い**: FR-04 では Workflow 候補の消灯境界から外す方針だが、長時間ランの実イベント列（2026-07-07 14:05〜15:02 の run-release 実行区間が hub DB に残っている）で idle_prompt の発火実績を確認し、境界集合を最終確定する
- **プロンプト拒否の永続化方式**: `~/.monomi/config.yml` のキーにするか別ファイルにするか（config.yml 汚染と bash reporter の行単位読みへの影響を考慮して設計時に決定）
- **hub.log のサイズ管理**: 本リリースでは追記のみとし、ローテーションの要否は運用実績を見て判断（必要なら known-issues へ起票）

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-18-npx-quickstart", config: <.claude/workflow.config.json の内容>}})
```
