import fs from 'node:fs'
import os from 'node:os'
import { loadConfig } from '../config/config.js'
import { writeChildPairingConfig } from '../config/config-writer.js'
import { ensureMonomiHome, type MonomiPaths, resolvePaths } from '../config/paths.js'
import { deriveDeviceId } from '../domain/device-id.js'
import type { PairClaimResponse, PairStartResponse } from '../hub/dto.js'
import { HubApiClient, PairRejectedError } from './hub-api-client.js'
import { buildCandidateUrls, type NetworkDetectOptions } from './network.js'

/** child の token ファイルのパーミッション（`chmod 600`。生 token を所有者のみに限定、§0.3）。 */
const TOKEN_FILE_MODE = 0o600

/** {@link runHubPair} の依存（テストで fetch / paths / network 検出 / 出力を差し替える）。 */
export interface HubPairDeps {
  /** `~/.monomi` パス集合（省略時は {@link resolvePaths}）。 */
  paths?: MonomiPaths
  /** HTTP 実装（省略時はグローバル `fetch`）。 */
  fetchImpl?: typeof fetch
  /** 到達先候補検出の差し替え（networkInterfaces / tailscale CLI）。 */
  network?: NetworkDetectOptions
  /** 出力先。 */
  log: (message: string) => void
}

/** `monomi pair` の解析済み引数。 */
export interface ChildPairOptions {
  /** hub が発行した 6 桁コード（`--code`）。 */
  code: string
  /**
   * 手動指定の hub 到達先（`--hub`、複数指定可 / #4）。各要素は URL / `host:port` / `host` を許容し、
   * 指定順が {@link resolveEndpoints} での到達優先順（先頭最優先）になる。未指定なら空配列。
   */
  hub: string[]
}

/** {@link runChildPair} の依存（テストで fetch / paths / hostname / 出力を差し替える）。 */
export interface ChildPairDeps {
  /** `~/.monomi` パス集合（省略時は {@link resolvePaths}）。 */
  paths?: MonomiPaths
  /** HTTP 実装（省略時はグローバル `fetch`）。 */
  fetchImpl?: typeof fetch
  /** hostname 供給（device_id 派生・name 申告に使う。省略時は `os.hostname`）。 */
  hostname?: () => string
  /** 出力先。 */
  log: (message: string) => void
}

/**
 * エラーオブジェクトから表示用メッセージを取り出す。
 *
 * @param err catch した値。
 * @returns 文字列メッセージ。
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `--hub` / config `hub_endpoints` の入力を `http://host:port` の正規 URL へ整える。
 *
 * `http(s)://` が無ければ補い、ポートが無ければ `defaultPort` を補う。パス・クエリは捨てる
 * （エンドポイントは host:port まで）。{@link resolveEndpoints} は `--hub` と config 由来の値の
 * 双方にこの関数を適用し、scheme 無し値（例 `192.168.1.100:47632`）の扱いを対称にする（#2）。
 *
 * @param input ユーザー入力（`http://192.168.1.100:47632` / `192.168.1.100:47632` / `192.168.1.100`）。
 * @param defaultPort ポート未指定時に補う既定ポート（config.port）。
 * @returns 正規化した `http://host:port`。
 * @throws {Error} URL として解釈できない場合。
 */
export function normalizeEndpointUrl(input: string, defaultPort: number): string {
  const withScheme = /^https?:\/\//.test(input.trim()) ? input.trim() : `http://${input.trim()}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(
      `monomi pair: invalid --hub value "${input}" (expected http://host:port or host:port)`
    )
  }
  if (url.port === '') {
    url.port = String(defaultPort)
  }
  return `${url.protocol}//${url.host}`
}

/**
 * 試行する hub エンドポイントを優先順で組み立てる（`--hub`（複数可）指定 → 既存 config の順、重複排除 / #4）。
 *
 * `--hub` は指定された順のまま最優先の到達先群として先頭に並べ、続けて既存 `hub_endpoints` を並べる。
 * 両者とも {@link normalizeEndpointUrl} で正規化してから並べる（scheme 無し config 値の対称化 / #2）。
 * これがそのまま成功後に config へ書き戻す `hub_endpoints`（LAN と Tailscale の併記等）にもなる（FR-04）。
 *
 * @param hubOverride `--hub` の入力（複数指定可。未指定なら空配列）。
 * @param configEndpoints 既存 config の `hub_endpoints`（省略可）。
 * @param defaultPort ポート補完に使う config.port。
 * @returns 重複排除済みのエンドポイント URL 配列（優先順）。
 */
function resolveEndpoints(
  hubOverride: string[],
  configEndpoints: string[] | undefined,
  defaultPort: number
): string[] {
  const ordered: string[] = []
  for (const hub of hubOverride) {
    ordered.push(normalizeEndpointUrl(hub, defaultPort))
  }
  for (const endpoint of configEndpoints ?? []) {
    ordered.push(normalizeEndpointUrl(endpoint, defaultPort))
  }
  return [...new Set(ordered)]
}

/**
 * 生 token を `chmod 600` でファイルへ書き出す（child が保存する device_token、§0.3）。
 *
 * @param tokenFile 出力先（`~/.monomi/token`）。
 * @param token 保存する生 token（末尾改行は付けない。reporter が `cat` で読むため）。
 */
function writeTokenFile(tokenFile: string, token: string): void {
  fs.writeFileSync(tokenFile, token, { mode: TOKEN_FILE_MODE })
  fs.chmodSync(tokenFile, TOKEN_FILE_MODE)
}

/**
 * `monomi hub pair`: 起動中の hub に localhost 宛でコード発行を依頼し、コードと到達先候補を表示する
 * （§9 / FR-02 AC-1）。
 *
 * 新しいサーバは起動せず、既存 hub API の `POST /api/v1/pair/start`（loopback 限定）を 1 回叩く。
 * 到達先候補 URL は {@link buildCandidateUrls}（Tailscale 優先）で導出し、別デバイスで
 * `monomi pair --code ... --hub <URL>` を実行する案内を出す。
 *
 * @param deps fetch / paths / network / log の注入。
 * @throws {Error} hub が起動していない（到達不能）か pair/start が拒否された場合。
 */
export async function runHubPair(deps: HubPairDeps): Promise<void> {
  const paths = deps.paths ?? resolvePaths()
  const config = loadConfig(paths)
  const localBaseUrl = `http://127.0.0.1:${config.port}`
  const client = new HubApiClient({ baseUrl: localBaseUrl, fetchImpl: deps.fetchImpl })

  let result: PairStartResponse
  try {
    result = await client.pairStart()
  } catch (err) {
    if (err instanceof PairRejectedError) {
      throw new Error(
        `monomi hub pair: the hub refused pair/start (${err.errorCode}): ${err.message}`
      )
    }
    throw new Error(
      `monomi hub pair: could not reach the local hub at ${localBaseUrl}. ` +
        `Is it running? Start it with \`monomi hub\`.\n(${errorMessage(err)})`
    )
  }

  const minutes = Math.max(1, Math.round(result.ttl_seconds / 60))
  const urls = buildCandidateUrls(config.port, deps.network)

  const lines: string[] = [
    `Pairing code: ${result.code}`,
    `Valid for ${minutes} minute${minutes === 1 ? '' : 's'} (expires ${result.expires_at}).`,
    '',
  ]
  if (urls.length > 0) {
    lines.push('On the other device, run one of:')
    for (const url of urls) {
      lines.push(`  monomi pair --code ${result.code} --hub ${url}`)
    }
  } else {
    lines.push("On the other device, run (replace <hub-ip> with this machine's reachable IP):")
    lines.push(`  monomi pair --code ${result.code} --hub http://<hub-ip>:${config.port}`)
  }
  deps.log(lines.join('\n'))
}

/**
 * `monomi pair --code XXXXXX [--hub ...]`: 到達可能な hub でコードを照合し、token と設定を保存する
 * （§9 / FR-02 AC-3 / FR-05）。
 *
 * エンドポイントを優先順（`--hub` → 既存 config）に順次試行する。hub へ到達できた最初のエンドポイントの
 * 判定を採用し、成功なら token（`chmod 600`）と config（`role: child` / `hub_endpoints` / `device_id`）を
 * 保存する。hub が明示的に拒否した場合（コード失効・不一致 = {@link PairRejectedError}）は確定的失敗として
 * 直ちに中断し、他エンドポイントは試さない。全エンドポイントが到達不能なら試行 URL 一覧つきで失敗する。
 *
 * device_id は既存 config 値を優先し、無ければ hostname から派生する（再ペアリングで id を維持）。
 *
 * @param options `--code` / `--hub` の解析済み引数。
 * @param deps fetch / paths / hostname / log の注入。
 * @throws {Error} エンドポイント未設定・全到達不能・hub 拒否のいずれか。
 */
export async function runChildPair(options: ChildPairOptions, deps: ChildPairDeps): Promise<void> {
  const paths = deps.paths ?? resolvePaths()
  const config = loadConfig(paths)
  const hostname = (deps.hostname ?? os.hostname)()
  const deviceId = config.deviceId ?? deriveDeviceId(hostname)

  const endpoints = resolveEndpoints(options.hub, config.hubEndpoints, config.port)
  if (endpoints.length === 0) {
    throw new Error(
      'monomi pair: no hub endpoint to try. Pass --hub http://<hub-ip>:<port> ' +
        'or set hub_endpoints: in ~/.monomi/config.yml.'
    )
  }

  const payload = { code: options.code, device_id: deviceId, name: hostname }
  const unreachable: string[] = []
  let claimed: PairClaimResponse | undefined
  let claimedVia: string | undefined
  for (const url of endpoints) {
    const client = new HubApiClient({ baseUrl: url, fetchImpl: deps.fetchImpl })
    try {
      claimed = await client.pairClaim(payload)
      claimedVia = url
      break
    } catch (err) {
      if (err instanceof PairRejectedError) {
        throw new Error(`monomi pair: the hub rejected the code (${err.errorCode}): ${err.message}`)
      }
      unreachable.push(url)
    }
  }

  if (claimed === undefined || claimedVia === undefined) {
    throw new Error(
      `monomi pair: could not reach any hub endpoint. Tried:\n${unreachable
        .map((u) => `  - ${u}`)
        .join('\n')}`
    )
  }

  ensureMonomiHome(paths)
  writeTokenFile(paths.tokenFile, claimed.token)
  writeChildPairingConfig(paths.configFile, {
    role: 'child',
    hubEndpoints: endpoints,
    deviceId: claimed.device_id,
  })

  deps.log(
    `Paired as device "${claimed.device_id}" via ${claimedVia}.\n` +
      `Saved token to ${paths.tokenFile} and hub endpoints to ${paths.configFile} (chmod 600).`
  )
}
