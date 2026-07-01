---
description: リリース要件の壁打ち。対話で要件を固め、docs/releases/release-N/requirements.md に確定要件を書き出す
---

# /refine-requirements — 要件壁打ちフェーズ

リリース(release-N)単位で要件をユーザーと壁打ちし、確定要件を `docs/releases/release-N/requirements.md` に書き出す。
`implement-feature` ワークフローはこのファイルを入力として受け取るため、**実装可能な粒度まで具体化してから確定**させること。

引数: `$ARGUMENTS`(対象リリース番号や要件の種。例: `release-1 ログイン機能`。省略時はユーザーに確認)

## 進め方

1. **現状把握**: プロジェクトの README / 要件書 (あれば) と、対象リリースの既存ドラフト (あれば `docs/releases/release-N/requirements.md`) を読む。関連する実装の現状は monomi-handoff.md から探索する
2. **壁打ち(対話)**: AskUserQuestion を使い、以下を1テーマずつ詰める。一度に全部聞かない:
   - 解決したい課題と成功基準(誰が・何に困っていて・どうなれば成功か)
   - スコープ(今回やること / 明示的にやらないこと)
   - 優先度(必須 / 推奨 / 将来)
   - 受け入れ基準(検証可能な形で)
   - 非機能要件(性能・セキュリティ・互換性)で関係するもの
3. **調査(必要時)**: 技術的な実現性・代替案の比較が必要なら、サブエージェント(Explore / general-purpose)や WebSearch で調査してから提案する。推測で断定しない
4. **確定要件の書き出し**: `docs/releases/release-N/requirements.md` に以下の構成で書く:
   - ヘッダー(リリース番号・ステータス: 確定・作成日)
   - 背景と目的
   - 機能要件(FR-XX 形式、優先度と受け入れ基準つき)
   - 非機能要件(該当するもののみ)
   - スコープ外(やらないと決めたこと)
   - 未解決事項(実装中に判断が必要な点)
5. **次のステップの提示**: `implement-feature` ワークフローへの引き継ぎ方法(`Workflow({name: "implement-feature", args: {release: "release-N"}})`)を案内して終了する

## 注意

- 既存ドラフトがある場合は、ドラフトを尊重しつつ曖昧な点・矛盾・不足を指摘して詰める
- ユーザーの回答と相反する技術的事実があれば、根拠つきで率直に指摘する
- 要件が大きすぎる場合はリリース分割(release-N → release-N+1)を提案する
