# release-26-readme-lifecycle-accuracy 要件定義

- ステータス: 確定
- 作成日: 2026-07-17
- 対応する設計・参照資料: `docs/known-issues.md` **U20** / `README.md` / `README.ja.md` / `src/hub/hub-lifecycle.ts`（`hubStop()`）/ `src/cli.ts`（`run()` の `case undefined` 分岐）

## 背景と目的

リポジトリ public 化（2026-07-17）を機に、release-25-auto-update（v0.3.0）時点の実装内容と README のインストール・更新・アンインストール手順を突き合わせて監査したところ、3件の齟齬（事実誤認1件・説明不足1件・表現不正確1件）が見つかった（`docs/known-issues.md` U20）。

特に「Uninstalling」節の齟齬は実害を伴う。README には「`monomi hub stop` は launchd で常駐化していた場合 `launchctl unload` も行う」という注記があるが、この挙動は実装（`hubStop()`、`src/hub/hub-lifecycle.ts`）に一切存在せず、`launchctl` への言及は `src/` 全体で 0 件（grep で確認済み）。launchd の LaunchAgent 設定例は `KeepAlive: true` を使うため、この誤記のまま launchd 常駐環境でアンインストール手順を実行すると、`SIGTERM` 送信後に launchd が hub を自動再起動してしまい、ユーザーは「止まった」と誤認したまま次の手順（`npm uninstall -g` や `rm -rf ~/.monomi`）に進んでしまう。

残り2件（Updating 節の説明不足、Automatic updates 節冒頭の表現不正確）は実害は小さいが、公開ドキュメントとして読者に誤った理解を与えるため、同じ監査で見つかった以上まとめて是正する。

本リリースはドキュメント（`README.md`／`README.ja.md`／`docs/known-issues.md`）の文言修正のみを対象とし、コード変更は行わない。

## スコープの確定（壁打ちでの決定事項）

| 論点 | 決定 |
| --- | --- |
| スコープ範囲 | `docs/known-issues.md` U20 に記載された3件の齟齬修正のみ。README クイックスタートへのスクリーンショット追加（U13）など他の既知課題は本リリースに含めない |
| launchd 常駐時の停止手順の記載方法 | `launchctl unload ~/Library/LaunchAgents/com.monomi.hub.plist` を手動実行してから `monomi hub stop` する、という1案のみを案内する（plist の `KeepAlive` を外す代替案は併記しない） |
| FR の優先度 | 全FRを必須とする（公開ドキュメントの事実誤認・説明不足の是正のため） |
| AC の検証区分 | すべて自動検証可能（文言修正の内容はコード実査・diff レビューで機械的に判定できる）。launchd 常駐環境での実機動作確認は本リリースでは手動検証必須としない |

## 機能要件

### FR-01: Uninstalling 節の launchctl 誤記修正（優先度: 必須）

- 場所: `README.md`（Uninstalling 節、L252-263 付近）、`README.ja.md`（同）
- 対応する既知課題: `docs/known-issues.md` U20（対応方針 (a)）
- AC-1: README.md の `monomi hub stop` の手順行から「(also runs launchctl unload if it was kept running via launchd)」という、実装に存在しない挙動を示す注記を削除する
- AC-2: README.ja.md の該当行（「launchd で常駐化していた場合は launchctl unload も行う」）も同様に削除する
- AC-3: Uninstalling 節（手順表の直前または該当ステップの注記）に、launchd で常駐化させていた場合は `monomi hub stop` の前に `launchctl unload ~/Library/LaunchAgents/com.monomi.hub.plist` を手動実行する必要がある旨、およびこれを行わずに `monomi hub stop` のみ実行すると launchd が自動再起動し「止まっていない」ことに気づけない、という理由を簡潔に明記する
- AC-4: README.md と README.ja.md で情報量が同等であること（英日の記述量に差が生じないこと）

### FR-02: Updating 節と Automatic updates 節の関係の明記（優先度: 必須）

- 場所: `README.md`（Updating 節、L246-250 付近）、`README.ja.md`（同）
- 対応する既知課題: `docs/known-issues.md` U20（対応方針 (b)）
- AC-1: Updating 節に、`npm update -g monomi-cli`（グローバルインストール時）を実行しても稼働中の hub・配置済みの reporter はその場では更新されず、次回 `monomi`（引数なし）起動時の自動照合（"Automatic updates (hub & reporter)" 節）で同期される、という関係を追記する
- AC-2: Updating 節に、npx 利用者向けの更新手段（`npx monomi-cli@latest`）にも言及する
- AC-3: Updating 節から「Automatic updates (hub & reporter)」節への相互参照（節名を明示した参照文）を追加する
- AC-4: README.ja.md にも同内容を日本語で反映する（節名は README.ja.md 側の日本語見出し「自動アップデート（hub・reporter）」を参照する）

### FR-03: Automatic updates 節冒頭の限定条件の明記（優先度: 必須）

- 場所: `README.md`（L134 付近）、`README.ja.md`（同）
- 対応する既知課題: `docs/known-issues.md` U20（対応方針 (c)）
- AC-1: README.md の "Every `monomi` launch checks whether the running hub and the deployed reporter script are on the same version..." という文言を、版照合が引数なし起動（`src/cli.ts` の `run()` における `case undefined` 分岐）でのみ行われることが伝わる表現に修正する（例: "Every no-argument `monomi` launch checks..." 等）。`monomi hub status` 等のサブコマンド実行のたびに照合されるかのように読めないこと
- AC-2: README.ja.md の「`monomi` は起動のたびに、稼働中の hub と配置済みの reporter スクリプトが...」という文言も、引数なし起動時に限定される旨が伝わる表現（例: 「`monomi` を引数なしで起動するたびに」）に修正する

### FR-04: known-issues.md への解決反映（優先度: 必須）

- 場所: `docs/known-issues.md`
- AC-1: `docs/known-issues.md` の U20 エントリを「未解決（バックログ）」節から「解決済みログ」表へ移動し、解決リリースとして `release-26-readme-lifecycle-accuracy`（FR-01: launchctl 誤記修正、FR-02: Updating/Automatic updates 相互参照追加、FR-03: 限定条件表現修正）を記載する

## スコープ外

- README クイックスタートへのスクリーンショット追加（`docs/known-issues.md` U13）
- `docs/known-issues.md` の監査で「問題なし」と確認済みとされた範囲（Quick Start の3ステップ・`engines.node` 要件表記・install-hooks のフック登録内容・ペアリング手順・config.yml 設定項目一覧・uninstall-hooks の仕様・アンインストール手順の順序）の再修正
- `src/` 配下のコード変更（本リリースは README・known-issues.md の文言修正のみ）
- launchd 常駐運用そのものの改善（例: `hubStop()` に launchctl 連携を実装する等）。今回はドキュメントを実装に合わせる方向で是正し、実装をドキュメントに合わせる方向（launchctl 連携の新規実装）は採らない

## 未解決事項

特になし（壁打ちでの論点はすべて確定済み）。

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-26-readme-lifecycle-accuracy", config: <.claude/workflow.config.json の内容>}})
```
