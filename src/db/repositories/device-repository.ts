import type { Device } from '../../domain/entities.js'
import type { DeviceRole } from '../../domain/enums.js'
import { toEpochMs } from '../../domain/time.js'
import type { Database } from '../database.js'

/** `devices` テーブルの生行（列は snake_case・role は小文字）。 */
interface DeviceRow {
  id: string
  name: string
  role: string
  first_seen_at: number
  last_seen_at: number
}

/** DB 行（role 小文字）を {@link Device}（role 大文字）へ写す。 */
function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    role: row.role.toUpperCase() as DeviceRole,
    firstSeenAt: toEpochMs(row.first_seen_at),
    lastSeenAt: toEpochMs(row.last_seen_at),
  }
}

/**
 * `devices` テーブルのアクセサ（§7.3）。
 *
 * ドメインの {@link DeviceRole}（`HUB`/`CHILD`）と DDL の CHECK 制約（`hub`/`child`）の
 * 大小文字差を、この Repository の境界で吸収する（書き込み時に小文字化、読み出し時に大文字化）。
 */
export class DeviceRepository {
  constructor(private readonly db: Database) {}

  /**
   * device を冪等に upsert する。既存 device では `first_seen_at` を保存し、
   * `name` / `role` / `last_seen_at` を更新する。
   *
   * @param device 保存するデバイス。
   * @returns 永続化後の {@link Device}（既存なら DB 上の `first_seen_at` を保持）。
   */
  upsert(device: Device): Device {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, role, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           last_seen_at = excluded.last_seen_at`
      )
      .run(device.id, device.name, device.role.toLowerCase(), device.firstSeenAt, device.lastSeenAt)
    return this.findById(device.id)!
  }

  /**
   * id で device を取得する。
   *
   * @param id device_id。
   * @returns 見つかれば {@link Device}、無ければ null。
   */
  findById(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
      | DeviceRow
      | undefined
    return row ? toDevice(row) : null
  }

  /**
   * 全 device を `first_seen_at` 昇順で列挙する。
   *
   * @returns {@link Device} の配列。
   */
  list(): Device[] {
    const rows = this.db
      .prepare('SELECT * FROM devices ORDER BY first_seen_at ASC, id ASC')
      .all() as unknown as DeviceRow[]
    return rows.map(toDevice)
  }
}
