import { randomInt } from 'node:crypto'
import type { DeviceRepository } from '../db/repositories/device-repository.js'
import { epochMsNow, toEpochMs, type EpochMs } from '../domain/time.js'
import type { TokenService } from './token-service.js'

/** ペアリングコードの TTL（既定 5 分、§9）。 */
const DEFAULT_TTL_MS = 300_000

/** コード無効化までの失敗回数（§0.3: 失敗5回で即無効化）。 */
const DEFAULT_MAX_FAILURES = 5

/** 6 桁コードの上限（`000000`〜`999999` の一様乱数を作る法）。 */
const CODE_MODULUS = 1_000_000

/**
 * 暗号論的乱数で 6 桁のゼロ埋めコードを生成する（`000000`〜`999999`）。
 *
 * `randomInt` は一様分布を保証する（剰余バイアスが無い）。`Math.random` は使わない。
 *
 * @returns 6 桁のコード文字列。
 */
function randomSixDigitCode(): string {
  return randomInt(0, CODE_MODULUS).toString().padStart(6, '0')
}

/** メモリ上に保持する 1 ペアリングセッションの状態（§9: SQLite 永続化はしない）。 */
interface PairingEntry {
  /** 失効時刻（発行時刻 + TTL）。 */
  expiresAt: EpochMs
  /** これまでの失敗（不一致）回数。{@link DEFAULT_MAX_FAILURES} 到達で無効化する。 */
  failureCount: number
}

/** {@link PairingService.startPairing} が返す発行済みコード（§9 / FR-02 AC-1）。 */
export interface PairingCode {
  /** 発行した 6 桁コード（平文。hub CLI がユーザーへ表示する）。 */
  code: string
  /** 失効時刻。 */
  expiresAt: EpochMs
  /** TTL（ミリ秒）。Controller が `ttl_seconds` を導出するために返す。 */
  ttlMs: number
}

/** {@link PairingService.claim} 成功時に登録する child デバイスの申告情報（§0.3）。 */
export interface PairingClaimDeviceInfo {
  /** 登録する child の device_id（child が自機の値を申告）。 */
  deviceId: string
  /** child の表示名（hostname 相当）。 */
  name: string
}

/**
 * {@link PairingService.claim} の失敗理由（AC-5 / FR-02 のエラーメッセージ分岐に使う）。
 *
 * - `invalid_code`: コード不一致・使用済み・総当りで無効化済み（Controller が 400）。
 * - `expired`: TTL 切れ（Controller が 400）。
 * - `device_conflict`: 申告 device_id が既存かつ有効トークン保持 = 乗っ取り（Controller が 409、§0.3）。
 */
export type PairingClaimFailure = 'invalid_code' | 'expired' | 'device_conflict'

/**
 * {@link PairingService.claim} の結果。成功で `token`（+ 登録した device_id）、失敗で理由を返す。
 */
export type PairingClaimResult =
  | { ok: true; token: string; deviceId: string }
  | { ok: false; reason: PairingClaimFailure }

/** {@link PairingService} の任意依存（テスト時の決定性のために時刻・TTL・コード生成を注入できる）。 */
export interface PairingServiceOptions {
  /** 権威時刻の供給関数（TTL 判定に使う）。省略時は {@link epochMsNow}。 */
  now?: () => EpochMs
  /** コードの TTL（ミリ秒）。省略時は {@link DEFAULT_TTL_MS}（5 分）。 */
  ttlMs?: number
  /** コード生成関数。省略時は暗号論的 6 桁乱数（テストで固定コードを注入できる）。 */
  generateCode?: () => string
  /** 無効化までの失敗回数。省略時は {@link DEFAULT_MAX_FAILURES}（5 回）。 */
  maxFailures?: number
}

/**
 * 6 桁コードによる手動ペアリングを司るドメインサービス（§9 / §0.3 / class-diagram §3）。
 *
 * コードは **メモリ上の Map に TTL 付きで保持するだけ**で SQLite には永続化しない（§9）。
 * `startPairing` でコードを発行し、`claim` で照合する。総当り無力化のため、コード不一致の
 * claim は **アクティブな全コードの失敗回数を加算し、{@link DEFAULT_MAX_FAILURES} 回で即座に
 * 無効化する**（§0.3）。正しいコードでの claim は単発で破棄し（再利用不可）、その場で child
 * デバイスを {@link DeviceRepository} へ upsert 登録して {@link TokenService} で device_token を
 * 発行する。
 *
 * 失敗カウントを「アクティブな全コード」に対して加算するのは、攻撃者が「今アクティブなコード」を
 * 狙って総当りする以上、どの推測ミスも現行ペアリングへの試行とみなすのが安全（fail-closed）な
 * ため。個人利用規模では同時に有効なコードは基本 1 件で、この方針で §0.3 の「失敗5回で無効化」を
 * そのまま満たす。
 */
export class PairingService {
  /** コード文字列をキーにした発行済みペアリングの集合（メモリのみ、§9）。 */
  private readonly entries = new Map<string, PairingEntry>()
  private readonly now: () => EpochMs
  private readonly ttlMs: number
  private readonly generateCode: () => string
  private readonly maxFailures: number

  /**
   * @param tokens device_token 発行に使う {@link TokenService}。
   * @param devices claim 成功時に child を登録する {@link DeviceRepository}。
   * @param options 時刻・TTL・コード生成の注入（省略可）。
   */
  constructor(
    private readonly tokens: TokenService,
    private readonly devices: DeviceRepository,
    options: PairingServiceOptions = {}
  ) {
    this.now = options.now ?? epochMsNow
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.generateCode = options.generateCode ?? randomSixDigitCode
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
  }

  /**
   * 新しい 6 桁コードを発行して TTL 付きで保持する（§9 / FR-02 AC-1）。
   *
   * @returns 発行したコード・失効時刻・TTL。
   */
  startPairing(): PairingCode {
    const code = this.generateCode()
    const expiresAt = toEpochMs(this.now() + this.ttlMs)
    this.entries.set(code, { expiresAt, failureCount: 0 })
    return { code, expiresAt, ttlMs: this.ttlMs }
  }

  /**
   * コードを照合し、成功なら child を登録して device_token を発行する（§9 / §0.3 / FR-02 AC-3/AC-4）。
   *
   * - 正しい未失効コード: 単発破棄（再利用不可）→ child を upsert 登録 → device_token を発行。
   * - 正しいが TTL 切れのコード: 破棄して `expired` を返す（AC-5）。
   * - 正しいコードだが申告 device_id が既存かつ有効トークン保持: 乗っ取りとみなし `device_conflict`
   *   を返す（§0.3）。**コードは消費しない**（entry を残す）ため、`monomi hub devices revoke <id>`
   *   で当該 device の有効トークンを失効させれば、同一の in-flight コードで再ペアリングできる。
   * - コード不一致: 総当り試行として全アクティブコードの失敗回数を加算し、5 回で無効化して
   *   `invalid_code` を返す（§0.3）。
   *
   * @param code claim 側が提示したコード。
   * @param device 登録する child の申告情報（成功時のみ使用）。
   * @returns 成功なら `{ ok: true, token, deviceId }`、失敗なら理由付きの結果。
   */
  claim(code: string, device: PairingClaimDeviceInfo): PairingClaimResult {
    const now = this.now()
    const entry = this.entries.get(code)
    if (entry !== undefined) {
      if (now >= entry.expiresAt) {
        this.entries.delete(code)
        return { ok: false, reason: 'expired' }
      }
      // 乗っ取り拒否（§0.3）: 既存 device かつ有効トークン保持なら device_conflict を返す。
      // ここでコードを消費しない（entry を残す）ので、revoke 後に同一コードで再ペアリングできる。
      if (
        this.devices.findById(device.deviceId) !== null &&
        this.tokens.hasActiveToken(device.deviceId)
      ) {
        return { ok: false, reason: 'device_conflict' }
      }
      // 成功: 単発破棄（§0.3）してから child 登録 + token 発行。
      this.entries.delete(code)
      const registered = this.devices.upsert({
        id: device.deviceId,
        name: device.name,
        role: 'CHILD',
        firstSeenAt: now,
        lastSeenAt: now,
      })
      const token = this.tokens.issue(registered.id)
      return { ok: true, token, deviceId: registered.id }
    }
    // 不一致（総当り）: アクティブコードの失敗回数を加算し、閾値で即無効化（§0.3）。
    this.registerFailure(now)
    return { ok: false, reason: 'invalid_code' }
  }

  /**
   * コード不一致 1 回分の失敗を記録する。TTL 切れのエントリは掃除し、失敗が
   * {@link maxFailures} に達したコードは即座に無効化する（§0.3）。
   *
   * @param now 現在時刻（失効判定に使う）。
   */
  private registerFailure(now: EpochMs): void {
    for (const [code, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(code)
        continue
      }
      entry.failureCount += 1
      if (entry.failureCount >= this.maxFailures) {
        this.entries.delete(code)
      }
    }
  }
}
