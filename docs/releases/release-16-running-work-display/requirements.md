# release-16-running-work-display 要件定義書

- リリース識別子: `release-16-running-work-display`
- ステータス: 確定
- 作成日: 2026-07-06
- 対応する設計・参照資料: `docs/ARCHITECTURE.md`／`docs/design/class-diagram.md`／`docs/known-issues.md`（**U6 対応**）

## 背景と目的

`install-hooks` が登録する `PreToolUse`/`PostToolUse`（matcher `*`）により、`Workflow`／`Agent`(Task)／`Skill` ツールの呼び出しイベント自体は hub に届いている。しかし reporter の `extract_tool_summary()` が `command/file_path/path/pattern/url` しか抽出しないため、ワークフロー名・サブエージェント名・スキル名が `tool_summary` に載らず、「今どのプロジェクトでどのワークフロー／エージェントが動いているか」がダッシュボードから分からない（known-issues **U6**）。

本リリースでは、これらの名前を reporter で抽出してイベントに載せ、hub で「実行中の作業名（running work）」としてセッション単位に導出し、一覧カード・詳細ビューの両方に表示する（フル貫通）。

## スコープの確定（壁打ちでの決定事項）

| 論点                                                               | 決定                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 表示の深さ（U6 元案はイベントログのみ）                            | **一覧カードまでフル貫通**。reporter 抽出 → hub 導出 → 詳細ビュー概要 → 一覧カードの全層に通す                                                                                                                                                                                                                                                                                                                       |
| 対象ツール                                                         | **Workflow・Agent(Task)・Skill の3種すべて**                                                                                                                                                                                                                                                                                                                                                                         |
| 消灯条件                                                           | **セッション状態と連動**。稼働中(ACTIVE)の間は最後に観測した名前を表示し続け、セッションが次の指示待ち／終了（`Stop`・`Notification(idle_prompt)`・`SessionEnd`）になったら消す。`UserPromptSubmit`（新ターン開始）も区切りとし、前ターンの名前を引きずらない。Pre/Post の厳密ペア追跡は採用しない（Workflow/Agent はバックグラウンド実行のため `PostToolUse` が即時発火し、ペア追跡では数秒で消えて実態と合わない） |
| ワークフロー実行中に内部エージェント・スキルのイベントが届いた場合 | **Workflow 名を優先表示**。現在の稼働区間内に Workflow の `PreToolUse` があれば、それより後の Task/Skill イベントで上書きしない                                                                                                                                                                                                                                                                                      |
| データの持ち方                                                     | **DB スキーマ変更なし**。既存 `events` テーブルの `tool_name`/`tool_summary` を運搬役とし、hub 側で導出する（Monomi にはマイグレーション機構が無く、`CREATE TABLE IF NOT EXISTS` の DDL では既存 DB に列を追加できないため）                                                                                                                                                                                         |

## 機能要件

### FR-01: reporter — Workflow/Agent/Skill ツールの名前抽出（優先度: 必須）

- 場所: `reporter/monomi-report.sh`（`extract_tool_summary()` および jq 無しフォールバック）
- known-issues **U6** への対応。
- `extract_tool_summary()` を拡張し、`tool_name` に応じて `tool_input` から表示名を抽出して `tool_summary` に載せる:
  - `Workflow`: `tool_input.name` → 無ければ `tool_input.scriptPath` の basename（ディレクトリと拡張子 `.js` を除去。例: `.claude/workflows/run-release.js` → `run-release`）→ どちらも無ければ（インライン `script` のみ）script 先頭部の `name:` 値の best-effort 抽出、それも失敗したら固定文言 `workflow` にフォールバック
  - `Task`（Agent ツール。tool_name が `Agent` で届く場合も同様に扱う）: `tool_input.subagent_type` と `tool_input.description` から `<subagent_type>: <description>` 形式（`subagent_type` が無ければ `description` のみ、両方無ければ空）
  - `Skill`: `tool_input.skill`
  - 上記以外のツールは従来どおり `command → file_path → path → pattern → url` の優先順で抽出する（既存挙動の回帰なし）
- jq が無い環境のフォールバックパス（sed ベース）でも、少なくとも `Workflow` の `name`/`scriptPath` と `Skill` の `skill`、`Task` の `subagent_type` を抽出できること（既存フォールバックと同じ best-effort 品質でよい）
- 受け入れ基準:
  - AC-1: `tool_name=Workflow` かつ `tool_input.name` があるとき、`tool_summary` にその値が入る
  - AC-2: `tool_name=Workflow` かつ `scriptPath` のみのとき、basename（拡張子除去済み）が入る（例: `run-release`）
  - AC-3: `tool_name=Workflow` かつインライン `script` のみのとき、script 内 `meta` の `name` 値が入る。抽出できない場合は `workflow` が入り、空にはならない
  - AC-4: `tool_name=Task` のとき `<subagent_type>: <description>` 形式で入る（`subagent_type` 単独・`description` 単独のケースも欠けている側を除いた形で入る）
  - AC-5: `tool_name=Skill` のとき `tool_input.skill` が入る
  - AC-6: 上記以外のツール（例: Bash の `command`、Read の `file_path`）の抽出結果が従来と一致する（回帰なし）
  - AC-7: jq 無しフォールバックでも AC-1・AC-2・AC-5 相当の抽出が動作する

### FR-02: hub — 「実行中の作業名」の導出と API 公開（優先度: 必須）

- 場所: `src/status/running-work-resolver.ts`（新規）、`src/hub/instance-status-service.ts`、`src/hub/dto.ts`
- 代表 session の直近イベント列から「実行中の作業名」を導出し、`GET /api/v1/instances`（一覧）と `GET /api/v1/instances/:id`（詳細）の両方に載せる。
- 導出規則:
  - 「現在の稼働区間」= セッションの最新イベントから遡り、区切りイベント（`Stop`・`Notification(idle_prompt)`・`SessionEnd`・`UserPromptSubmit`）に当たるまでのイベント列
  - 稼働区間内に `PreToolUse` かつ `tool_name=Workflow` のイベントがあれば、その `tool_summary` を `kind: workflow` として返す（複数あれば最新）
  - Workflow が無ければ、稼働区間内で最新の `PreToolUse` かつ `tool_name∈{Task, Agent, Skill}` の `tool_summary` を `kind: agent | skill` として返す
  - 稼働区間に該当イベントが無い、またはセッションの代表状態が稼働中(ACTIVE)でない（次の指示待ち・終了・放置昇格前の区切り後）場合は `null`
  - `tool_summary` が空文字・null の該当イベントは無視する（旧 reporter からのイベントとの互換）
- DTO: `InstanceStatusRow` に `running_work: { kind: 'workflow' | 'agent' | 'skill', name: string } | null` を追加する（`SessionDto`/`StatusDto` への内包でも可。設計フェーズで class-diagram との整合を優先して決めてよいが、一覧・詳細の両レスポンスから参照できること）
- DB スキーマ変更は行わない（`events` の既存列から導出する）
- 受け入れ基準:
  - AC-1: 稼働区間内に `PreToolUse Workflow`（tool_summary あり）があるセッションでは、一覧 API のレスポンスに `kind=workflow` とその名前が入る
  - AC-2: `PreToolUse Workflow` の後に `PreToolUse Task`/`Skill` イベントが続いても、返る名前は Workflow のまま維持される
  - AC-3: 稼働区間内に Workflow が無く Task/Skill のみの場合、最新の該当イベントの名前が `kind=agent`（Task/Agent）または `kind=skill`（Skill）で返る
  - AC-4: `Stop`・`Notification(idle_prompt)`・`SessionEnd` の後（＝次の指示待ち・終了）では `running_work` が `null` になる
  - AC-5: `UserPromptSubmit` で新ターンが始まった後、新たな該当イベントが来るまで `running_work` は `null`（前ターンの名前を引きずらない）
  - AC-6: `tool_summary` が空の Workflow/Task/Skill イベントしか無い場合は `null`（クラッシュ・誤表示しない）
  - AC-7: 一覧 API の既存フィールドは変更されない（フィールド追加のみの後方互換）

### FR-03: CLI — 一覧カード・詳細ビューへの表示（優先度: 必須）

- 場所: `src/cli/components/instance-card.tsx`、`src/cli/components/detail-view.tsx`、`src/cli/hub-api-client.ts`（型の追随）、`src/i18n/ja.ts`・`src/i18n/en.ts`
- 一覧カード: `running_work` があるとき `▶ <name>` の行を表示する。無いときは `branch` の `-` 表示と同じ流儀で行自体は維持し `-` を表示する（カード高さを安定させる）。カード幅に収まらない名前は既存の幅計算に従い切り詰める
- 詳細ビュー概要 BOX: `running` フィールドを追加し、`<name> (workflow|agent|skill)` の形式で表示する。`null` のときは `-`
- 表示前に `sanitize-display-text` を適用する（`tool_input` 由来の外部制御文字列であり、端末エスケープ注入（CWE-150）対策。release-10 の `device.name`/`branch` と同じ扱い）
- ラベル・kind 表記は i18n キー化し、`ja.ts`・`en.ts` の両方に追加する（`en.ts` 基準の `satisfies` 網羅チェックに従う）
- 受け入れ基準:
  - AC-1: `running_work` を含む一覧レスポンスを与えると、カードに `▶ <name>` 行が描画される（コンポーネントテスト）
  - AC-2: `running_work: null` のとき当該行は `-` 表示になり、カードの行数（高さ）が変わらない
  - AC-3: 詳細ビュー概要に `running` フィールドが表示され、kind が併記される
  - AC-4: 制御文字・ANSI エスケープを含む名前がサニタイズされて描画される
  - AC-5: 長い名前がカード幅で切り詰められ、レイアウトが崩れない
  - AC-6: i18n キーが `ja.ts`・`en.ts` の両方に存在し、`satisfies` 網羅チェックを通る
  - AC-7: 実機確認（手動検証必須） — 実際に Workflow（例: run-release）を実行中のプロジェクトで、ダッシュボードの一覧カードと詳細ビューに `▶ run-release` 相当の表示が出て、セッションが次の指示待ちになると消えること

## 非機能要件

- セキュリティ: 表示名は `tool_input` 由来の外部制御可能文字列であるため、CLI 表示前のサニタイズを必須とする（FR-03 AC-4）。reporter 側は既存の `json_escape`（制御文字の `\uXXXX` 化）を経由し、送信ペイロードを壊さないこと
- 性能: 導出は一覧ポーリングごとに全 instance で走る。既知課題 P3（一覧生成の N+1）を悪化させない実装とし、導出に使うイベント読み取りは代表 session の直近イベント（既存の recent_events 取得と同等の件数上限つきクエリ）に留める
- 互換性: 旧 reporter（名前抽出なし）からのイベントが混在しても hub がエラーにならず、`running_work` は `null` になるだけであること。API はフィールド追加のみで後方互換を保つ

## スコープ外（やらないと決めたこと）

- ワークフロー内部のフェーズ進捗（探索→設計→実装…）の可視化。フック単位では原理的に観測できず、Workflow 側からの専用イベント送出が要る別機能（U6 の記載どおり本リリースの対象外）
- 親子の階層表示（`run-release ▸ explore` 形式）。親子対応付けの追跡ロジックが別途必要になるため見送り、Workflow 名優先の単一表示とする
- 状態変化の OS 通知（known-issues U5。別リリース）
- `events`/`sessions` テーブルへの列追加およびマイグレーション機構の導入

## 未解決事項（実装中に判断が必要な点）

- `running_work` を DTO 上どこに置くか（`InstanceStatusRow` 直下か `SessionDto` 内包か）は、`docs/design/class-diagram.md` との整合を見て設計フェーズで確定する
- Workflow ツールの `tool_name` 表記（`Workflow` 固定か）と Agent ツールの表記（`Task`/`Agent`）は実イベントで揺れ得るため、実装時に両表記をマッチ対象にする前提で進め、実機確認（FR-03 AC-7）で検証する

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-16-running-work-display", config: <workflow.config.json の内容>}})
```
