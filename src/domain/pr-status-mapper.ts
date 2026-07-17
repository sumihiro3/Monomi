/**
 * `gh` CLI が返す GitHub PR 情報を {@link PrStatus.state}（`src/domain/entities.ts`）に
 * 対応する値 + `isDraft` フラグへ写す純粋関数（release-27 FR-02）。
 *
 * DB アクセス・`gh` 呼び出し（`execFile`）を一切持たない薄い変換に留め、poller 本体
 * （FR-01a）から「呼び出し・整形」の責務を分離する（`ProjectKeyNormalizer` や
 * `toRunningWorkDto` と同じ「純粋関数を domain 層に置く」方針を踏襲）。
 */

/** `gh` CLI の `state`（`gh pr list --json state` 由来）。 */
export type GhPrState = 'OPEN' | 'CLOSED' | 'MERGED'

/**
 * `gh` CLI の `reviewDecision`（`gh pr list --json reviewDecision` 由来）。
 * レビューが一度も要求されていない PR は `null`。
 */
export type GhReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null

/** {@link mapPrToStatus} の入力。対象ブランチにオープン/クローズ済みいずれかの PR が存在する場合の生情報。 */
export interface GhPrInfo {
  state: GhPrState
  reviewDecision: GhReviewDecision
  isDraft: boolean
}

/** `pr_status.state` が取りうる値（§7.3）。 */
export type PrReviewState = 'none' | 'awaiting_review' | 'changes_requested' | 'approved' | 'merged'

/** {@link mapPrToStatus} の返り値。`pr_status` へ upsert する分だけを持つ薄い形。 */
export interface MappedPrStatus {
  state: PrReviewState
  isDraft: boolean
}

/**
 * `gh` CLI から取得した PR 情報を `pr_status` の `state`/`isDraft` へ写す。
 *
 * マッピング規則（壁打ち確定。`docs/releases/release-27-github-pr-poller/requirements.md` FR-02）:
 * - PR が無い（`pr === null`）、または `CLOSED`（未マージ） → `'none'`
 * - `OPEN` ∧ (`reviewDecision` が `null` または `'REVIEW_REQUIRED'`) → `'awaiting_review'`
 *   （`isDraft` はそのまま反映する）
 * - `OPEN` ∧ `reviewDecision === 'CHANGES_REQUESTED'` → `'changes_requested'`
 * - `OPEN` ∧ `reviewDecision === 'APPROVED'` → `'approved'`
 * - `'MERGED'` → `'merged'`
 *
 * @param pr 対象ブランチの PR 情報。対象ブランチに PR 自体が存在しない場合は `null`。
 * @returns `pr_status` へ書き込む `state`/`isDraft` の組。
 */
export function mapPrToStatus(pr: GhPrInfo | null): MappedPrStatus {
  if (pr === null) {
    return { state: 'none', isDraft: false }
  }

  if (pr.state === 'CLOSED') {
    return { state: 'none', isDraft: pr.isDraft }
  }

  if (pr.state === 'MERGED') {
    return { state: 'merged', isDraft: pr.isDraft }
  }

  // ここに来る時点で pr.state === 'OPEN'。
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return { state: 'changes_requested', isDraft: pr.isDraft }
  }

  if (pr.reviewDecision === 'APPROVED') {
    return { state: 'approved', isDraft: pr.isDraft }
  }

  // reviewDecision が null または 'REVIEW_REQUIRED'。
  return { state: 'awaiting_review', isDraft: pr.isDraft }
}
