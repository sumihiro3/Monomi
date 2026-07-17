# release-27-github-pr-poller 要件定義書

- リリース識別子: release-27-github-pr-poller
- ステータス: 確定
- 作成日: 2026-07-17
- 参照資料: `docs/ARCHITECTURE.md`（§5 status導出、§7.3 DBスキーマ、§8.2 wire DTO）、`docs/known-issues.md` U7

## 背景と目的

Monomi は「稼働中／権限待ち／次の指示待ち／**PRレビュー待ち**／放置」を横断確認できることを謳っているが、
PR レビュー待ち（`PR_WAIT`）は release-1 の時点で GitHub poller がスコープ外（v1延期）とされて以来、
一度も実装されていない（既知課題 U7）。`pr_status` テーブル・`PrStatusRepository.upsert()`・
`status.prWait` の i18n ラベル・`EscalationPolicy` の `PR_WAIT` 分岐はいずれも用意済みだが、
実際にテーブルへ行を書き込む GitHub poller が無いため `pr: none` のまま変化しない。

さらに調査の結果、`src/hub/instance-status-service.ts` の `HAS_PR_WAITING`（常時 `false` 固定の
モジュール定数）が、同ファイル内で計算される instance ごとの実際の PR 状態（`pr` 変数）と配線が
繋がっていないことが判明した。`pr` 変数は wire DTO の `pr.state` フィールド（表示専用）にしか
使われておらず、status 導出（`hasPrWaiting` 引数）には一切反映されない。したがって、
poller を実装して `pr_status` に実データが入っても、**この配線バグを直さない限り `PR_WAIT` 表示には
反映されない**。本リリースは (a) GitHub poller の新設 と (b) この配線バグの修正 の両方を扱う。

## スコープの確定（壁打ちでの決定事項）

| 論点                        | 決定                                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub API 認証             | `gh` CLI の既存ログイン（`gh auth login` 済み前提）を使う。config.yml に token は持たせない                                                                                                                                                    |
| ポーリング間隔              | 既定 5 分。config.yml `github_pr_poll.interval` で上書き可能                                                                                                                                                                                   |
| `PR_WAIT` 判定基準          | レビュー未着手（GitHub の `reviewDecision` が無い、または `REVIEW_REQUIRED`）のときのみ `PR_WAIT`。`changes_requested`（差し戻し済み＝ボールは開発者側）・`approved`（あとはマージするだけ＝同じく開発者側）・`merged` は `PR_WAIT` に含めない |
| Draft PR の扱い             | `PR_WAIT` に含める（レビュー依頼はまだだが追跡対象にはする）。ただし `is_draft` フラグで区別表示する                                                                                                                                           |
| PR へのリンク表示           | OSC 8 ハイパーリンクエスケープで PR 番号をクリッカブルにする（対応端末でブラウザが開く）                                                                                                                                                       |
| 対象ホスト                  | `github.com` のみ（GitLab・Bitbucket 等は対象外）                                                                                                                                                                                              |
| `gh` 未導入・未認証時の挙動 | poller を無効化し、hub 起動時に 1 回だけ警告ログを出す。hub 本体はクラッシュさせず、`pr` は現状どおり `none` に縮退する（後方互換）                                                                                                            |

## 機能要件

### FR-01: GitHub PR ポーラーの新設（優先度: 必須）

- 場所: `src/hub/github-pr-poller.ts`（新規）、`src/hub/serve.ts`
- 既知課題 U7 対応。`InstanceRepository.listActive()` から `(project_id, branch)` のユニーク組を洗い出し、
  `project.projectKey.kind === 'GIT_REMOTE'` かつ `projectKey.value` の host が `github.com` かつ
  `branch !== null` の組だけを対象にする。各組について `gh` CLI を `execFile`（非 shell、既存の
  `osascript.ts`/`tmux-strategy.ts` と同じ注入可能な `ExecFileFn` パターンを踏襲）で呼び出し、
  対象ブランチの PR 有無・番号・URL・state（open/closed/merged）・reviewDecision・isDraft を取得する。
  取得結果を FR-02 のマッピングで `pr_status` の形へ変換し `PrStatusRepository.upsert()` へ書き込む。
  serve.ts 側で config（FR-01 AC-5）を読み `server.listen()` 後にポーリングを開始し、
  `HubHandle.close()` でタイマーを確実に停止する。

- AC-1: 同一 `(project_id, branch)` が複数 instance に存在しても、1 ポーリングサイクルにつき `gh` 呼び出しは
  1 回に重複排除されること。
- AC-2: `gh pr list --state all`（open/closed/merged 全件取得。既定の open のみを返す呼び出しは
  本 AC を満たさない）の結果、対象ブランチにクローズ済み（未マージ）の PR しかない場合、または
  PR 自体が存在しない場合は `state: 'none'` として upsert され、以前 `PR_WAIT` だった instance が
  正しく解除されることを確認する。マージ済み PR がある場合は FR-02 のとおり `state: 'merged'`
  として upsert され、`'none'` とは区別されることも合わせて確認する（review-changes 修正:
  本 AC が旧文言で「マージ済み」も `'none'` 側に含めており FR-02 の `MERGED → 'merged'` と矛盾して
  いたための訂正。「最新 PR の履歴状態を表示する」方針を確定とする）。
- AC-3: 個別ブランチの `gh` 呼び出しが失敗（該当リポジトリ未検出・レート制限・ネットワークエラー等）しても、
  他のブランチのポーリングや hub 本体の動作に影響しないこと（エラーはログに残し、当該 `pr_status` 行は
  前回値を保持する）。
- AC-4: `gh` バイナリが `PATH` 上に無い、または `gh auth status` が失敗する場合、hub 起動時に 1 回だけ
  警告ログを出しポーリング自体を無効化すること（既存ダッシュボード動作に影響を与えない）。
  稼働開始後にトークン失効・権限剥奪等で認証が切れた場合も同じ縮退契約に従うこと（review-changes
  修正: 起動時判定のみだと稼働中の認証失効後、更新不能になった `awaiting_review` が
  `PR_WAIT` 表示のまま無期限に残り続ける medium severity 所見への対応）。具体的には、1 サイクル内の
  対象 branch が（1 件以上存在する前提で）全件失敗した場合にのみ `gh auth status` を再確認し、
  失敗すれば起動時と同じ「無効化 + 1 回警告 + ポーリング停止」に倒す。個別 branch の孤立した障害
  （該当リポジトリ未検出・レート制限等）は引き続き AC-3 の「前回値保持」のみで、無効化対象にしない。
- AC-5: ポーリング間隔は config.yml の `github_pr_poll.interval`（既定 `"5m"`）で上書き可能。
  `github_pr_poll.enabled: false` でポーリング自体を無効化できること。
- AC-6: `HubHandle.close()` 呼び出し時にポーリングタイマーが確実に停止し、プロセス終了をブロックしないこと。

### FR-02: PR レビュー状態の変換ロジック（優先度: 必須）

- 場所: `src/hub/github-pr-poller.ts` または新規 `src/domain/pr-status-mapper.ts`
- `gh` から得た PR 情報（`state`: OPEN/CLOSED/MERGED、`reviewDecision`:
  APPROVED/CHANGES_REQUESTED/REVIEW_REQUIRED/null、`isDraft`）を既存 `PrStatus.state` union
  （`'none' | 'awaiting_review' | 'changes_requested' | 'approved' | 'merged'`）+ 新規 `isDraft`
  フィールドへ写像する、壁打ちで確定したマッピング規則:
  - PR が無い、または CLOSED（未マージ） → `state: 'none'`
  - OPEN かつ `reviewDecision` が `null` または `'REVIEW_REQUIRED'` → `state: 'awaiting_review'`
    （`isDraft` はそのまま `is_draft` に反映する）
  - OPEN かつ `reviewDecision === 'CHANGES_REQUESTED'` → `state: 'changes_requested'`
  - OPEN かつ `reviewDecision === 'APPROVED'` → `state: 'approved'`
  - MERGED → `state: 'merged'`

- AC-1: 上記 5 パターンそれぞれの単体テストがあること。
- AC-2: Draft PR は `is_draft: true` かつ `state: 'awaiting_review'` として扱われること（壁打ち決定）。

### FR-03: `pr_status` スキーマ拡張（優先度: 必須）

- 場所: `src/db/ddl.ts`、`src/db/migrations.ts`、`src/domain/entities.ts`（`PrStatus`）、
  `src/db/repositories/pr-status-repository.ts`
- `pr_status` テーブルへ `is_draft` 列（`INTEGER NOT NULL DEFAULT 0`）を追加する。新規 DB は DDL で
  作成し、既存 DB は §7.3 の冪等マイグレーション方針（release-23 `applyMigrations` と同型）で追随する。
  `PrStatus`/`NewPrStatus`/`PrStatusRow`/`upsert()` に `isDraft: boolean` を反映する。

- AC-1: 新規 DB で `pr_status` に `is_draft` 列が作成されること。
- AC-2: 既存 DB（`is_draft` 列なし）起動時に `applyMigrations` で `ALTER TABLE` が冪等に適用されること
  （複数回実行しても安全）。
- AC-3: `upsert()` が `isDraft` を永続化し、`findByProjectBranch()` で読み戻せること。

### FR-04: `hasPrWaiting` の実データ配線（既知課題 U7 本体の配線バグ修正、優先度: 必須）

- 場所: `src/hub/instance-status-service.ts`
- 現状 `buildRow()` は `HAS_PR_WAITING`（常時 `false` 固定のモジュール定数）を各セッションの status 導出
  （`deriveForSession`）に渡しており、同メソッド後段で計算される実際の `pr`（`instance.branch` 別の
  PR 状態）は wire の `pr` フィールド表示にしか使われず、`hasPrWaiting` の判定には一切反映されない。
  この配線を修正し、`prStatus.findByProjectBranch()` の結果を `entries` 構築（`deriveForSession` 呼び出し）
  より前に計算し、`hasPrWaiting = pr !== null && pr.state === 'awaiting_review'` を各セッションの
  status 導出へ渡すようにする。`HAS_PR_WAITING` 定数は役目を終えるため削除する。

- AC-1: `pr_status.state === 'awaiting_review'`（draft 含む）の instance は、他の条件（次の指示待ち相当の
  `raw_state`）を満たせば表示が `PR_WAIT` になることを回帰テストで確認する。
- AC-2: `pr_status.state` が `'changes_requested'`/`'approved'`/`'merged'`/`'none'` の場合は `PR_WAIT` に
  ならない（既存の `NEXT_WAIT` 等へフォールバックする）ことを回帰テストで確認する。
- AC-3: 既存の全テスト（release-1 以降、`hasPrWaiting=false` 前提で書かれたもの）が引き続き green である、
  または妥当な理由とともに更新されていること。

### FR-05: wire DTO・CLI 表示の拡張（PR 番号・URL・draft 表示・OSC 8 リンク、優先度: 必須）

- 場所: `src/hub/dto.ts`（`PrDto`）、`src/cli/components/detail-view.tsx`、
  新規 `src/cli/osc8-hyperlink.ts`（または同等モジュール）
- `PrDto` に `number: number | null`・`url: string | null`・`is_draft: boolean` を追加する
  （`toPrStatus` 的な明示的変換関数を用意し、他の wire 変換と同じ「ドメイン型→薄い変換→wire DTO」の
  パターンに揃える）。`detail-view.tsx` の `pr` Field 表示を、i18n 化した状態ラベル（`status.prWait` と
  同様のパターンで `pr.none`/`pr.awaitingReview`/`pr.changesRequested`/`pr.approved`/`pr.merged` 等を
  新設）+ draft 時は区別可能な接尾辞（例: `(draft)`）+ PR 番号を OSC 8 ハイパーリンクエスケープ
  （`\x1b]8;;<url>\x07<text>\x1b]8;;\x07`）でラップして表示する。PR URL は `https://github.com/` で
  始まることを検証してから OSC 8 シーケンスへ埋め込み、それ以外（想定外の形式）ではエスケープ生成を
  スキップしプレーンテキスト表示にフォールバックする（生成した文字列を無条件に埋め込まない）。

- AC-1: PR 番号・状態・draft 注記が `detail-view` に表示されることをテストで確認する。
- AC-2: OSC 8 シーケンス生成関数の単体テスト（正しいエスケープ列を組み立てる、`https://github.com/` で
  始まらない URL では素通ししないこと）。
- AC-3: 非 TTY・OSC 8 非対応端末でも表示が壊れない（可視文字列自体は保持され、エスケープ列が付加される
  だけであること）を確認する。
- AC-4: 受け入れ試験（手動検証必須） — 実機（OSC 8 対応端末、例 Ghostty/iTerm2）で PR 番号をクリックし、
  ブラウザで該当 PR が開くことを確認する。

## 非機能要件

- パフォーマンス: ポーリングは個人利用規模（数プロジェクト）を想定し、GitHub API レート制限
  （認証済み実行で標準 5000 req/h）に対し十分な余裕を残す間隔にする（既定 5 分の根拠）。
- セキュリティ: `gh` CLI 呼び出しは `execFile` 非 shell 実行とし、branch 名・owner/repo 文字列を
  コマンド引数として渡す際にシェル解釈を経由させない（既存 `tmux-strategy.ts` 等と同じ三段防御方針）。
- セキュリティ（review-changes 追記）: ポーリング対象 `(project_id, branch)` は reporter が申告する
  `project_key`/branch 由来であり、hub は自身の `gh` 認証情報でこれを問い合わせる。ペアリング済み
  device が任意の `github.com/owner/repo` を申告すれば、hub の権限で当該 repo の PR 有無・状態が
  問い合わせられてしまう confused-deputy 構造があるため、config.yml `github_pr_poll.allowed_repos`
  （`owner/repo` の allowlist、任意設定）でポーリング対象を運用者が明示的に制限できるようにする。
  未設定時は従来どおり全 reporter 申告 branch を対象にする（後方互換）。
- 後方互換性: `gh` CLI 未導入・未認証環境でも hub は従来通り動作し、`pr` 状態は常に `none`
  （現状と同じ動作）に縮退する。

## スコープ外

- GitHub 以外のリモートホスト（GitLab、Bitbucket 等）の PR ポーリング。
- Personal Access Token を config.yml に保持する認証方式（将来必要になれば別途壁打ち）。
- `pr_status` テーブルの古い行（対象 branch が使われなくなった後）の自動クリーンアップ。
- 一覧カード（`instance-card.tsx`）への PR 表示追加（本リリースは詳細ビューのみ。カードへの追加は
  将来検討）。
- Draft PR を `PrStatus.state` の独立した列挙値として追加する案（`is_draft` フラグ方式を採用）。

## 未解決事項

- `gh pr view`/`gh pr list` の具体的なコマンド・`--json` フィールド選定は実装時に確定する
  （例: `gh pr list --repo <owner>/<repo> --head <branch> --json number,state,reviewDecision,isDraft,url`）。
- 同一ブランチに複数のオープン PR が存在する稀なケース（fork からの重複 PR 等）の優先順位選択規則は
  実装時に決定する（例: 番号が最大＝最新のものを採用）。

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-27-github-pr-poller", config: <.claude/workflow.config.json の内容>}})
```
