# release-10-dashboard-polish — 要件定義

- リリース識別子: `release-10-dashboard-polish`
- ステータス: 確定
- 作成日: 2026-07-04
- 対応する設計: `docs/ARCHITECTURE.md`、`docs/known-issues.md`（U1・U2・U3・U4）

## 背景と目的

`docs/known-issues.md` にストックされている画面表示系の未解決課題（U1: ヘッダータイトルの視認性／U2: watching インジケータの点滅／U3: 選択中カードの強調／U4: フィルタとカードグリッドの連動）へ対応し、CLI ダッシュボードの視認性・操作性を改善する。壁打ちの過程で追加で判明した文言課題（`help.openDetail` の内部用語露出、watching 文言が release-9-i18n の i18n 化対象から漏れていた点）も合わせて解消する。

## スコープの確定（壁打ちでの決定事項）

| 論点                                       | 決定                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U4 の実現方式                              | 「非該当カードのグレーアウト」は `InstanceListStore.filtered()` を除外方式から全件表示＋淡色化方式へ変更する必要があり、選択カーソル移動（`filtered().length` 基準）や release-8 で確定した「closed は既定非表示」との再設計を伴う大きめの変更と判明。壁打ちの結果、**現行の除外方式は維持**し、視覚的連動はフィルタバー側の強調＋件数ヒントで実現する（FR-05） |
| P4（無条件再レンダー・集計重複計算）の扱い | 本格修正は今回のスコープに含めない。ただし FR-02（watching 点滅）が P4 の問題を新規に悪化させないよう、点滅ロジックは専用コンポーネントへ分離する                                                                                                                                                                                                               |
| 文言変更のロケール適用範囲                 | `help.openDetail` の簡素化・watching 文言の大文字化は `en`/`ja` 両方に適用し、release-9-i18n の `satisfies` 網羅性チェックを維持する                                                                                                                                                                                                                            |

## 機能要件

### FR-01: ヘッダータイトルの視認性向上（優先度: 必須）

- 場所: `src/cli/components/app-view.tsx`（`<Text bold>Claude Code Status</Text>`）
- AC-1: タイトル文言を `Claude Code Status` から `Monomi` に変更する
- AC-2: タイトルは `backgroundColor="blue"` + `bold` + 左右に全角スペース1つ分相当の余白を付けたバッジ状で表示する
- AC-3: 既存の `— N projects · M devices` 表示・watching インジケータとの同一行・右側連結のレイアウトは崩さない
- AC-4: 回帰テスト: ヘッダー行に `Monomi` が含まれ、`Claude Code Status` が含まれないことを確認する

### FR-02: watching インジケータの点滅化（優先度: 必須）

- 場所: `src/cli/components/app-view.tsx`、新規コンポーネント（例: `src/cli/components/watching-indicator.tsx`）
- AC-1: `polling.isRunning() === true` の間、watching 表示が 1000ms 間隔で表示/非表示を繰り返す（当初 500ms で実装したが、実機確認でのユーザーフィードバック「点滅が早い」により倍の間隔へ変更）
- AC-2: 点滅ロジック（`setInterval` によるローカル state トグル）は専用の小コンポーネントに分離し、そのコンポーネント内の再レンダーが `AppView` 本体（`filteredRows` 計算・カードグリッド等）の再レンダーを誘発しないこと
- AC-3: `polling.isRunning() === false` になったらインジケータごと非表示に戻り、`setInterval` もクリーンアップする（アンマウント時・props 変化時のリーク防止）
- AC-4: 回帰テスト: `isRunning()` の true/false 切り替わりでの表示、アンマウント時の `setInterval` クリア（`jest.useFakeTimers` 等）を確認する

### FR-03: watching 文言の i18n キー化・大文字化（優先度: 必須）

- 場所: `src/i18n/en.ts`・`src/i18n/ja.ts`（新規キー追加）、FR-02 の点滅コンポーネント
- 背景: `● watching` はハードコードされた英字リテラルで、release-9-i18n の移行対象（`app-view.tsx` 含む）から漏れていた
- AC-1: ハードコードされた `watching` 文言を新規 i18n キー（例: `app.watching`）へ切り出す
- AC-2: `en.ts`・`ja.ts` の両方に値 `WATCHING` を登録する（ステータス表示用の技術的な語のため両ロケールで同一表記とする）
- AC-3: `satisfies` によるキー網羅性チェックが通る
- AC-4: 表示は `● WATCHING` として点滅する
- 備考: 既存の `app-view.test.tsx`（`toContain('watching')` で小文字を検証している箇所）は本 FR による表示変更に伴い更新が必要

### FR-04: 選択中カードの強調を `borderStyle="double"` に変更（優先度: 必須）

- 場所: `src/cli/components/instance-card.tsx`
- AC-1: `selected === true` のカードは `borderStyle="double"` かつ `borderColor="cyan"` で描画する（当初 `borderStyle="bold"` で実装したが、実機確認でのユーザーフィードバックにより、フォント依存で通常線との差が分かりにくい太線罫線から二重線罫線へ変更）
- AC-2: `selected === false` のカードは既存どおり `borderStyle="round"`・`borderColor` 指定なしで描画する
- AC-3: double 罫線への変更でカード内コンテンツの幅・行数が崩れず、既存のカードグリッド列数計算（`columnsForWidth`）に影響しない
- AC-4: 回帰テスト: `selected` 時の `borderStyle`/`borderColor` を確認する

### FR-05: フィルタとカードグリッドの視覚的連動強化（優先度: 必須）

- 場所: `src/cli/components/status-filter-bar.tsx`
- 壁打ちでの補足: 当初案にあった「表示中 N 件 / 全 M 件」の一致件数ヒントは、既存の `StatusFilterBar` が状態別件数（`countByDisplay` 由来の `[1]稼働中 2 …`）を常時表示済みで情報が重複すること、また分母 M に `closed`（release-8 で既定非表示）を含めるかが表示スタイルではなく挙動の決定に踏み込むことから、今回は見送る。U4 の core の不満（連動が視覚的に弱い）は AC-1 のバッジ強調で解決する
- AC-1: 有効なフィルタのバッジは、既存の `inverse` 反転表示に代えて `backgroundColor` による強調を行う（フィルタ未選択時は現状どおり無強調）
- AC-2: 回帰テスト: フィルタ ON/OFF 切り替え時のバッジ強調表示/非表示を確認する

### FR-06: ヘルプ文言の簡素化（優先度: 必須）

- 場所: `src/i18n/ja.ts`・`src/i18n/en.ts`（`help.openDetail`）
- AC-1: `ja.ts` の `help.openDetail` を `一覧: 詳細（Agent View Lv.1）を開く` から `一覧: プロジェクト詳細を開く` に変更する（内部開発用語「Agent View Lv.1」をエンドユーザー向け文言から除去）
- AC-2: `en.ts` の `help.openDetail` を `List: open detail (Agent View Lv.1)` から `List: open project detail` に変更する
- AC-3: 他の `help.*` 文言との文体（半角コロン + スペース区切り）の一貫性を保つ
- AC-4: 回帰テスト: `HelpOverlay` の表示文言を新文言で確認する

## 非機能要件

- 本リリースは P4（`AppView` の無条件再レンダー・集計重複計算）の本格修正を含まない。FR-02 の点滅コンポーネント分離は、点滅処理自体が P4 の問題を新規に悪化させないための局所対応に限る
- 依存関係の追加は行わない（Ink の既存機能の範囲で実装する）

## スコープ外（release-10 では実装しない）

- U4「非該当カードの完全グレーアウト」（`filtered()` を全件表示＋淡色化方式へ変更する設計）は、選択カーソル移動ロジックおよび release-8 で確定した「closed は既定非表示」との再設計を要する大きめの変更のため見送る。今回は視覚的連動の強化（FR-05）に留める
- P4（`AppView` の無条件再レンダー・集計重複計算）の本格修正
- A4（`InstanceTable` の改名・レイアウト計算の再配置）
- U5（状態変化時の OS 通知）、U6（`Workflow`/`Agent` ツール呼び出しの可視化）、U7（PR poller）

## 未解決事項

- FR-05 の具体的な配色（バッジの背景色）・件数ヒントの正確な文言・表示位置は、実装時に微調整の余地がある
- FR-02 のコンポーネント分離が実際に `AppView` 全体の再レンダーを誘発しないことは、実装時にテスト（再レンダー回数の計測等）で検証する

## 次のステップ

要件確定後、以下で実装フェーズへ進む:

```
Workflow({name: "implement-feature", args: {release: "release-10-dashboard-polish"}})
```
