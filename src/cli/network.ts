import { execFileSync } from 'node:child_process'
import os from 'node:os'

/**
 * 到達先候補ホストの分類（§0.2 マルチエンドポイント: LAN / Tailscale）。
 *
 * `tailscale` は Tailscale の 100.64.0.0/10（CGNAT）レンジに属する IP で、NAT/ファイアウォールを
 * 越えて別デバイスから到達しやすいため、候補提示時に **LAN より優先**する。
 */
export interface NetworkCandidate {
  /** 到達先 IPv4 アドレス。 */
  host: string
  /** 分類ラベル（表示・並び順に使う）。 */
  label: 'tailscale' | 'lan'
}

/** {@link detectReachableHosts} の依存注入点（テストで networkInterfaces / tailscale CLI を差し替える）。 */
export interface NetworkDetectOptions {
  /** `os.networkInterfaces` の差し替え（省略時は実 `os.networkInterfaces`）。 */
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
  /**
   * `tailscale ip -4` 相当のフォールバック。networkInterfaces から Tailscale IP を
   * 検出できなかったときだけ呼ぶ。IP 配列（0 件可）を返し、実行失敗時は `null` を返す。
   * 省略時は実コマンド {@link runTailscaleIp} を使う。
   */
  tailscaleIp?: () => string[] | null
}

/** ドット区切り IPv4（`a.b.c.d`）の判定。IPv6 や不正文字列を除外するために使う。 */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * IPv4 文字列が Tailscale の 100.64.0.0/10（CGNAT）レンジに属するか判定する。
 *
 * 100.64.0.0/10 は第1オクテット 100・第2オクテット 64〜127。Tailscale はこのレンジから
 * 各ノードへ安定した IP を割り当てるため、到達先の第一候補判定に使う（未解決事項の確定）。
 *
 * @param address IPv4 ドット区切り文字列。
 * @returns Tailscale レンジなら true。
 */
export function isTailscaleIpv4(address: string): boolean {
  const m = IPV4_RE.exec(address)
  if (m === null) {
    return false
  }
  const octet1 = Number(m[1])
  const octet2 = Number(m[2])
  return octet1 === 100 && octet2 >= 64 && octet2 <= 127
}

/**
 * `tailscale ip -4` を実行して IPv4 を取得する（フォールバック用の実コマンド）。
 *
 * Tailscale が split-DNS 等の理由で `os.networkInterfaces` に現れないケースの保険。CLI が無い/
 * 未ログイン等で失敗したら握りつぶして `null` を返す（候補が無いだけで致命的ではない）。
 *
 * @returns 取得できた Tailscale IPv4 の配列、または実行失敗時 `null`。
 */
function runTailscaleIp(): string[] | null {
  try {
    const out = execFileSync('tailscale', ['ip', '-4'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => IPV4_RE.test(line))
  } catch {
    return null
  }
}

/**
 * このマシンの非ループバック IPv4 到達先候補を検出する（`monomi hub pair` の候補 URL 提示用）。
 *
 * 手順:
 * 1. `os.networkInterfaces()` から `internal === false` の IPv4 のみ抽出（IPv6 と loopback は除外）。
 * 2. 100.64.0.0/10 に属するものを `tailscale`、それ以外を `lan` に分類。
 * 3. Tailscale IP が 1 件も無ければ `tailscale ip -4` フォールバックを 1 回だけ試す。
 * 4. Tailscale を先、LAN を後にして重複排除した候補リストを返す（別デバイスから到達しやすい順）。
 *
 * @param options networkInterfaces / tailscale CLI の差し替え（省略可）。
 * @returns 到達先候補の配列（0 件になり得る＝手動 `--hub` 指定が必要）。
 */
export function detectReachableHosts(options: NetworkDetectOptions = {}): NetworkCandidate[] {
  const getInterfaces = options.networkInterfaces ?? (() => os.networkInterfaces())
  const tailscaleFallback = options.tailscaleIp ?? runTailscaleIp

  const tailscale: string[] = []
  const lan: string[] = []

  for (const infos of Object.values(getInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal || !IPV4_RE.test(info.address)) {
        continue
      }
      if (isTailscaleIpv4(info.address)) {
        tailscale.push(info.address)
      } else {
        lan.push(info.address)
      }
    }
  }

  if (tailscale.length === 0) {
    const fallback = tailscaleFallback()
    if (fallback !== null) {
      for (const ip of fallback) {
        if (isTailscaleIpv4(ip)) {
          tailscale.push(ip)
        }
      }
    }
  }

  const seen = new Set<string>()
  const candidates: NetworkCandidate[] = []
  for (const host of tailscale) {
    if (!seen.has(host)) {
      seen.add(host)
      candidates.push({ host, label: 'tailscale' })
    }
  }
  for (const host of lan) {
    if (!seen.has(host)) {
      seen.add(host)
      candidates.push({ host, label: 'lan' })
    }
  }
  return candidates
}

/**
 * 検出した到達先候補を `http://host:port` の URL 文字列へ整形する（Tailscale 優先の順序を保つ）。
 *
 * @param port hub の待受ポート。
 * @param options {@link detectReachableHosts} へ委譲する検出依存（省略可）。
 * @returns 候補 URL の配列（{@link detectReachableHosts} と同じ並び）。
 */
export function buildCandidateUrls(port: number, options: NetworkDetectOptions = {}): string[] {
  return detectReachableHosts(options).map((c) => `http://${c.host}:${port}`)
}
