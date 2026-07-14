# release-22-github-releases-and-english-readme — 要件定義

- リリース識別子: `release-22-github-releases-and-english-readme`
- ステータス: 確定
- 作成日: 2026-07-14
- 対応する設計・参照資料: `docs/development-workflow.md`（npm 公開運用）、`docs/known-issues.md`（N4・N5・N6・N7）、`.github/workflows/publish.yml`、`CHANGELOG.md`

## 背景と目的

Monomi は release-17 以降 npm 公開レジストリへ配布しており、OSS として発信していく前提の公開まわりの整備要望が 2026-07-09 にまとまって起票された（known-issues N4〜N7・U13）。本リリースでは、そのうちユーザーが優先した2本柱と関連する小粒の整備を一括で行う。

1. **GitHub Release の自動作成（N5）**: 現状はバージョン bump 時に `CHANGELOG.md` へ追記するのみで、GitHub の Releases 機能を使っていない。タグ `v*` push で起動する `publish.yml` に Release 作成を組み込み、npm publish と GitHub Releases が常に揃う状態にする。
2. **README の英語化**: 現状の README.md は日本語のみで、npm パッケージページ・GitHub トップの第一言語が日本語になっている。README.md を英語化し、日本語版を README.ja.md として維持する日英二本立てにする。

あわせて、npm に表示される `package.json` の `description` の英語化、LICENSE のメールアドレス削除（N6）、GitHub リポジトリ About の整備（N7）、engines.node 下限環境での install 失敗に関する README 注記（N4）を行う。

## スコープの確定（壁打ちでの決定事項）

| 論点                        | 決定                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 関連バックログの同梱範囲    | N4（engines.node 注記）・N6（LICENSE メール削除）・N7（GitHub About 整備）を含める。U13（README スクリーンショット）は手動キャプチャ作業を伴い重いため見送り（バックログに残置）          |
| GitHub Release の自動化方式 | `publish.yml` に組み込む（タグ push だけで npm と GitHub Release が必ず揃う）。ローカル bump スクリプト側での作成は行わない                                                               |
| リリースノートの本文        | `CHANGELOG.md` の該当バージョン節を転記する（単一ソース・二重管理なし）。`--generate-notes` による PR タイトル自動生成は使わない。CHANGELOG が日本語である間は Release 本文も日本語のまま |
| README 英語化のファイル構成 | README.md=英語 + README.ja.md=日本語（OSS 標準構成。GitHub・npm の第一言語を英語に）。両ファイル冒頭に相互言語リンクを置き、以後の sync-docs 対象に両方を登録して同期を維持する           |
| package.json の description | 英語化する。N7 の GitHub About 説明文にも同じ英文を使い、npm / GitHub / README で表記を揃える                                                                                             |
| N4 の対応方式               | README への注記追加のみ（英日両方）。`engines.node` の下限引き上げは行わない（境界値の再検証が必要で、現行バージョンで動いていた環境を弾くリスクがあるため）                              |

## 機能要件

### FR-01: バージョンタグ push 時の GitHub Release 自動作成（優先度: 必須）

known-issues **N5** への対応。

- 場所: `.github/workflows/publish.yml`、`scripts/extract-changelog-notes.mjs`（新規）、`docs/development-workflow.md`、`docs/known-issues.md`
- AC-1: `CHANGELOG.md` から指定バージョン（例: `0.1.3`）の節（`## [0.1.3] - YYYY-MM-DD` 見出しから次の `## [` 見出しの直前まで、見出し行自体は含めない本文）を抽出して stdout へ出力するスクリプト `scripts/extract-changelog-notes.mjs` を新設する。該当バージョンの節が存在しない、または本文が空（空白のみ）の場合は stderr へエラーメッセージを出して非0で終了する
- AC-2: 抽出ロジックに自動テストを追加する。少なくとも「正常系（中間バージョン）」「最古バージョン（後続の `## [` 見出しが無い）」「該当バージョン無し」「本文が空」の4ケースを検証する
- AC-3: `publish.yml` のステップ順序を「test → build → リリースノート抽出（fail fast）→ npm publish → GitHub Release 作成」とする。抽出はタグ名から導いたバージョン（`v` 接頭辞除去）で行い、抽出失敗時は npm publish の実行前にジョブが失敗する
- AC-4: GitHub Release の作成は `gh release create` で行い、タイトルはタグ名（例: `v0.1.3`）、本文は AC-1 で抽出した CHANGELOG 節とし、`--verify-tag` を付ける。認証は `GITHUB_TOKEN`（`GH_TOKEN` 環境変数）を使い、新規のサードパーティ Action は追加しない（`gh` は GitHub ホステッドランナー同梱のものを使う）
- AC-5: `publish.yml` の `permissions` を Release 作成に必要な最小権限（`contents: write`）へ変更する
- AC-6: `docs/development-workflow.md` の「npm 公開（publish）運用」節に、タグ push で GitHub Release が自動作成されることと確認手順（例: `gh release view v<x.y.z>`）を追記する
- AC-7: `docs/known-issues.md` の N5 を解決済みログへ移動する
- AC-8: 受け入れ試験（手動検証必須） — 次回の実バージョン bump（タグ push）で、npm 公開と同時に GitHub Releases へ該当バージョンの Release が CHANGELOG 該当節の本文つきで作成されることを確認する

### FR-02: README の英語化と日英二本立て化（優先度: 必須）

known-issues **N4** の注記対応を含む。

- 場所: `README.md`、`README.ja.md`（新規）、`.claude/workflow.config.json`、`docs/development.md`、`docs/known-issues.md`
- AC-1: `README.md` を全節英語化する。構成（見出し・コードブロック・表）は現行を維持し、情報の欠落・省略をしない（launchd の plist 例・キー操作表・config.yml のキー一覧を含む）
- AC-2: 現行の日本語内容を `README.ja.md` へ移設する（英語版と情報同等を維持）
- AC-3: 両ファイルの冒頭に相互言語リンク（例: `English | [日本語](./README.ja.md)`）を置く
- AC-4: 対応環境（Requirements）節に N4 の注記を英日両方で追加する: `engines.node` 下限ちょうど（Node 22.5.0 同梱の npm 10.8.2 等）の古い npm では `npm install -g monomi-cli` が npm 自体の既知バグ（`Exit handler never called!`）で失敗することがあるため、失敗した場合は npm を最新化（`npm install -g npm`）してから再実行することを推奨する
- AC-5: `.claude/workflow.config.json` の `syncDocs.targets` を更新する: `README.md` の instruction に「英語で書く」旨を明記し、`README.ja.md` を日本語版として新規登録する（以後の sync-docs が両言語を同期する）
- AC-6: リポジトリ内の README.md への参照（`docs/development.md` 等）が引き続き正しいことを確認し、日本語読者向けの導線が必要な箇所には README.ja.md への参照を追記する。`reporter/README.md` など別ファイルの README は対象外（変更しない）
- AC-7: `docs/known-issues.md` の N4 を解決済みログへ移動する（注記対応で解決とし、engines 下限引き上げはしない旨を記録する）
- AC-8: 既存のテスト・lint・format 検査が通る（prettier は `**/*.md` を対象に含むため、新規 README.ja.md も整形チェックの対象になる）

### FR-03: package.json description の英語化（優先度: 必須）

- 場所: `package.json`
- AC-1: `description` を英語へ変更する。文言は「A CLI dashboard to monitor Claude Code session status (working / waiting for permission / waiting for input / PR review / idle) across multiple devices and projects.」を基準とし、実装時に自然な英語へ微調整してよい（FR-05 の GitHub About 説明文と同一の文言を使うこと）。`keywords` は現状維持
- AC-2: 既存テストが回帰なく通る（`description` を参照するテストが無いことを確認する）

### FR-04: LICENSE のメールアドレス削除（優先度: 必須）

known-issues **N6** への対応。

- 場所: `LICENSE`、`docs/known-issues.md`
- AC-1: 著作権表記を `Copyright (c) 2026 sumihiro3 <sumihiro@gmail.com>` から `Copyright (c) 2026 sumihiro3` へ変更する（それ以外の条文は変更しない）
- AC-2: `docs/known-issues.md` の N6 を解決済みログへ移動する

### FR-05: GitHub リポジトリ About の整備（優先度: 必須）

known-issues **N7** への対応。GitHub リポジトリ設定の変更であり、コード差分は known-issues の整理のみ。

- 場所: 該当なし（GitHub リポジトリ設定。`gh repo edit` で変更）、`docs/known-issues.md`
- AC-1: `gh repo edit` で次を設定する: description は FR-03 と同一の英文、homepage は `https://www.npmjs.com/package/monomi-cli`、topics は `claude-code`・`cli`・`dashboard`・`tui`・`monitoring`・`nodejs`・`ink`
- AC-2: `gh repo view --json description,homepageUrl,repositoryTopics` で AC-1 の3項目が反映されていることを確認する
- AC-3: `docs/known-issues.md` の N7 を解決済みログへ移動する

## 非機能要件

- **セキュリティ**: `publish.yml` の権限昇格は Release 作成に必要な最小（`contents: write`）に留める。新規のサードパーティ Action は追加しない。将来追加する場合は S7/S8 の解決方針と同様に commit SHA 固定とする
- **互換性**: `engines.node` は変更しない（既存ユーザー環境を弾かない）。CLI の表示言語（`src/i18n/`）には触れない。`CHANGELOG.md` の言語・形式（日本語・Keep a Changelog）は現状維持
- **情報同等性**: README の英語版・日本語版は情報同等を維持する（一方にのみ存在する記載を作らない）

## スコープ外（やらないと決めたこと）

- **U13**: README へのスクリーンショット追加（手動キャプチャ・画像運用の設計が必要なため見送り。バックログに残置）
- **CHANGELOG.md の英語化**: 過去分の翻訳・今後の記載言語の変更とも行わない。GitHub Release 本文も当面日本語のまま（CHANGELOG を将来英語化すれば Release も自動的に英語になる構成）
- **docs/ 配下（ARCHITECTURE.md 等）の英語化**
- **`engines.node` 下限の引き上げ**（N4 は README 注記のみで対応）
- **ローカル bump スクリプトからの Release 作成**（publish.yml に一本化）

## 未解決事項

- README 英訳の文体・用語の細部（コマンド説明の言い回し等）は実装時に決定し、レビューで調整する
- FR-05 の `gh repo edit` はコード差分を伴わない外部設定変更のため、パイプラインの実装照合（Gate 0.5）では known-issues の整理差分（AC-3）が実差分として現れる想定。実装エージェントは git commit を行わないこと（N8 の再発防止）

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-22-github-releases-and-english-readme", config: <.claude/workflow.config.json の内容>}})
```
