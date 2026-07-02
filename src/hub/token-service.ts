import { createHash, randomBytes } from 'node:crypto'
import type { Device } from '../domain/entities.js'
import type { DeviceRepository } from '../db/repositories/device-repository.js'
import type { TokenRepository } from '../db/repositories/token-repository.js'

/**
 * 発行するトークンのエントロピー（バイト数）。32 バイト = 256 bit の乱数を base64url で
 * エンコードするため、ソルト付きの低速ハッシュ（bcrypt 等）は不要で SHA-256 で十分
 * （§0.3 / class-diagram の `TokenService.hash` 注記）。
 */
const TOKEN_ENTROPY_BYTES = 32

/**
 * デバイス認証トークンの発行・検証・失効を担うドメインサービス（§0.3 / class-diagram §3）。
 *
 * 生トークンは保存せず SHA-256 ハッシュのみを永続化する。ハッシュ化・乱数生成の詳細を
 * ここに閉じ込め、Repository は `token_hash` の永続化と UNIQUE 制約にのみ責任を持つ。
 *
 * `verify` が {@link Device} を返す仕様（生トークン → device 解決）のため、class-diagram の
 * `TokenService ..> TokenRepository` に加えて {@link DeviceRepository} にも依存する
 * （device 実体の取得に必要）。
 */
export class TokenService {
  constructor(
    private readonly tokens: TokenRepository,
    private readonly devices: DeviceRepository
  ) {}

  /**
   * device 用の新しいトークンを発行する。高エントロピーな乱数トークンを生成し、その
   * SHA-256 ハッシュのみを `tokens` テーブルへ保存する（生トークンは保存しない）。
   *
   * @param deviceId 発行先 device の id（`devices.id` に存在している必要がある）。
   * @returns 呼び出し側にだけ渡す生トークン（reporter/CLI 用に一度だけ取得できる）。
   */
  issue(deviceId: string): string {
    const rawToken = randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')
    this.tokens.create(deviceId, this.hash(rawToken))
    return rawToken
  }

  /**
   * 生トークンを検証し、対応する有効な device を返す。
   *
   * ハッシュが一致しない・revoke 済み・device が存在しない場合はいずれも認証失敗として
   * `null` を返す（後段の Controller が 401 化する）。
   *
   * @param rawToken `Authorization: Bearer` で受け取った生トークン。
   * @returns 有効なら {@link Device}、無効/失効なら `null`。
   */
  verify(rawToken: string): Device | null {
    const token = this.tokens.findByHash(this.hash(rawToken))
    if (token === null || token.revokedAt !== null) {
      return null
    }
    return this.devices.findById(token.deviceId)
  }

  /**
   * トークンを失効させる（`tokens.revoked_at` を埋める）。
   *
   * @param tokenId 失効させる token の主キー。
   */
  revoke(tokenId: number): void {
    this.tokens.revoke(tokenId)
  }

  /**
   * device に有効な（未 revoke の）トークンが1つ以上あるかを返す（`devices list` の表示用、
   * FR-03 AC-1）。
   *
   * @param deviceId 判定対象 device の id。
   * @returns 有効トークンが1つでもあれば true。
   */
  hasActiveToken(deviceId: string): boolean {
    return this.tokens.findByDeviceId(deviceId).some((token) => token.revokedAt === null)
  }

  /**
   * 有効な（未 revoke の）トークンを持つ device_id 集合を返す（`devices list` の表示用、
   * review #3）。一覧表示のたびに device ごと {@link hasActiveToken} を呼ぶ N+1 を避けるため、
   * 呼び出し側は本メソッドを 1 回だけ呼んで `Set.has` で判定する。
   *
   * @returns 有効トークンを1つ以上持つ device_id の {@link Set}。
   */
  activeDeviceIds(): Set<string> {
    return new Set(this.tokens.listDeviceIdsWithActiveToken())
  }

  /**
   * device に紐づく全ての有効トークンを一括失効させる（`devices revoke`、FR-03 AC-2）。
   * 失効後は {@link verify} が当該トークンで `null` を返し、後段が 401 化する。
   *
   * @param deviceId 失効対象 device の id。
   * @returns 実際に失効させたトークン数。
   */
  revokeAllForDevice(deviceId: string): number {
    return this.tokens.revokeByDeviceId(deviceId)
  }

  /**
   * 生トークンを SHA-256 の 16 進表現へハッシュ化する。保存・照合の双方でこの関数を通す。
   *
   * @param rawToken 生トークン。
   * @returns SHA-256(token) の 16 進文字列。
   */
  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex')
  }
}
