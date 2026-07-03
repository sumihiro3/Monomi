import type { InstanceStatusRow } from '../hub/dto.js'
import { ClientRollup, type ProjectRow } from './client-rollup.js'
import type { StatusFilter } from './status-display.js'

/**
 * CLI の一覧状態（取得結果 + フィルタ）を保持するアプリケーション状態（class-diagram §4）。
 *
 * status 導出は一切持たず、hub から受け取った行の保持と、状態フィルタによる絞り込みだけを
 * 担う（§0.5: 導出は hub 側）。React 非依存の素のクラスにして単体テスト可能にする（AppView は
 * このインスタンスを ref で保持し、変更後に再描画をトリガする）。
 */
export class InstanceListStore {
  private rows: InstanceStatusRow[] = []
  private filters: StatusFilter[] = []
  private readonly clientRollup = new ClientRollup()

  /** 取得済みの全 instance 行（フィルタ適用前）。 */
  get instances(): readonly InstanceStatusRow[] {
    return this.rows
  }

  /** 現在有効な状態フィルタ（空なら全件表示）。 */
  get activeFilters(): readonly StatusFilter[] {
    return this.filters
  }

  /**
   * 取得結果を差し替える（ポーリング更新時に呼ぶ）。
   *
   * @param instances hub から取得した instance 行。
   */
  setInstances(instances: InstanceStatusRow[]): void {
    this.rows = instances
  }

  /**
   * 状態フィルタを一括設定する（重複は除去）。
   *
   * @param filters 適用するフィルタ集合。
   */
  setFilter(filters: StatusFilter[]): void {
    this.filters = [...new Set(filters)]
  }

  /**
   * 状態フィルタを 1 件トグルする（`1`–`6` キー、複数選択可、§10.3）。
   *
   * @param filter トグル対象の表示状態。
   */
  toggleFilter(filter: StatusFilter): void {
    this.filters = this.filters.includes(filter)
      ? this.filters.filter((f) => f !== filter)
      : [...this.filters, filter]
  }

  /** すべての状態フィルタを解除する。 */
  clearFilters(): void {
    this.filters = []
  }

  /**
   * フィルタ適用後の行を返す（フィルタが空なら全件のコピー。ただし `closed` は既定で除外）。
   *
   * 絞り込みは `status.display` の一致のみで判定する（優先順位の解釈は行わない、§0.5）。
   * `closed` は既定非表示（§5.1 / AC-1）。キー`6`で `closed` フィルタをトグルすれば表示可能（AC-3）。
   *
   * @returns 表示対象の instance 行。
   */
  filtered(): InstanceStatusRow[] {
    if (this.filters.length === 0) {
      return this.rows.filter((row) => row.status.display !== 'closed')
    }
    const active = new Set<string>(this.filters)
    return this.rows.filter((row) => active.has(row.status.display))
  }

  /**
   * フィルタ適用後の行を project 単位へ畳み込む（ヘッダのプロジェクト数表示等に使う）。
   *
   * @returns project ごとの {@link ProjectRow}（{@link ClientRollup} 経由）。
   */
  projectRows(): ProjectRow[] {
    return this.clientRollup.rollupByProject(this.filtered())
  }
}
