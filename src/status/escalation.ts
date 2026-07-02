import type { RawState } from '../domain/enums.js'
import { toDurationMs, type DurationMs, type EpochMs } from '../domain/time.js'
import type { StateTransition } from './state-transition-finder.js'
import type { RepresentedStatus } from './status-priority.js'

/** raw_state 別の放置昇格閾値（ミリ秒）。config 由来の値をそのまま渡せる形。 */
export interface EscalationThresholdValues {
  active: DurationMs
  approvalWait: DurationMs
  nextWait: DurationMs
  prWait: DurationMs
}

/**
 * 放置昇格閾値の既定値（§5.1: active 2h / approval_wait 6h / next_wait 24h / pr_wait 72h）。
 *
 * `config.yml` の `escalation_thresholds` はこの既定を上書きする（§5.1「config で
 * 上書き可能」）。config レイヤーは status-engine の下流なので、既定の実体はここに置き、
 * config はパース結果を {@link EscalationThresholds.withDefaults} へ渡す。
 */
export const DEFAULT_ESCALATION_THRESHOLDS: EscalationThresholdValues = {
  active: toDurationMs(2 * 3_600_000),
  approvalWait: toDurationMs(6 * 3_600_000),
  nextWait: toDurationMs(24 * 3_600_000),
  prWait: toDurationMs(72 * 3_600_000),
}

/**
 * raw_state 別の放置昇格閾値を保持する値オブジェクト（§5.1）。
 *
 * 閾値を保持し `forState` で引くだけの不変オブジェクト。判定ロジックは持たない
 * （それは {@link EscalationPolicy}）。
 */
export class EscalationThresholds {
  readonly active: DurationMs
  readonly approvalWait: DurationMs
  readonly nextWait: DurationMs
  readonly prWait: DurationMs

  constructor(values: EscalationThresholdValues) {
    this.active = values.active
    this.approvalWait = values.approvalWait
    this.nextWait = values.nextWait
    this.prWait = values.prWait
    Object.freeze(this)
  }

  /**
   * 既定値に部分上書きを重ねて生成する（config 上書き用）。
   *
   * 省略されたフィールドは {@link DEFAULT_ESCALATION_THRESHOLDS} で補う。
   *
   * @param overrides config 由来などの上書き値（部分指定可）。
   * @returns 生成した {@link EscalationThresholds}。
   */
  static withDefaults(overrides: Partial<EscalationThresholdValues> = {}): EscalationThresholds {
    return new EscalationThresholds({
      active: overrides.active ?? DEFAULT_ESCALATION_THRESHOLDS.active,
      approvalWait: overrides.approvalWait ?? DEFAULT_ESCALATION_THRESHOLDS.approvalWait,
      nextWait: overrides.nextWait ?? DEFAULT_ESCALATION_THRESHOLDS.nextWait,
      prWait: overrides.prWait ?? DEFAULT_ESCALATION_THRESHOLDS.prWait,
    })
  }

  /**
   * raw_state に対応する放置昇格閾値を返す。
   *
   * @param rawState 対象の raw_state。
   * @returns 閾値（ミリ秒）。
   * @throws {Error} `CLOSED` の場合（closed は非表示で放置判定の対象外。§5.1）。
   */
  forState(rawState: RawState): DurationMs {
    switch (rawState) {
      case 'ACTIVE':
        return this.active
      case 'APPROVAL_WAIT':
        return this.approvalWait
      case 'NEXT_WAIT':
        return this.nextWait
      case 'CLOSED':
        throw new Error('EscalationThresholds.forState: CLOSED has no escalation threshold')
    }
  }
}

/**
 * 遷移・経過時間・閾値・PR 有無から表示ステータスを確定するドメインサービス（§5.1 / §5.2）。
 *
 * §5.2 の「1 session につき 1 つに絞る」判定をここに閉じ込める。優先順位は
 * 「放置 > 権限待ち > PR待ち（raw_state ≠ active 時のみ） > 次の指示待ち > 稼働中」。
 */
export class EscalationPolicy {
  /**
   * 表示ステータスを分類する。
   *
   * 手順:
   * 1. `CLOSED` はそのまま `CLOSED`（非表示、放置判定なし）。
   * 2. §5.2 の候補選択（放置昇格前）: `active` はそのまま `ACTIVE`（active 中は PR より
   *    active を優先するため PR を無視）、`approval_wait` は権限待ちが PR より優先度が
   *    高いのでそのまま `APPROVAL_WAIT`、`next_wait` は PR があれば `PR_WAIT`
   *    （PR待ち > 次の指示待ち）なければ `NEXT_WAIT`。
   * 3. その候補状態の閾値で経過時間を判定し、超えていれば `STALE`（放置）へ昇格。
   *    PR待ちは pr_wait の閾値（既定 72h）を用いる（§5.1）。
   *
   * 経過時間は received_at 基準（§0.5）で `now - transitionedAt` として求める。
   *
   * @param transition 現在の raw_state と遷移時刻。
   * @param now hub の現在時刻（received_at 基準の権威時刻）。
   * @param thresholds 放置昇格閾値。
   * @param hasPrWaiting この instance/branch に未レビューの PR があるか（release-1 は常に false）。
   * @returns 確定した表示ステータス。
   */
  classify(
    transition: StateTransition,
    now: EpochMs,
    thresholds: EscalationThresholds,
    hasPrWaiting: boolean
  ): RepresentedStatus {
    const { rawState, transitionedAt } = transition
    if (rawState === 'CLOSED') return 'CLOSED'

    const elapsed = now - transitionedAt

    let base: RepresentedStatus
    if (rawState === 'ACTIVE') {
      base = 'ACTIVE'
    } else if (rawState === 'APPROVAL_WAIT') {
      base = 'APPROVAL_WAIT'
    } else {
      base = hasPrWaiting ? 'PR_WAIT' : 'NEXT_WAIT'
    }

    const threshold = base === 'PR_WAIT' ? thresholds.prWait : thresholds.forState(rawState)
    return elapsed >= threshold ? 'STALE' : base
  }
}
