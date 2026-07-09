import type { Event } from '../domain/entities.js'
import type { EpochMs } from '../domain/time.js'

/**
 * 「実行中の作業名（running work）」の種別（release-16 FR-02）。
 *
 * `Task`/`Agent` の tool_name 表記揺れ（実イベントでの表記違い）は両方とも `'agent'` に
 * 集約する（requirements.md 未解決事項: 実装時に両表記をマッチ対象にする）。
 */
export type RunningWorkKind = 'workflow' | 'agent' | 'skill'

/**
 * セッションが「今実行中」と見なせる作業（release-16 FR-02。release-18 FR-05 で `startedAt` を追加）。
 *
 * `name` は reporter が `tool_summary` に載せた表示名（release-16 FR-01）をそのまま運ぶ。
 * CLI 表示前のサニタイズ（`sanitize-display-text`、CWE-150 対策）は呼び出し側（CLI レイヤー）
 * の責務であり、このモジュールは加工しない。
 */
export interface RunningWork {
  kind: RunningWorkKind
  name: string
  /**
   * この候補を採用した `PreToolUse` イベントの発生時刻（reporter 側時刻、`event.occurredAt`）。
   * hub 権威時刻（`receivedAt`）ではなく `occurredAt` を使う（requirements.md が明示する例外:
   * 経過時間の表示は「作業の開始」という利用者にとっての意味を優先し、クロックスキュー補正の
   * ための hub 受信時刻ではなく reporter 側の発生時刻をそのまま使う）。CLI 表示前の
   * ISO8601 への変換（wire 変換）は {@link ../hub/dto.js#toRunningWorkDto} の責務であり、
   * このモジュールは epoch ms のまま運ぶ。
   */
  startedAt: EpochMs
}

/**
 * {@link scanForRunningWork} の 1 ページ分の走査結果。
 *
 * `run-boundary-scanner.ts` の `RunBoundaryScanResult`/`scanForRunBoundary`（received_at
 * 降順の 1 ページを走査し、ページングの継続/打ち切りを呼び出し側に委ねる構造）と対になる
 * 姉妹型だが、区切りイベントの集合が異なるため独立して定義する（raw_state 境界は
 * `APPROVAL_WAIT`（`Notification(permission_prompt)`）も区切るが、running work の消灯は
 * 候補種別で非対称：release-18 FR-04 が導入した仕様）。
 *
 * release-16 時点では Workflow/Skill/Agent を単一の区切り集合（`Stop`/`idle_prompt`/
 * `SessionEnd`/`UserPromptSubmit`）で対称に扱っていたが、バックグラウンド実行される
 * `Workflow` はツール呼び出し自体（`PreToolUse`→`PostToolUse`）が数秒で完結し直後の
 * ターン終了で `Stop` が発火するため、この対称設計では稼働中の Workflow 名が `Stop` の
 * 向こう側に取り残されて消灯してしまう不具合（既知課題 U8）があった。release-18 FR-04 は
 * 「**Workflow はターンを跨いで生き続けうる**」という実態に合わせ、Workflow 候補の区切りを
 * `SessionEnd`（セッション終了）のみに狭め、Skill/Agent の fallback 候補は従来の区切り集合
 * （`Stop`/`Notification(idle_prompt)`/`SessionEnd`/`UserPromptSubmit`）を維持する非対称設計へ
 * 再設計した。
 */
export interface RunningWorkScanResult {
  /**
   * このページ内で確定した Workflow。Workflow 候補の区切りは `SessionEnd` のみなので、
   * fallback 側の区切り（`Stop`/`UserPromptSubmit`/`idle_prompt`）を跨いだ先で見つかっても
   * 確定として返す（見つかった時点で降順走査の性質上最新であり、それより古い候補で
   * 上書きされる余地はない）。呼び出し側はこれが非 null ならページングを即打ち切って
   * 採用できる。fallback より優先される（FR-04: 境界を跨いで見つけた Workflow >
   * 境界内の fallback）。
   */
  workflow: RunningWork | null
  /**
   * `SessionEnd`（Workflow 候補にとっての唯一の区切り）に当たったか。true なら
   * 呼び出し側はこれより古いページを読む必要がない（このページより古い Workflow は
   * 別セッション実行に属するため候補にしない）。
   */
  sessionEndFound: boolean
  /**
   * Task/Agent/Skill の fallback 候補。ページ内・複数ページに渡り最初に見つかった
   * （＝最新の）候補のみを保持し、以降の候補では上書きしない（AC-3: 「最新の」
   * Task/Agent/Skill を採用）。{@link fallbackBoundaryReached} が true になった後は
   * 更新されない（凍結）。
   */
  fallback: RunningWork | null
  /**
   * fallback 候補にとっての区切り（`Stop`/`Notification(idle_prompt)`/`SessionEnd`/
   * `UserPromptSubmit`。release-16 からの従来境界）に、これまでの走査で当たった済みか。
   * true になった後の（降順走査でより古い）候補は fallback に採用しない一方、Workflow の
   * 探索自体はこの後も継続する（非対称設計の中核）。
   */
  fallbackBoundaryReached: boolean
}

/** `Workflow` ツールと見なす tool_name の集合。 */
const WORKFLOW_TOOL_NAMES = new Set(['Workflow'])

/** `Task`/`Agent`（サブエージェント起動）ツールと見なす tool_name の集合。 */
const AGENT_TOOL_NAMES = new Set(['Task', 'Agent'])

/** `Skill` ツールと見なす tool_name の集合。 */
const SKILL_TOOL_NAMES = new Set(['Skill'])

/**
 * イベントが `SessionEnd`（Workflow 候補にとっての唯一の区切り）かどうかを判定する
 * （release-18 FR-04 導出規則）。
 *
 * @param event 判定対象イベント。
 * @returns `SessionEnd` イベントなら true。
 */
function isSessionEndEvent(event: Event): boolean {
  return event.eventType === 'SessionEnd'
}

/**
 * イベントが fallback（Task/Agent/Skill）候補にとっての「区切り」（稼働区間の終端）かどうかを
 * 判定する（release-16 FR-02 導出規則。release-18 FR-04 でも fallback 側はこの従来境界を
 * 維持する。Workflow 候補側の区切りは {@link isSessionEndEvent} のみに狭められている）。
 *
 * `permission_prompt`（raw_state の `APPROVAL_WAIT`）は区切りに含めない（requirements.md
 * line20 が明示する消灯条件は Stop/idle_prompt/SessionEnd/UserPromptSubmit のみ）。承認待ち中に
 * running work が実際には消灯するのは、この関数が区切りを見つけないまま稼働区間の走査を続け
 * つつも、呼び出し側の「代表 session が ACTIVE のときだけ導出する」ゲート（FR-02 line53:
 * 非 ACTIVE は即 null）が先に働くため。要件間の見かけ上の矛盾（line20 と line53）は
 * line53 優先で確定済み（release-16 要件の確定判断）。
 *
 * @param event 判定対象イベント。
 * @returns fallback にとっての区切りイベントなら true。
 */
function isFallbackBoundaryEvent(event: Event): boolean {
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
    return { kind: 'workflow', name: event.toolSummary, startedAt: event.occurredAt }
  }
  if (AGENT_TOOL_NAMES.has(event.toolName)) {
    return { kind: 'agent', name: event.toolSummary, startedAt: event.occurredAt }
  }
  if (SKILL_TOOL_NAMES.has(event.toolName)) {
    return { kind: 'skill', name: event.toolSummary, startedAt: event.occurredAt }
  }
  return null
}

/**
 * hub 権威時刻（received_at）降順の 1 ページ分のイベントを走査し、「実行中の作業名」を
 * 選定するドメインサービス（release-18 FR-04 導出規則）。`run-boundary-scanner.ts` の
 * `scanForRunBoundary` と同じ「1 ページ走査・ページングの継続判断は呼び出し側」という
 * 構造を持つ姉妹関数だが、区切り集合が異なるため既存関数は流用せずこちらを新規に用意する。
 *
 * **非対称な区切り（FR-04 の中核）**: Workflow 候補は `SessionEnd`（{@link isSessionEndEvent}）
 * に当たるまで探索を続け、`Stop`/`UserPromptSubmit`/`Notification(idle_prompt)` を跨いで
 * 古いページまで遡ってよい。一方 fallback（Task/Agent/Skill）候補は従来通り
 * `Stop`/`UserPromptSubmit`/`idle_prompt`/`SessionEnd`（{@link isFallbackBoundaryEvent}）で
 * 探索を打ち切り、それ以降（古い側）の候補は採用しない（凍結）。降順走査中に Workflow が
 * 見つかった時点で、`fallbackBoundaryReached` の状態に関わらず即確定して返す
 * （Workflow は fallback より優先。FR-04: 境界を跨いで見つけた Workflow > 境界内の fallback）。
 *
 * hub 側（`InstanceStatusService`。本関数の呼び出し元）はページを取得するたびにこの関数を
 * 呼び、`workflow` が非 null になった時点、または `sessionEndFound` が true になった時点で
 * ページングを打ち切る（それ以外——fallback 側の区切りのみを跨いだだけ——では打ち切らず、
 * `fallback`/`fallbackBoundaryReached` をキャリーして次の（より古い）ページへ進む）。
 * `SessionEnd` に当たらないまま Workflow も見つからずページが尽きた場合は、それまでに集めた
 * `fallback` を running work として採用する（AC-3）。
 *
 * 呼び出し側は「代表 session の `StatusResult.rawState === 'ACTIVE'`」のときだけこの関数を
 * 駆動する想定（ACTIVE ゲート、release-16 FR-02 line53 相当。release-18 でも維持）。
 * 非 ACTIVE（`APPROVAL_WAIT`/`NEXT_WAIT`/`CLOSED`）は呼び出し側が既に算出済みの
 * `StatusResult` を見て即 null とし、本関数を呼ばない（追加のイベント読み取りを発生させない
 * ため、既知課題 P3 の悪化を避ける）。この関数自身はページング（DB 読み取り）を持たない
 * 純関数であり、駆動は呼び出し側（hub レイヤー）の責務。
 *
 * **性能上のトレードオフ（意図的な受容、既知課題 P8）**: Workflow 候補が `SessionEnd` まで
 * 探索を続けるため、`SessionEnd` を送らずに長時間 ACTIVE のまま稼働し続けるセッション
 * （バックグラウンド Workflow 実行中はこれが通常のパターン）では、ポーリングのたびに
 * セッション開始付近まで遡る＝履歴長に比例したイベント読み込みが発生しうる。これは
 * 「Workflow 名を稼働中ずっと表示し続ける」という機能要件と「P8 を悪化させない」という
 * NFR が両立しないために意図的に受容したトレードオフである（`docs/known-issues.md` P8 /
 * `docs/ARCHITECTURE.md` §8.4 参照）。
 *
 * @param page hub 権威時刻（received_at）降順の 1 ページ分のイベント
 *   （`EventRepository.recentPageForSession` 相当の出力）。
 * @param carriedFallback 直前までのページで見つけている Task/Agent/Skill 候補。まだ無ければ null。
 * @param carriedFallbackBoundaryReached 直前までのページで fallback の区切りに当たり済みか。
 *   まだ当たっていなければ false（呼び出し側の初回呼び出しは常に false）。
 * @returns 確定した Workflow（見つかれば）、`SessionEnd` 検出の有無、および持ち越す
 *   fallback 候補・fallback 境界到達状態。
 */
export function scanForRunningWork(
  page: Event[],
  carriedFallback: RunningWork | null,
  carriedFallbackBoundaryReached: boolean
): RunningWorkScanResult {
  let fallback = carriedFallback
  let fallbackBoundaryReached = carriedFallbackBoundaryReached

  for (const event of page) {
    if (isSessionEndEvent(event)) {
      return { workflow: null, sessionEndFound: true, fallback, fallbackBoundaryReached: true }
    }

    if (!fallbackBoundaryReached && isFallbackBoundaryEvent(event)) {
      fallbackBoundaryReached = true
      continue
    }

    const candidate = runningWorkCandidateOf(event)
    if (candidate === null) continue

    if (candidate.kind === 'workflow') {
      return { workflow: candidate, sessionEndFound: false, fallback, fallbackBoundaryReached }
    }
    if (!fallbackBoundaryReached && fallback === null) {
      fallback = candidate
    }
  }

  return { workflow: null, sessionEndFound: false, fallback, fallbackBoundaryReached }
}
