import { randomUUID } from 'node:crypto'

/**
 * 型別接頭辞つきのランダム ID を生成する（例 `proj_...` / `inst_...`）。
 *
 * `projects` / `instances` の主キーはエージェント側 ID を持たないため hub 側で採番する
 * （`devices.id` は device_id、`sessions.id` は session_id を流用するので対象外）。
 * `randomUUID()` を使い衝突を実質排除し、接頭辞で人が種別を判別できるようにする。
 *
 * @param prefix 種別を表す短い接頭辞（`proj` / `inst` 等）。
 * @returns `{prefix}_{uuid}` 形式の ID。
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}
