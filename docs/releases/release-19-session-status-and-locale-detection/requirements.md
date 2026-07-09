# release-19-session-status-and-locale-detection — 要件定義

- リリース識別子: `release-19-session-status-and-locale-detection`
- ステータス: 確定
- 作成日: 2026-07-09
- 対応する設計: `docs/ARCHITECTURE.md`（§6 異常終了・ライブネス、§12 CLI 表示言語）、`docs/known-issues.md`（B9）、`docs/releases/release-9-i18n/requirements.md`（当時のスコープ外決定を本リリースで一部見直す）

## 背景と目的

2件の独立した既存課題を1リリースにまとめて対応する。

1. **B9（孤立セッションによる代表乗っ取り）**: `InstanceStatusRollup`（release-8 FR-02 の recency 優先化）は「`CLOSED` 以外はすべて live 候補」という単純な判定のため、`SessionEnd`/`Stop` を一度も送らず異常終了した孤立セッションが無期限に live 候補であり続ける。真に稼働中のセッションがある間は recency により隠れるが、そのセッションが `SessionEnd` を送って正常終了した瞬間、instance 内で唯一残る live 候補が数日前の孤立セッションになり、ユーザーが直前に正しく終了させたセッションの「終了」表示ではなく、無関係な孤立セッションの「放置」表示が代表として浮上する（2026-07-09、Monomi 自身のリポジトリで実機確認・再現済み。詳細は `docs/known-issues.md` B9）。
2. **OS ロケールからの表示言語自動判定**: release-9-i18n では「`config.yml` の `locale:` のみを見る。`LANG` 環境変数は解決に使わない（意図的に不採用）」と決定した（`docs/ARCHITECTURE.md:477`、`docs/releases/release-9-i18n/requirements.md:23,57`）。この結果、`locale: ja` を明示しない限り既定表示言語は英語になり、日本語 OS 環境のユーザーでも英語表示になる。今回、この決定を見直し `LANG` 環境変数からの自動判定を追加する（`config.yml` の明示設定は既存どおり最優先を維持する後方互換な変更）。

両者は実装箇所・影響範囲が独立しているため、1つの FR に押し込めず個別の FR として扱う。

## スコープの確定（壁打ちでの決定事項）

| 論点 | 決定 |
| --- | --- |
| B9 の修正方式 | rollup の「`CLOSED` 以外は live 候補」判定に、「同一 instance 内で最新の `CLOSED` セッションより `lastEventAt` が古い live セッション（zombie）は候補から除外する」を追加する。除外の結果 live 候補が0件になった場合は、その最新 `CLOSED` セッションを代表として採用する（表示が「終了」になる）。既存の B7/B8 修正（recency 優先化）には影響しない（真に `ACTIVE` なセッションは `lastEventAt` が常に最新のため除外対象にならない） |
| B9 の適用範囲 | 「`CLOSED` セッションより古い live 孤立セッション」のみを対象とする。`CLOSED` セッションが1件も無い instance（孤立セッションのみ、または現在進行形で放置中のセッションのみ）は対象外とし、従来どおりの挙動（そのセッションが代表になり `STALE` へ昇格しうる）を維持する |
| ロケール解決の優先順位 | `config.yml` の `locale:` 明示設定 > OS 環境変数（`LANG`）による自動判定 > 既定 `en`（release-9 の優先順位に OS 自動判定を1段追加する後方互換な変更） |
| OS ロケールの取得元 | `LANG` のみ。`LANGUAGE`/`LC_ALL`/`LC_MESSAGES` は今回対応しない（将来の拡張課題として残す） |
| 未対応ロケールのフォールバック | `LANG` が `ja`/`en` 以外（例: `fr_FR.UTF-8`、`zh_CN.UTF-8`）、未設定、空文字、`C`/`POSIX`（大文字小文字無視）の場合はすべて自動判定「なし」（`undefined`）とし、既定 `en` にフォールバックする |

## 機能要件

### FR-01: 孤立セッション（zombie live session）を rollup の代表選定から除外する（優先度: 必須）

- 場所: `src/status/instance-status-rollup.ts`（`InstanceStatusRollup.rollup()`）
- 対応する既知課題: `docs/known-issues.md` B9
- AC-1: `rollup()` は候補生成時、`live`（`display !== 'CLOSED'`）のうち、同一 instance 内で最も新しい `lastEventAt` を持つ `CLOSED` セッションの `lastEventAt` より古い `lastEventAt` を持つ live エントリを候補から除外する。`CLOSED` のエントリが1件も無い場合はこの除外を行わない（従来どおり全 live エントリが候補）
- AC-2: 上記除外の結果、live な候補が0件になった場合は、その最も新しい `CLOSED` セッションの `StatusResult`（`display: 'CLOSED'`）を代表として返す
- AC-3: 既存の回帰テスト（B7: 孤立 session が稼働中 session を覆い隠さない、B8: recency 優先で新しい session が古い状態に覆い隠されない）が壊れないことを確認する
- AC-4: 新規回帰テストを `instance-status-rollup.test.ts` に追加する: 「真に `ACTIVE` なセッションが存在する間は、そのセッションの `lastEventAt` が常に最新のため除外対象にならず、代表になる」ケース（B9 修正が B8 の挙動を壊さないことの直接確認）
- AC-5: 新規回帰テストを追加する: 「`CLOSED` セッションの直後、それより古い `lastEventAt` を持つ孤立 live セッションのみが残る instance」では、代表が最新の `CLOSED` セッション（`display: 'CLOSED'`）になる（B9 の再現条件そのものの回帰テスト。2026-07-09 に実機の `monomi.db` で確認した状況（孤立セッション → 正常終了セッション → `SessionEnd`）を模したフィクスチャで検証する）
- AC-6: 新規回帰テストを追加する: 「`CLOSED` セッションが1件も存在せず、孤立 live セッションのみの instance」では、従来どおりそのセッションが代表になり `STALE`（放置）へ昇格しうる（適用範囲外ケースでの挙動不変の確認）

### FR-02: OS ロケール（`LANG` 環境変数）からの CLI 表示言語自動判定（優先度: 必須）

- 場所: `src/i18n/index.ts`（`resolveLocale`）、新規 `src/i18n/os-locale.ts`（`LANG` 解析）、`src/cli.ts:150`（`loadLocale` の配線）
- 対応: release-9-i18n のスコープ外決定（`docs/ARCHITECTURE.md:477,525`、`docs/releases/release-9-i18n/requirements.md:23,57`）を本リリースで見直す
- AC-1: 新規関数 `detectLocaleFromEnv(env: NodeJS.ProcessEnv = process.env): MonomiLocale | undefined` を `src/i18n/os-locale.ts` に追加する。`env.LANG` の値から `_`/`.`/`@` より前の言語サブタグを抽出し、大文字小文字を無視して判定する
- AC-2: `LANG` の言語サブタグが `ja`（大文字小文字無視。例: `ja`、`ja_JP`、`ja_JP.UTF-8`、`JA_JP.UTF-8`）の場合は `'ja'` を返す
- AC-3: `LANG` の言語サブタグが `en`（大文字小文字無視）の場合は `'en'` を返す
- AC-4: `LANG` が未設定、空文字、`C`、`POSIX`（大文字小文字無視）、または `ja`/`en` 以外の言語サブタグ（例: `fr_FR.UTF-8`、`zh_CN.UTF-8`）の場合は `undefined` を返す
- AC-5: `resolveLocale` のシグネチャを `resolveLocale(configLocale?: MonomiLocale, osLocale?: MonomiLocale): MonomiLocale` へ拡張し、`configLocale ?? osLocale ?? 'en'` の優先順位で解決する
- AC-6: `src/cli.ts:150` の `loadLocale` 実装を、`loadLocaleFromConfig()` に加えて `detectLocaleFromEnv()` の結果も `resolveLocale()` へ渡すよう配線する
- AC-7: 回帰テスト: (a) `LANG=ja_JP.UTF-8` かつ `config.yml` 未設定 → `ja` 解決、(b) `config.yml` に `locale: en` が明示され `LANG=ja_JP.UTF-8` でも → config 優先で `en` 解決、(c) `LANG=fr_FR.UTF-8` かつ `config.yml` 未設定 → 既定 `en` へフォールバック、(d) `LANG` 未設定かつ `config.yml` 未設定 → 従来どおり `en`
- AC-8(手動検証必須): 実際に `LANG=ja_JP.UTF-8` を設定した端末（`config.yml` の `locale` は未設定）で `monomi` を起動し、日本語表示になることを目視確認する
- AC-9: `README.md` の表示言語に関する説明箇所に、`config.yml` の明示設定に加えて `LANG` 環境変数からの自動判定にも対応した旨を追記する（`sync-docs` 工程で実施）

## 非機能要件

- 依存関係の追加は行わない（release-9-i18n の非機能要件を継承）
- FR-02 は CLI 表示層の解決ロジックのみに閉じる。hub 側・reporter 側は引き続き i18n 対象外（release-9-i18n のスコープ境界を維持、実行時の日本語文字列が現存しないため対応不要）
- FR-01 は `src/status/` 層に閉じる。既存の N+1 対応（既知課題 P3）・イベント読み取り最適化（既知課題 P8）に新たな DB クエリを追加しない（`InstanceStatusRollup.rollup()` の入力 `entries` は既に `buildRow` が用意済みの値のみを使う）

## スコープ外

- `LANGUAGE`/`LC_ALL`/`LC_MESSAGES` 環境変数への対応（将来検討課題として残す）
- `ja`/`en` 以外の第三ロケールの追加
- ライブネス検知の本実装（heartbeat／`session_lost`）は引き続きスコープ外（`docs/ARCHITECTURE.md` §6）。FR-01 は「`CLOSED` より古い zombie の除外」という表示上の対症療法であり、孤立セッション自体を `CLOSED` へ確定させる根本対応ではない
- 「`CLOSED` セッションが存在しない instance で、現在進行形で放置中の孤立セッション」の扱い変更（従来どおり `STALE` へ昇格。B9 の再現条件＝`CLOSED` より古いケースのみに限定するため対象外）

## 未解決事項

- `LANGUAGE` 等への対応を将来追加する場合、`src/i18n/os-locale.ts` の解析ロジックをどう拡張するかは本リリースでは設計しない（release-9-i18n の未解決事項を踏襲）
- FR-01 の除外ロジックは「`CLOSED` セッションが1件でもあること」を前提にする。将来、真にライブネス検知（heartbeat/`session_lost`）が実装された場合、この対症療法（FR-01）をどう整理・撤去するかは未検討

## 次のステップ

要件確定後、以下で実装フェーズへ進む:

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-19-session-status-and-locale-detection", config: {
  "configVersion": 1,
  "language": "ja",
  "baseBranch": "main",
  "requirementsPath": "docs/releases/{release}/requirements.md",
  "conventionsDoc": "docs/ARCHITECTURE.md",
  "checks": [
    { "key": "lint", "cmd": "pnpm run lint", "cwd": "." },
    { "key": "format", "cmd": "pnpm run format:check", "cwd": "." },
    { "key": "test", "cmd": "pnpm run test", "cwd": "." },
    { "key": "build", "cmd": "pnpm run build", "cwd": "." }
  ],
  "reviewDimensions": [
    { "key": "bugs", "prompt": "正確性のレビュー: ロジックバグ、エラーハンドリング漏れ、境界条件、非同期処理の誤用を探してください。確信度の高いものだけ報告すること。" },
    { "key": "perf", "prompt": "性能のレビュー: 不要な再計算・再レンダリング、N+1 的なアクセス、大きなデータの無駄なコピー、ブロッキング処理を探してください。実害のあるものだけ報告すること。" },
    { "key": "arch", "prompt": "アーキテクチャ規約のレビュー: docs/ARCHITECTURE.md を読み、規約違反(責務分離、命名規則、型安全性など)を探してください。" },
    { "key": "security", "prompt": "セキュリティのレビュー: 入力バリデーション漏れ、機密情報のログ出力、権限チェック漏れを探してください。" }
  ],
  "diffPathScope": null,
  "syncDocs": {
    "targets": [
      { "path": "docs/ARCHITECTURE.md", "instruction": "docs/ARCHITECTURE.md を実装に同期してください。乖離がなければ変更しないこと。" },
      { "path": "README.md", "instruction": "README.md を同期してください。ユーザーに見える機能変更・セットアップ手順の変更のみ反映し、乖離がなければ変更しないこと。" },
      { "path": "docs/design/class-diagram.md", "instruction": "docs/design/class-diagram.md をクラス構成の実装差分に同期してください。乖離がなければ変更しないこと。" },
      { "path": "CHANGELOG.md", "instruction": "利用者に見える変更のみを Keep a Changelog 形式で Unreleased セクションへ追記する。乖離がなければ変更しない。" }
    ],
    "frozen": ["docs/monomi-handoff.md"],
    "excluded": ["docs/REQUIREMENTS.md"]
  },
  "knownIssues": {
    "path": "docs/known-issues.md",
    "categoryMap": { "bugs": "B", "perf": "P", "arch": "A", "security": "S", "check:test": "B", "check:build": "B", "check:lint": "L", "check:format": "L" },
    "defaultCategory": "N"
  },
  "models": {
    "review": "claude-opus-4-6",
    "verify": "sonnet",
    "explore": "sonnet",
    "design": "opus",
    "implementLow": "haiku",
    "implementMid": "sonnet",
    "implementHigh": "opus",
    "check": "haiku",
    "fix": "sonnet",
    "docSync": "sonnet",
    "bootstrap": "haiku"
  },
  "complexityRubricExamples": {
    "low": "設定値の変更、footer文言の追加、既存コンポーネントへの1行のprops追加",
    "mid": "既存コンポーネントと同じ設計で新規UIコンポーネントを1つ追加する",
    "high": "ポーリング機構のジェネリック化、スクロール位置とtail-follow挙動の状態設計、枠線へのタイトル埋め込みの文字数計算"
  },
  "automation": { "pipeline": "auto", "autoApprove": true, "maxFixIterationsCheck": 5, "maxFixIterationsReview": 3, "maxGate1RerunsPerReviewFix": 2, "maxTotalCheckRuns": 10, "maxAgentInvocations": 80, "severityGate": { "block": ["critical", "high"], "fixOnce": ["medium"], "backlogOnly": ["low"] } },
  "templateVersion": "d3cff89bef2d8b9af88a715ec0e6416589b17805",
  "installedAt": "2026-07-07"
}}})
```
