import fs from 'node:fs'
import os from 'node:os'
import { parseDocument } from 'yaml'
import { loadConfig } from '../config/config.js'
import type { MonomiPaths } from '../config/paths.js'
import { ensureMonomiHome, resolvePaths } from '../config/paths.js'
import type { Database } from '../db/database.js'
import { DeviceRepository } from '../db/repositories/device-repository.js'
import { TokenRepository } from '../db/repositories/token-repository.js'
import { deriveDeviceId } from '../domain/device-id.js'
import type { Device } from '../domain/entities.js'
import { type EpochMs, epochMsNow } from '../domain/time.js'
import { TokenService } from './token-service.js'

/** {@link bootstrap} の任意依存（テスト時の決定性のために hostname / 時刻を注入できる）。 */
export interface BootstrapOptions {
  /** device_id 生成と device.name に使う hostname。省略時は `os.hostname()`。 */
  hostname?: string
  /** device の first/last seen に使う現在時刻。省略時は {@link epochMsNow}。 */
  now?: () => EpochMs
}

/** {@link bootstrap} の結果（HttpServer 起動ログ・テスト検証用）。 */
export interface BootstrapResult {
  /** 確定した device_id（config 既存値、または hostname から生成した値）。 */
  deviceId: string
  /** 登録済み（upsert 済み）の device。 */
  device: Device
  /** ローカル用の生トークン（既存を再利用した場合も含め、常に現在有効な値）。 */
  rawToken: string
  /** 今回の起動で device_id を新規生成し config へ書き戻したか。 */
  deviceIdGenerated: boolean
  /** 今回の起動でトークンを新規発行したか（false なら既存を再利用）。 */
  tokenIssued: boolean
}

/**
 * 生トークンをファイルへ書き出し、パーミッションを `600` に固定する（§0.3: 生 token の保護）。
 *
 * `writeFileSync` の `mode` は umask でマスクされ既存ファイルには適用されないため、書き込み後に
 * 明示的に `chmodSync` する。reporter が `cat` で読んだときに末尾改行が混ざらないよう改行は付けない。
 *
 * @param tokenFile 出力先（`~/.monomi/token`）。
 * @param rawToken 保存する生トークン。
 */
function writeTokenFile(tokenFile: string, rawToken: string): void {
  fs.writeFileSync(tokenFile, rawToken, { mode: 0o600 })
  fs.chmodSync(tokenFile, 0o600)
}

/**
 * トークンファイルを読み出す。存在しなければ `null`、あれば前後の空白を除去して返す。
 *
 * @param tokenFile 読み出すファイル（`~/.monomi/token`）。
 * @returns 生トークン、または存在しなければ `null`。
 */
function readTokenFile(tokenFile: string): string | null {
  if (!fs.existsSync(tokenFile)) {
    return null
  }
  const raw = fs.readFileSync(tokenFile, 'utf8').trim()
  return raw.length > 0 ? raw : null
}

/**
 * config.yml に `device_id` を書き戻す。既存ファイルはコメント・他キーを保持したまま更新する。
 *
 * zod スキーマ（既定値補完・未知キー除去）を通さず YAML Document を直接編集することで、
 * 手作業で編集された config を確認なしに既定値へ戻さないようにする。
 *
 * @param configFile 出力先（`~/.monomi/config.yml`）。
 * @param deviceId 書き込む device_id。
 */
function writeDeviceIdToConfig(configFile: string, deviceId: string): void {
  const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
  const doc = parseDocument(existing)
  doc.set('device_id', deviceId)
  fs.writeFileSync(configFile, doc.toString(), 'utf8')
}

/**
 * hub 起動時の初期化（FR-03 AC-3/AC-4）。冪等に実行できる。
 *
 * 1. `~/.monomi` を用意し config を読み込む。
 * 2. config に device_id が無ければ hostname から生成し（AC-3）、`devices` に upsert 登録、
 *    生成した device_id を config.yml へ書き戻す。
 * 3. 対応する有効トークンが未発行なら（トークンファイルが無い/失効/別 device 用）ローカル用
 *    トークンを発行し（AC-4）、SHA-256 を `tokens` に保存、生トークンを `~/.monomi/token`
 *    （`chmod 600`）へ書き出す。既存が有効ならそれを再利用する。
 *
 * 2 回実行しても device/token は重複しない（device は upsert、トークンは既存ファイルを検証して
 * 再利用）。
 *
 * @param db 初期化済みの hub データベース。
 * @param paths パス集合（省略時は {@link resolvePaths}）。
 * @param options hostname / 時刻の注入（省略可）。
 * @returns 確定した device_id・device・現在有効な生トークン等（{@link BootstrapResult}）。
 */
export function bootstrap(
  db: Database,
  paths: MonomiPaths = resolvePaths(),
  options: BootstrapOptions = {}
): BootstrapResult {
  const hostname = options.hostname ?? os.hostname()
  const now = options.now ?? epochMsNow

  ensureMonomiHome(paths)

  const config = loadConfig(paths)
  const deviceRepo = new DeviceRepository(db)
  const tokenRepo = new TokenRepository(db)
  const tokenService = new TokenService(tokenRepo, deviceRepo)

  const deviceIdGenerated = config.deviceId === undefined
  const deviceId = config.deviceId ?? deriveDeviceId(hostname)

  const nowMs = now()
  const device = deviceRepo.upsert({
    id: deviceId,
    name: hostname,
    role: 'HUB',
    firstSeenAt: nowMs,
    lastSeenAt: nowMs,
  })

  if (deviceIdGenerated) {
    writeDeviceIdToConfig(paths.configFile, deviceId)
  }

  const existingToken = readTokenFile(paths.tokenFile)
  const existingIsValidForDevice =
    existingToken !== null && tokenService.verify(existingToken)?.id === deviceId

  let rawToken: string
  let tokenIssued: boolean
  if (existingToken !== null && existingIsValidForDevice) {
    rawToken = existingToken
    tokenIssued = false
  } else {
    rawToken = tokenService.issue(deviceId)
    writeTokenFile(paths.tokenFile, rawToken)
    tokenIssued = true
  }

  return { deviceId, device, rawToken, deviceIdGenerated, tokenIssued }
}
