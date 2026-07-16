# release-24-dashboard-display-polish 要件定義

- リリース識別子: `release-24-dashboard-display-polish`
- ステータス: 確定
- 作成日: 2026-07-16
- 対応する設計・参照資料: `docs/known-issues.md` **U16** / **U18** / **B12**（ダッシュボード表示改善セット・小粒バンドル）

## 背景と目的

ユーザーから寄せられた表示系の要望2件（U16: どのターミナルアプリで動いているか一覧・詳細で分かるようにしたい／U18: instance の path をカードに表示したい）と、release-23-terminal-focus の実機検証中に見つかったフォーカス機能の副作用バグ1件（B12: `f` キーの総当たりが未起動の Terminal.app を誤って自動起動する）を、いずれも小粒な変更としてまとめて1リリースで解決する。

U16・U18 は表示専用の変更で、`InstanceStatusRow` に既に届いているデータ（`session.terminal.term_program`／`wsl_distro`、`path`）を使うだけで、hub 側のスキーマ変更は不要。B12 は release-23 で導入した darwin strategy 総当たりの安全性の穴を塞ぐバグ修正。3件とも `src/cli/` 配下の変更のみで完結する。

## スコープの確定（壁打ちでの決定事項）

| 論点                         | 決定                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U16 の表示場所               | 詳細ビュー＋一覧カードの両方。詳細ビューは独立した `terminal` フィールド行、カードは行数を増やさず既存の `device` 行へ括弧付きで略記する（例: `device-name (tmux)`）                                           |
| U16: tmux セッション内の表示 | 「tmux」とだけ表示する。外側クライアントの動的解決（`tmux list-clients` 等）は行わない（正直な最小実装。動的解決はコストが見合わず今回は対象外）                                                               |
| U16: WSL2 の表示             | `wsl_distro`（例 `Ubuntu`）を含める。`term_program` が空で `wsl_distro` が非 null のときに採用する                                                                                                             |
| U18: 中間省略の配分          | 末尾優先。末尾にはリポジトリ名・worktree 名など識別性の高い情報が来ることが多いため、先頭は短い固定長、末尾を多めに残す                                                                                        |
| U18: ホームディレクトリ短縮  | 適用する。`/Users/<name>/...` `/home/<name>/...` を `~/...` に置換してから幅判定・中間省略を行う（hub は複数デバイスを集約するため `process.env.HOME` は使えず、受信した path 文字列自体を正規表現で判定する） |
| U18: カード行数増加          | 1行追加で対応する（既存5行→6行）。`card-grid.ts` の列数計算は幅基準のみで高さに依存しないため変更不要                                                                                                          |
| B12 の対応範囲               | Terminal.app への起動確認ガード追加に加えて、副次的に見つかっていた Ghostty のタグ書き込み順序（プロセス存在確認より先に TTY へ書き込んでしまう問題）も同時に修正する                                          |
| 優先度                       | U16・U18・B12 の全 FR を「必須」として一括完了させる                                                                                                                                                           |

## 機能要件

### FR-01: ターミナルアプリ表示名マッピングヘルパー（優先度: 必須、対応する既存課題ID: U16）

- 場所: `src/cli/terminal-display.ts`（新規）、`src/cli/terminal-display.test.ts`（新規）
- AC-1: `term_program` の既知値を表示名へマッピングする純粋関数 `terminalDisplayName(termProgram: string | null, wslDistro: string | null): string | null` を実装する。マッピング表: `Apple_Terminal` → `Terminal.app`、`ghostty` → `Ghostty`、`iTerm.app` → `iTerm2`、`vscode` → `VS Code`
- AC-2: `termProgram === 'tmux'` のときは `"tmux"` を返す（tmux 内では reporter が捕捉する `$TERM_PROGRAM` 自体が `tmux` になるため、この分岐だけで判定できる。外側クライアントの動的解決はしない）
- AC-3: `termProgram` が上記マッピング表・`tmux` のいずれにも一致しない非 null 値の場合は、その値をそのまま返す（未知値フォールバック）
- AC-4: `termProgram` が null/空文字列で `wslDistro` が非 null の場合は `wslDistro` の値をそのまま返す
- AC-5: `termProgram`・`wslDistro` がともに null/空文字列の場合は `null` を返す（呼び出し側で `-` 等へフォールバックさせる。他の nullable フィールドと同じ流儀）
- AC-6: 戻り値はレポーター由来の自由記述文字列をそのまま返しうる（AC-3/AC-4 の未知値・distro 名）ため、呼び出し側での `sanitizeDisplayText` 適用を前提とする（本関数自体はサニタイズしない。マッピング・フォールバックのみに専念する）

### FR-02: 詳細ビューへのターミナル表示追加（優先度: 必須、対応する既存課題ID: U16）

- 場所: `src/cli/components/detail-view.tsx`、`src/cli/components/detail-view.test.tsx`、`src/i18n/en.ts`、`src/i18n/ja.ts`
- AC-1: 既存の `Field label="path"` の直後に `Field label={t('detail.terminal')}` を追加し、FR-01 の `terminalDisplayName(source.session.terminal?.term_program ?? null, source.session.terminal?.wsl_distro ?? null)` の結果を表示する
- AC-2: 表示前に `sanitizeNullableDisplayText` を適用し、結果が `null` の場合は他の nullable フィールド（`branch` 等）と同じ `-` 表示にする
- AC-3: `detail.terminal` の翻訳キーを `en.ts`（authoritative）・`ja.ts` の両方に追加する（`ja.ts` の `satisfies Record<TranslationKey, string>` によるキー網羅性チェックを通す）
- AC-4: 実機確認（手動検証必須） — Ghostty・Terminal.app・tmux アタッチ中のセッションのそれぞれで、詳細ビューに正しいアプリ名／「tmux」が表示されることを目視確認する

### FR-03: 一覧カードへのターミナル表示追加（優先度: 必須、対応する既存課題ID: U16）

- 場所: `src/cli/components/instance-card.tsx`、`src/cli/components/instance-card.test.tsx`
- AC-1: 既存の `device` 行に、FR-01 の結果が非 null のときのみ ` (<terminal>)` を括弧付きで追記する（例: `my-device (tmux)`）。カードの行数は増やさない
- AC-2: 追記するターミナル名は `sanitizeDisplayText` で除染してから表示する（`device.name` と同じ流儀。CWE-150 対策）
- AC-3: FR-01 の結果が `null` の場合、`device` 行は従来通り device 名のみを表示する（末尾に空括弧等を付けない）
- AC-4: 行全体は既存の `wrap="truncate-end"` に従う（device 名が長い場合、末尾の `(<terminal>)` ごと切り詰められることを許容する。カード表示は略記であり詳細ビューで完全な情報を確認できるため、このトレードオフは許容する）
- AC-5: 実機確認（手動検証必須） — 実際のダッシュボードでカード内の `device (<terminal>)` 表示が崩れないことを確認する

### FR-04: パス中間省略ヘルパー（優先度: 必須、対応する既存課題ID: U18）

- 場所: `src/cli/truncate-path.ts`（新規）、`src/cli/truncate-path.test.ts`（新規）
- AC-1: 表示幅ベースで `先頭…末尾` 形式に切り詰める純粋関数 `truncateMiddle(path: string, maxWidth: number): string` を実装する。表示幅の計算は `box-border.ts` の `displayWidth`（East Asian Wide/Fullwidth を2桁として数える）をそのまま再利用し、全角文字を含む path でも表示桁がずれないようにする
- AC-2: `displayWidth(path) <= maxWidth` の場合はそのまま返す（省略しない）
- AC-3: 省略が必要な場合、末尾優先の配分で `先頭N文字 + '…' + 末尾M文字` を組み立てる（`…` の表示幅1桁を含めて合計が `maxWidth` を超えない範囲で、末尾に配分の多くを割り当てる。具体的な配分比率・固定長は実装時に決定してよい）
- AC-4: `maxWidth` が極端に小さく `先頭+…+末尾` が成立しない場合は、`box-border.ts` の `truncateToWidth` 相当の末尾省略ロジックにフォールバックし、例外を投げない
- AC-5: ホームディレクトリ短縮を行う別関数 `collapseHomeDir(path: string): string` を実装し、`/Users/<name>/...` または `/home/<name>/...` にマッチする場合は `~/...` へ置換する（`<name>` は `/` を含まない1セグメント）。マッチしない場合は入力をそのまま返す
- AC-6: 呼び出し側（FR-05）は `truncateMiddle(collapseHomeDir(path), maxWidth)` の順で適用する

### FR-05: 一覧カードへの path 表示追加（優先度: 必須、対応する既存課題ID: U18）

- 場所: `src/cli/components/instance-card.tsx`、`src/cli/components/instance-card.test.tsx`
- AC-1: カードに新規の `path` 行を1行追加する（既存5行から6行になる。挿入位置は `branch` 行の直後・`status` 行の直前とする）
- AC-2: `path` はカードの `width` prop から妥当な余白（既存行の `paddingX={1}` 分）を差し引いた許容幅で FR-04 の `truncateMiddle(collapseHomeDir(...), ...)` により中間省略して表示する。`width` が未指定（非TTY等の1列フォールバック）の場合は `FALLBACK_BOX_WIDTH`（`box-border.ts`）相当の妥当なデフォルト幅を用いる
- AC-3: 表示前に `sanitizeDisplayText` で除染する（`project.name`・`device.name`・`branch` と同じ流儀、CWE-150 対策。除染 → 中間省略の順序は既存の `truncateToWidth`／`displayWidth` の使われ方と揃え、除染後の文字列に対して幅計算・省略を行う）
- AC-4: `card-grid.ts` の列数計算（`columnsForWidth`）は幅のみに依存し高さを見ないため変更不要であることをテストで確認する（既存テストの回帰がないことの確認で足りる。新規テスト追加は不要）

### FR-06: B12 の解消 — Terminal.app 誤起動の防止（優先度: 必須、対応する既存課題ID: B12）

- 場所: `src/cli/focus/terminal-app-strategy.ts`、`src/cli/focus/terminal-app-strategy.test.ts`、`src/cli/focus/ghostty-strategy.ts`、`src/cli/focus/ghostty-strategy.test.ts`
- AC-1: `buildTerminalAppFocusScript` が生成する AppleScript の先頭に、System Events で `exists process "Terminal"` を確認するガードを追加する。未起動なら `tell application "Terminal"` ブロックへ入らずに `"false"`（→ `TerminalAppStrategy.focus` は `not_found`）を返す
- AC-2: Terminal.app が起動済みの場合の既存の成功フロー（`tty` 一致タブの検索 → ウィンドウ前面化 → タブ選択 → `activate`）は変更しない
- AC-3: `GhosttyStrategy` について、TTY への OSC タイトルタグ書き込み（`writeTtyTitle`）の前に Ghostty プロセスの存在確認を行うよう順序を変更する。プロセスが存在しない場合は `writeTtyTitle` を呼ばずに `not_found` を返す（タグ書き込みによる、対象外ターミナル（iTerm2/Warp 等）のタブタイトルの一瞬の変化という副作用を防ぐ）
- AC-4: プロセスが存在する場合の既存フロー（タグ書き込み → System Events でのメニュー検索・クリック → 1回リトライ → `finally` でのタグ消去）は維持する。プロセス存在確認自体が失敗（`osascript` 実行エラー等）した場合は `error` を返す
- AC-5: 単体テストで、(a) Terminal.app 未起動を模したモックで `buildTerminalAppFocusScript` 実行結果が `not_found` になること、(b) Ghostty 未起動を模したモックで `writeTtyTitle` が一度も呼ばれず `not_found` になることをそれぞれ検証する
- AC-6: 実機確認（手動検証必須） — Terminal.app を終了させた状態で、Terminal.app 以外のターミナル（例: Ghostty のみ稼働）のセッションに対して `f` キーを押し、Terminal.app が自動起動しないことを目視確認する

### FR-07: 既知課題 U16・U18・B12 を解決済みログへ移動（優先度: 必須）

- 場所: `docs/known-issues.md`
- AC-1: バックログの `U16`・`U18`・`B12` の3エントリを削除し、「解決済みログ」の表へ、本リリース番号と対応 FR 概要を付記した行として追加する（既存の解決済みエントリと同じフォーマット: `| ID | 内容 | 解決リリース |`）

## 非機能要件

- **互換性**: `session.terminal` が `null`（旧 reporter・情報未捕捉）のセッションでは、FR-01〜FR-03 はすべて `-`（詳細ビュー）／device 名のみ（カード）にフォールバックし、エラーや空欄崩れを起こさない
- **セキュリティ**: FR-01 の戻り値（未知の `term_program`・`wsl_distro` はレポーター由来の自由記述）は表示前に必ず `sanitizeDisplayText`／`sanitizeNullableDisplayText` を経由する（CWE-150、既存の `device.name`・`branch` と同じ脅威モデル）

## スコープ外

- U16: tmux 内での外側ターミナルクライアント名の動的解決（`tmux list-clients` 等による特定）
- U17（WSL2 の WezTerm 対応）は本リリースの対象外。既知課題として温存する
- iTerm2・VS Code 等、未対応ターミナルアプリの `term_program` マッピング追加（未知値フォールバックでそのまま表示されるのみ）
- `card-grid.ts` の列数計算ロジック自体の変更（高さは対象にしない設計を維持）

## 未解決事項

- FR-03（カードの `device (<terminal>)` 表示）のスペース区切り・括弧書式は実装後の見た目次第で微調整の余地がある（機能に影響しないレビュー時の微修正として扱う）
- FR-04 の中間省略の具体的な先頭/末尾の桁数配分は実装時に決定する（末尾優先という方針のみ確定）

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-24-dashboard-display-polish", config: <.claude/workflow.config.json の内容>}})
```
