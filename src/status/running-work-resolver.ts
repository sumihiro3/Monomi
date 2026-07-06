import type { Event } from '../domain/entities.js'

/**
 * 「実行中の作業名（running work）」の種別（release-16 FR-02）。
 *
 * `Task`/`Agent` の tool_name 表記揺れ（実イベントでの表記違い）は両方とも `'agent'` に
 * 集約する（requirements.md 未解決事項: 実装時に両表記をマッチ対象にする）。
 */
export type RunningWorkKind = 'workflow' | 'agent' | 'skill'

/**
 * セッションが「今実行中」と見なせる作業（release-16 FR-02）。
 *
 * `name` は reporter が `tool_summary` に載せた表示名（release-16 FR-01）をそのまま運ぶ。
 * CLI 表示前のサニタイズ（`sanitize-display-text`、CWE-150 対策）は呼び出し側（CLI レイヤー）
 * の責務であり、このモジュールは加工しない。
 */
export interface RunningWork {
  kind: RunningWorkKind
  name: string
}

/**
 * {@link scanForRunningWork} の 1 ページ分の走査結果。
 *
 * `run-boundary-scanner.ts` の `RunBoundaryScanResult`/`scanForRunBoundary`（received_at
 * 降順の 1 ページを走査し、ページングの継続/打ち切りを呼び出し側に委ねる構造）と対になる
 * 姉妹型だが、区切りイベントの集合が異なるため独立して定義する（raw_state 境界は
 * `APPROVAL_WAIT`（`Notification(permission_prompt)`）も区切るが、running work の消灯は
 * `Stop`/`Notification(idle_prompt)`/`SessionEnd`/`UserPromptSubmit` のみ。FR-02 導出規則）。
 */
export interface RunningWorkScanResult {
  /**
   * ページ内で区切りイベント（稼働区間の終端）に当たったか。true なら呼び出し側は
   * これより古いページを読む必要がない。
   */
  boundaryFound: boolean
  /**
   * このページ内で確定した Workflow。見つかった時点で（降順走査のため）最新なので
   * 即確定でよく、呼び出し側はページングを打ち切ってこれを採用できる（AC-1/AC-2:
   * それより古い Task/Skill イベントで上書きしない）。
   */
  workflow: RunningWork | null
  /**
   * Workflow が見つかっていない場合の Task/Agent/Skill 候補。ページ内・複数ページに渡り
   * 最初に見つかった（＝最新の）候補のみを保持し、以降の候補では上書きしない
   * （AC-3: 「最新の」Task/Agent/Skill を採用）。
   */
  fallback: RunningWork | null
}

/** `Workflow` ツールと見なす tool_name の集合。 */
const WORKFLOW_TOOL_NAMES = new Set(['Workflow'])

/** `Task`/`Agent`（サブエージェント起動）ツールと見なす tool_name の集合。 */
const AGENT_TOOL_NAMES = new Set(['Task', 'Agent'])

/** `Skill` ツールと見なす tool_name の集合。 */
const SKILL_TOOL_NAMES = new Set(['Skill'])

/**
 * イベントが running work の「区切り」（稼働区間の終端）かどうかを判定する（FR-02 導出規則）。
 *
 * `permission_prompt`（raw_state の `APPROVAL_WAIT`）は区切りに含めない（requirements.md
 * line20 が明示する消灯条件は Stop/idle_prompt/SessionEnd/UserPromptSubmit のみ）。承認待ち中に
 * running work が実際には消灯するのは、この関数が区切りを見つけないまま稼働区間の走査を続け
 * つつも、呼び出し側の「代表 session が ACTIVE のときだけ導出する」ゲート（FR-02 line53:
 * 非 ACTIVE は即 null）が先に働くため。要件間の見かけ上の矛盾（line20 と line53）は
 * line53 優先で確定済み（release-16 要件の確定判断）。
 *
 * @param event 判定対象イベント。
 * @returns 区切りイベントなら true。
 */
function isRunningWorkBoundaryEvent(event: Event): boolean {
  switch (event.eventType) {
    case 'Stop':
    case 'SessionEnd':
    case 'UserPromptSubmit':
      return true
    case 'Notification':
      return event.eventSubtype === 'idle_prompt'
    default:
      return false
  }
}

/**
 * 1 イベントを running work 候補へ写す。対象外のイベント、および空文字・null の
 * `tool_summary` を持つ該当イベントは null（AC-6、旧 reporter からのイベントとの互換）。
 *
 * `PreToolUse` 以外（`PostToolUse` を含む）は候補にしない。Workflow/Agent はバックグラウンド
 * 実行のため `PostToolUse` が即時発火し、これを候補にすると実態より早く消灯してしまう
 * （requirements.md スコープ確定事項: Pre/Post の厳密ペア追跡は不採用）。
 *
 * @param event 判定対象イベント。
 * @returns 対応する {@link RunningWork}。対象外なら null。
 */
function runningWorkCandidateOf(event: Event): RunningWork | null {
  if (event.eventType !== 'PreToolUse') return null
  if (event.toolName === null) return null
  if (!event.toolSummary) return null // 空文字・null を同時に除外（AC-6 / 非機能: 旧 reporter 互換）

  if (WORKFLOW_TOOL_NAMES.has(event.toolName)) {
    return { kind: 'workflow', name: event.toolSummary }
  }
  if (AGENT_TOOL_NAMES.has(event.toolName)) {
    return { kind: 'agent', name: event.toolSummary }
  }
  if (SKILL_TOOL_NAMES.has(event.toolName)) {
    return { kind: 'skill', name: event.toolSummary }
  }
  return null
}

/**
 * hub 権威時刻（received_at）降順の 1 ページ分のイベントを走査し、「実行中の作業名」を
 * 選定するドメインサービス（FR-02 導出規則）。`run-boundary-scanner.ts` の
 * `scanForRunBoundary` と同じ「1 ページ走査・ページングの継続判断は呼び出し側」という
 * 構造を持つ姉妹関数だが、区切り集合が異なるため既存関数は流用せずこちらを新規に用意する。
 *
 * hub 側（`InstanceStatusService`。本関数の呼び出し元）はページを取得するたびにこの関数を
 * 呼び、`workflow` が確定した時点、または `boundaryFound` が true になった時点でページングを
 * 打ち切る。降順走査のため最初に見つかった Workflow は必ず最新であり（AC-1/AC-2:
 * 後続の Task/Skill で上書きしない）、それ以上古いページを読む必要はない。Workflow が
 * 見つからないまま区切りに当たった場合は、それまでに集めた `fallback`（最新の
 * Task/Agent/Skill 候補）を running work として採用する（AC-3）。区切りにも Workflow にも
 * 当たらずページが尽きた場合は `fallback` を持ち越して次のページの走査に進む。
 *
 * 呼び出し側は「代表 session の `StatusResult.rawState === 'ACTIVE'`」のときだけこの関数を
 * 駆動する想定（ACTIVE ゲート、AC-4/AC-5 相当）。非 ACTIVE（`APPROVAL_WAIT`/`NEXT_WAIT`/
 * `CLOSED`）は呼び出し側が既に算出済みの `StatusResult` を見て即 null とし、本関数を呼ばない
 * （追加のイベント読み取りを発生させないため、既知課題 P3 の悪化を避ける）。この関数自身は
 * ページング（DB 読み取り）を持たない純関数であり、駆動は呼び出し側（hub レイヤー）の責務。
 *
 * @param page hub 権威時刻（received_at）降順の 1 ページ分のイベント
 *   （`EventRepository.recentPageForSession` 相当の出力）。
 * @param carriedFallback 直前までのページで見つけている Task/Agent/Skill 候補。まだ無ければ null。
 * @returns 確定した Workflow（見つかれば）、区切り検出の有無、および持ち越す fallback 候補。
 */
export function scanForRunningWork(
  page: Event[],
  carriedFallback: RunningWork | null
): RunningWorkScanResult {
  let fallback = carriedFallback

  for (const event of page) {
    if (isRunningWorkBoundaryEvent(event)) {
      return { boundaryFound: true, workflow: null, fallback }
    }

    const candidate = runningWorkCandidateOf(event)
    if (candidate === null) continue

    if (candidate.kind === 'workflow') {
      return { boundaryFound: false, workflow: candidate, fallback }
    }
    if (fallback === null) {
      fallback = candidate
    }
  }

  return { boundaryFound: false, workflow: null, fallback }
}
