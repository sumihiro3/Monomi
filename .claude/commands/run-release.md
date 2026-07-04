---
description: リリース自動パイプライン(run-release)の起動。workflow.config.json を読込・スキーマ検証したうえで scriptPath 指定で起動し、完了・停止時の戻り値をユーザーに報告する
---

# /run-release — リリース自動パイプラインの起動

確定済み要件(config の `requirementsPath` が指す requirements.md)を入力に、実装→検査ループ→レビューループ→known-issues 起票→doc 同期→論理単位コミット→PR 作成までを統括する `run-release` ワークフローを起動する。

引数: `$ARGUMENTS`(対象リリース識別子。例: `release-1-login-form`。省略時は現在のブランチ名をリリース識別子とみなす。`autoApprove=false` を付けると config の値に関わらずコミット直前で停止する)

## 進め方

1. **config の読込**: `.claude/workflow.config.json` を Read する。ファイルが無い・読めない場合は「**`.claude/workflow.config.json` がありません**」と明示し、**起動しない**。値を推測で補完して起動することを禁止する。`.claude/config.schema.json` を参照して config を作成するよう案内して終了する
2. **スキーマ整合の確認**: `.claude/config.schema.json` を Read し、手順1で読み込んだ config が構造的に整合するかを確認する:
   - スキーマの `required` に列挙されたトップレベルキーがすべて存在する
   - `configVersion` が `1`(エンジン要求版)である
   - `checks`・`reviewDimensions` が非空配列で、各要素が必須フィールド(`key`/`cmd`/`cwd`、`key`/`prompt`)を持つ
   - `automation` に各上限値と `severityGate` が揃っている
   - 違反があれば違反箇所を列挙して**起動しない**(スキーマ検証ツールが利用可能な環境ならそれで検証してよい。無ければ上記の構造照合で足りる)
3. **リリース識別子の決定**: `$ARGUMENTS` で指定があればそれを、無ければ現在のブランチ名(`git branch --show-current`)をリリース識別子とする。現在ブランチが config の `baseBranch` と同一の場合は run-release の Gate 0 で拒否されるため起動せず、リリースブランチへの切替(または `/refine-requirements` からのやり直し)を案内する
4. **起動**: 以下で起動する。`config` には手順1で読み込んだファイル内容を**そのまま**渡す(要約・省略・補完をしない):

   ```
   Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "<リリース識別子>", config: <手順1で読み込んだ config>, autoApprove: <config.automation.autoApprove>}})
   ```

   - 起動は常に **scriptPath 指定**とする。name 指定(`{name: "run-release"}`)は、新規追加されたワークフローが同一セッション内で name 解決されない既知の罠があるため使わない
   - `$ARGUMENTS` に `autoApprove=false` の指定があれば、`args.autoApprove` をそれで上書きする(既定は `config.automation.autoApprove`)
5. **戻り値の読み取りと報告**: 後述の「戻り値の読み方」に従って結果を要約し、ユーザーに報告する

## 戻り値の読み方(完了・停止時)

run-release は完了時・停止時のいずれも戻り値で結果を返す(いずれの場合も push 通知が送信される)。以下の順で読み取って報告する:

1. **終了区分の特定**: まず次のどれで終わったかを特定する
   - **通常 PR 作成**: 全ゲート通過。PR の URL と PR 本文の要点(FR/AC 充足状況・最終検査結果・起票 ID・消費サマリー)を報告して完了
   - **draft PR 降格**: high 所見の残存・手動検証必須 AC の未実施・最終検査の収束不能のいずれか。未解決事項は PR 本文に明記されているので、残存項目とその解消手順を要約して報告する
   - **PR なしで停止**: Gate 0 preflight 拒否(ダーティツリー / ブランチ不一致 / 要件が「ステータス: 確定」でない / `configVersion` 不一致)、critical 所見の残存、収束不能、エージェント起動数上限超過のいずれか。停止理由を報告し、**ブランチ・作業状態は保全されている**(reset されていない)ことを添える
   - **コミット直前停止**(`autoApprove=false` 起動時の正常経路): 戻り値に含まれるコミット案・PR 案を提示し、`/logical-commits`(対話承認)へ引き継ぐ
2. **起票結果**: 未対応所見・収束不能分は known-issues に起票される。新規起票された ID・既存項目へ追記された ID を報告する。解決済みログへの移動提案(提案 diff)が含まれる場合は、適用可否をユーザーに確認する
3. **消費サマリー**: フェーズ別のエージェント起動数を報告に含める(上限到達で停止した場合の一次情報になる)

## 注意

- このコマンドはメインセッションから実行すること。他のワークフロー内から `workflow()` で run-release を呼ぶと、内部の `implement-feature` 呼び出しがネスト 2 段になり失敗する(workflow() のネストは 1 段まで)
- run-release の Gate 0 は作業ツリーがクリーンであることを要求する。未コミット変更がある場合は、先にコミットまたは stash を済ませてから起動する
- 停止後の再開は、停止理由(所見の修正・要件の確定・ブランチの切替など)を解消したうえで本コマンドを再実行する
- 検査コマンド・文書パス等の固有値をこのコマンド本文に書き写さない(config との二重管理を避け、常に config を正とする)
