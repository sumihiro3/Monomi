/** IPv4-mapped IPv6 のプレフィックス（`::ffff:127.0.0.1` を素の IPv4 へ畳むため）。 */
const IPV4_MAPPED_PREFIX = '::ffff:'

/** IPv4 loopback（`127.0.0.0/8`）の判定パターン。 */
const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * 生 TCP 接続の送信元アドレスが loopback かを判定する（FR-02 AC-2 / FR-03）。
 *
 * `127.0.0.0/8`・IPv6 `::1`・IPv4-mapped(`::ffff:127.0.0.1`) を loopback とみなす。
 * `X-Forwarded-For` は {@link ./http-server.js HttpServer} 前段で既に無視されており（§0.3）、
 * ここは `socket.remoteAddress` 由来の値だけを見る。不明（`null`）は非 loopback 扱いで拒否する。
 *
 * {@link ./controllers/pair-controller.js PairController}（`pair/start`）と
 * {@link ./controllers/devices-controller.js DevicesController}（`devices` 管理ルート）の双方が
 * 参照する共有モジュール。controller 間の直 import を避けるため hub レイヤー直下に置く
 * （§5.2 review #6 と同じ越境回避方針）。
 *
 * @param address `req.remoteAddress`（`socket.remoteAddress`）の値。
 * @returns loopback なら true。
 */
export function isLoopbackAddress(address: string | null): boolean {
  if (address === null) {
    return false
  }
  if (address === '::1') {
    return true
  }
  const ipv4 = address.startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address
  return IPV4_LOOPBACK_RE.test(ipv4)
}
