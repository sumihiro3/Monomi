import type { DeviceToken } from '../../domain/entities.js'
import { epochMsNow, toEpochMs, type EpochMs } from '../../domain/time.js'
import type { Database } from '../database.js'

/** `tokens` テーブルの生行。 */
interface TokenRow {
  id: number
  device_id: string
  token_hash: string
  created_at: number
  revoked_at: number | null
}

/** DB 行を {@link DeviceToken} へ写す。 */
function toDeviceToken(row: TokenRow): DeviceToken {
  return {
    id: row.id,
    deviceId: row.device_id,
    tokenHash: row.token_hash,
    createdAt: toEpochMs(row.created_at),
    revokedAt: row.revoked_at === null ? null : toEpochMs(row.revoked_at),
  }
}

/**
 * `tokens` テーブルのアクセサ（§0.3）。
 *
 * 生トークンは保存せず SHA-256 ハッシュ（`token_hash`）のみを扱う。ハッシュ化・検証は
 * 上位の `TokenService` の責務で、本 Repository は永続化と `token_hash` の UNIQUE 制約に
 * のみ責任を持つ。
 */
export class TokenRepository {
  constructor(private readonly db: Database) {}

  /**
   * `token_hash` でトークンを取得する（Bearer 認証時の照合に使う）。
   *
   * @param hash SHA-256(token) の 16 進表現。
   * @returns 見つかれば {@link DeviceToken}、無ければ null（revoke 済みでも行は返す）。
   */
  findByHash(hash: string): DeviceToken | null {
    const row = this.db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(hash) as
      TokenRow | undefined
    return row ? toDeviceToken(row) : null
  }

  /**
   * device に紐づくトークンを作成する。
   *
   * @param deviceId 所属 device の id。
   * @param hash SHA-256(token) の 16 進表現。
   * @returns 採番済み `id` を持つ {@link DeviceToken}（`revoked_at` は null）。
   */
  create(deviceId: string, hash: string): DeviceToken {
    const createdAt = epochMsNow()
    const result = this.db
      .prepare('INSERT INTO tokens (device_id, token_hash, created_at) VALUES (?, ?, ?)')
      .run(deviceId, hash, createdAt)
    return {
      id: Number(result.lastInsertRowid),
      deviceId,
      tokenHash: hash,
      createdAt,
      revokedAt: null,
    }
  }

  /**
   * トークンを revoke する（`revoked_at` を埋める）。既に revoke 済みなら時刻を上書きしない。
   *
   * @param id token の主キー。
   * @param at revoke 時刻。省略時は現在時刻。
   */
  revoke(id: number, at: EpochMs = epochMsNow()): void {
    this.db
      .prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(at, id)
  }
}
