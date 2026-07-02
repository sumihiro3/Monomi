import type { Device } from '../domain/entities.js'
import type { TokenService } from './token-service.js'

/**
 * `AuthResolver` が読み取る最小限のリクエスト形状。
 *
 * Node の `http.IncomingMessage`（`headers.authorization: string | undefined`）と構造的に
 * 互換で、HTTP レイヤーへ依存せず単体テストできるようにするための入力インターフェース。
 */
export interface AuthResolvableRequest {
  headers: { authorization?: string | undefined }
}

/**
 * `Authorization: Bearer <token>` ヘッダから生トークンを取り出す。
 *
 * スキーム名は大文字小文字を無視し、前後の空白は取り除く。ヘッダが無い・`Bearer` 形式で
 * ない場合は `null` を返す。
 *
 * @param authorization `Authorization` ヘッダの値。
 * @returns 生トークン、または抽出できなければ `null`。
 */
function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim())
  return match ? match[1].trim() : null
}

/**
 * Bearer トークンからリクエスト元 device を解決するミドルウェア（class-diagram §3）。
 *
 * ヘッダ欠落・不正形式・無効/失効トークンはいずれも認証失敗を表す `null` を返す。401 化は
 * 後段の Controller の責務であり、ここでは判定のみ行う（§0.3: 認証失敗の一元判定）。
 */
export class AuthResolver {
  constructor(private readonly tokens: TokenService) {}

  /**
   * リクエストの `Authorization` ヘッダから device を解決する。
   *
   * @param request `headers.authorization` を持つリクエスト様オブジェクト。
   * @returns 有効な {@link Device}、認証失敗なら `null`。
   */
  resolveDevice(request: AuthResolvableRequest): Device | null {
    const rawToken = extractBearerToken(request.headers.authorization)
    if (rawToken === null) {
      return null
    }
    return this.tokens.verify(rawToken)
  }
}
