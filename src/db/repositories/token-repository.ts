import type { DeviceToken } from '../../domain/entities.js'
import { epochMsNow, toEpochMs, type EpochMs } from '../../domain/time.js'
import type { Database, PreparedStatement } from '../database.js'

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
  /** {@link findByHash} 用の SELECT（FR-08 AC-2: 呼び出しごとの prepare() を避ける）。 */
  private readonly findByHashStmt: PreparedStatement
  /** {@link findByDeviceId} 用の SELECT。 */
  private readonly findByDeviceIdStmt: PreparedStatement
  /** {@link create} 用の INSERT。 */
  private readonly createStmt: PreparedStatement
  /** {@link revoke} 用の UPDATE。 */
  private readonly revokeStmt: PreparedStatement
  /** {@link revokeByDeviceId} 用の UPDATE（device 起点の一括失効）。 */
  private readonly revokeByDeviceIdStmt: PreparedStatement
  /** {@link listDeviceIdsWithActiveToken} 用の SELECT DISTINCT。 */
  private readonly listDeviceIdsWithActiveTokenStmt: PreparedStatement

  constructor(db: Database) {
    this.findByHashStmt = db.prepare('SELECT * FROM tokens WHERE token_hash = ?')
    this.findByDeviceIdStmt = db.prepare('SELECT * FROM tokens WHERE device_id = ? ORDER BY id ASC')
    this.createStmt = db.prepare(
      'INSERT INTO tokens (device_id, token_hash, created_at) VALUES (?, ?, ?)'
    )
    this.revokeStmt = db.prepare(
      'UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
    )
    this.revokeByDeviceIdStmt = db.prepare(
      'UPDATE tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL'
    )
    this.listDeviceIdsWithActiveTokenStmt = db.prepare(
      'SELECT DISTINCT device_id FROM tokens WHERE revoked_at IS NULL'
    )
  }

  /**
   * `token_hash` でトークンを取得する（Bearer 認証時の照合に使う）。
   *
   * @param hash SHA-256(token) の 16 進表現。
   * @returns 見つかれば {@link DeviceToken}、無ければ null（revoke 済みでも行は返す）。
   */
  findByHash(hash: string): DeviceToken | null {
    const row = this.findByHashStmt.get(hash) as TokenRow | undefined
    return row ? toDeviceToken(row) : null
  }

  /**
   * device に紐づく全トークンを `id` 昇順で取得する（`devices list` の有効トークン有無表示用、
   * FR-03 AC-1）。revoke 済みの行も含めて返し、有効判定（`revokedAt === null`）は呼び出し側に委ねる。
   *
   * @param deviceId 所属 device の id。
   * @returns 当該 device のトークン配列（0 件なら空配列）。
   */
  findByDeviceId(deviceId: string): DeviceToken[] {
    const rows = this.findByDeviceIdStmt.all(deviceId) as unknown as TokenRow[]
    return rows.map(toDeviceToken)
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
    const result = this.createStmt.run(deviceId, hash, createdAt)
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
    this.revokeStmt.run(at, id)
  }

  /**
   * device に紐づく **有効な** トークンを一括で revoke する（FR-03 AC-2: `devices revoke`）。
   * 既に revoke 済みの行は対象外（`revoked_at` を上書きしない）。
   *
   * @param deviceId 失効対象 device の id。
   * @param at revoke 時刻。省略時は現在時刻。
   * @returns 実際に revoke した（有効だった）トークン数。
   */
  revokeByDeviceId(deviceId: string, at: EpochMs = epochMsNow()): number {
    const result = this.revokeByDeviceIdStmt.run(at, deviceId)
    return Number(result.changes)
  }

  /**
   * 有効な（未 revoke の）トークンを1つ以上持つ device の id 一覧を返す（`devices list` の
   * 表示用、review #3）。per-device の {@link findByDeviceId} 呼び出しを重ねる N+1 を避け、
   * `devices list` 1 回につき本メソッドを 1 回だけ呼ぶことを想定する。
   *
   * @returns 有効トークンを持つ device_id の配列（重複なし、順序は未規定）。
   */
  listDeviceIdsWithActiveToken(): string[] {
    const rows = this.listDeviceIdsWithActiveTokenStmt.all() as unknown as { device_id: string }[]
    return rows.map((row) => row.device_id)
  }
}
