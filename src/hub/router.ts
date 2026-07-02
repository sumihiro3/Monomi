import type { Device } from '../domain/entities.js'

/**
 * Controller へ渡す認証済みリクエスト（HTTP レイヤーから切り離した薄い入力型）。
 *
 * 認証（Bearer → device 解決）とルーティング（path param 抽出）・ボディの JSON パースは
 * {@link ../http-server.js HttpServer} の前段パイプラインが済ませ、Controller はここに
 * 詰まった値だけを扱う。node の `http` 型に依存しないため Controller は単体テストしやすい。
 */
export interface HubRequest {
  /** path テンプレートの `:name` から抽出したパラメータ（例 `{ id: 'inst_01' }`）。 */
  params: Record<string, string>
  /** JSON パース済みのリクエストボディ。ボディが無い/GET 等では `undefined`。 */
  body: unknown
  /** 認証済みの送信元 device（§0.3: Bearer トークンから解決した権威値）。 */
  device: Device
}

/**
 * Controller が返す HTTP 応答（薄い値オブジェクト）。
 *
 * `body` は {@link ../http-server.js HttpServer} が `JSON.stringify` して書き出す。
 */
export interface HubResponse {
  /** HTTP ステータスコード。 */
  status: number
  /** 応答ボディ（JSON へシリアライズされる）。 */
  body: unknown
  /** 追加で付与する応答ヘッダ（省略可）。 */
  headers?: Record<string, string>
}

/** ルートにマッチしたときに実行されるハンドラ（Controller メソッドを束ねる）。 */
export type RouteHandler = (req: HubRequest) => HubResponse | Promise<HubResponse>

/** {@link Router.match} の結果。ルート一致／メソッド不一致／未一致を区別する。 */
export type RouteMatch =
  | { kind: 'matched'; handler: RouteHandler; params: Record<string, string> }
  | { kind: 'method_not_allowed' }
  | { kind: 'not_found' }

/** コンパイル済みルート（path テンプレートを正規表現へ展開したもの）。 */
interface CompiledRoute {
  method: string
  regex: RegExp
  paramNames: string[]
  handler: RouteHandler
}

/**
 * path テンプレート（例 `/api/v1/instances/:id`）を正規表現とパラメータ名へコンパイルする。
 *
 * `:name` セグメントは 1 セグメント分（スラッシュを含まない 1 文字以上）を捕捉する。
 * それ以外のセグメントは正規表現メタ文字をエスケープして完全一致させる。
 *
 * @param pattern path テンプレート。
 * @returns 正規表現と、出現順のパラメータ名。
 */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const segments = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) {
      paramNames.push(segment.slice(1))
      return '([^/]+)'
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  return { regex: new RegExp(`^${segments.join('/')}$`), paramNames }
}

/**
 * メソッド + path テンプレートでルートを引く最小ルーター（class-diagram §3 の routing 責務）。
 *
 * release-1 の 3 ルート（`POST /api/v1/events` / `GET /api/v1/instances` /
 * `GET /api/v1/instances/:id`）を賄うだけの単純な線形マッチ。個人利用規模なので
 * trie 等の最適化は行わない。path は一致するがメソッドが違う場合を `method_not_allowed`
 * として区別し、正しい 405/404 を返せるようにする。
 */
export class Router {
  private readonly routes: CompiledRoute[] = []

  /**
   * ルートを登録する。
   *
   * @param method HTTP メソッド（大文字。`GET`/`POST` 等）。
   * @param pattern path テンプレート（`:name` でパラメータを表す）。
   * @param handler 一致時に実行するハンドラ。
   * @returns 連鎖登録用に自身を返す。
   */
  add(method: string, pattern: string, handler: RouteHandler): this {
    const { regex, paramNames } = compilePattern(pattern)
    this.routes.push({ method: method.toUpperCase(), regex, paramNames, handler })
    return this
  }

  /**
   * メソッド + path に一致するルートを探す。
   *
   * path は一致するがメソッドが違う場合は `method_not_allowed`、どのルートにも一致しない
   * 場合は `not_found` を返す。
   *
   * @param method リクエストの HTTP メソッド。
   * @param path リクエストの path（クエリを除いた pathname）。
   * @returns 一致結果（{@link RouteMatch}）。
   */
  match(method: string, path: string): RouteMatch {
    const upperMethod = method.toUpperCase()
    let pathMatchedButWrongMethod = false

    for (const route of this.routes) {
      const captures = route.regex.exec(path)
      if (captures === null) {
        continue
      }
      if (route.method !== upperMethod) {
        pathMatchedButWrongMethod = true
        continue
      }
      const params: Record<string, string> = {}
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(captures[index + 1])
      })
      return { kind: 'matched', handler: route.handler, params }
    }

    return pathMatchedButWrongMethod ? { kind: 'method_not_allowed' } : { kind: 'not_found' }
  }
}
