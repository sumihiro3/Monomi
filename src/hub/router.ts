import type { Device } from '../domain/entities.js'

/**
 * Controller へ渡すリクエストの共通部分（HTTP レイヤーから切り離した薄い入力型）。
 *
 * ルーティング（path param 抽出）・ボディの JSON パースは {@link ../http-server.js HttpServer}
 * の前段パイプラインが済ませ、Controller はここに詰まった値だけを扱う。node の `http` 型に
 * 依存しないため Controller は単体テストしやすい。認証の有無（device の nullability）は
 * {@link HubRequest}（認証必須ルート）と {@link PublicHubRequest}（public ルート）で分岐する。
 */
export interface HubRequestBase {
  /** path テンプレートの `:name` から抽出したパラメータ（例 `{ id: 'inst_01' }`）。 */
  params: Record<string, string>
  /** JSON パース済みのリクエストボディ。ボディが無い/GET 等では `undefined`。 */
  body: unknown
  /**
   * 生 TCP 接続の送信元アドレス（`socket.remoteAddress`、§0.3）。`X-Forwarded-For` は
   * 一切参照しない。ソケットが確定していない等で不明な場合は `null`。loopback 判定（`pair/start`）
   * のような、認証済み device では表現できない生リクエスト文脈を Controller へ渡すために持つ。
   */
  remoteAddress: string | null
}

/**
 * Controller へ渡す認証済みリクエスト（認証必須ルート用）。
 *
 * 認証（Bearer → device 解決）は HttpServer 前段が済ませ、`device` は必ず非 null の権威値
 * （§0.3: Bearer トークンから解決）になる。既存の全 Controller はこの型を受け取る。
 */
export interface HubRequest extends HubRequestBase {
  /** 認証済みの送信元 device（§0.3: Bearer トークンから解決した権威値）。 */
  device: Device
}

/**
 * Controller へ渡す未認証許容リクエスト（public ルート用）。
 *
 * `pair/start`（loopback のみ・未認証）/ `pair/claim`（未認証）のように認証をスキップする
 * ルート向け。認証を行わないため `device` は `null` になり得る。Controller は `remoteAddress`
 * 等の生文脈で認可判断を行う。
 */
export interface PublicHubRequest extends HubRequestBase {
  /** 送信元 device。public ルートは認証をスキップするため常に `null`。 */
  device: Device | null
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

/** 認証必須ルートで実行されるハンドラ（`device` は非 null 保証）。 */
export type RouteHandler = (req: HubRequest) => HubResponse | Promise<HubResponse>

/** public ルートで実行されるハンドラ（`device` は null になり得る）。 */
export type PublicRouteHandler = (req: PublicHubRequest) => HubResponse | Promise<HubResponse>

/** ルート登録時のオプション。 */
export interface RouteOptions {
  /**
   * 認証をスキップする public ルートか（§0.3 / FR-02）。`true` のとき HttpServer は
   * `resolveDevice` を呼ばず、ハンドラへ `device: null` を渡す。省略時は認証必須。
   */
  public?: boolean
}

/**
 * {@link Router.match} の結果。ルート一致／メソッド不一致／未一致を区別する。
 *
 * 一致時は `public` フラグでハンドラ型を判別可能なユニオンにし、HttpServer が
 * 認証必須ルート（`device: Device`）と public ルート（`device: Device | null`）を
 * 型安全に振り分けられるようにする。
 */
export type RouteMatch =
  | { kind: 'matched'; public: false; handler: RouteHandler; params: Record<string, string> }
  | { kind: 'matched'; public: true; handler: PublicRouteHandler; params: Record<string, string> }
  | { kind: 'method_not_allowed' }
  | { kind: 'not_found' }

/** コンパイル済みルート（path テンプレートを正規表現へ展開したもの）。 */
interface CompiledRoute {
  method: string
  regex: RegExp
  paramNames: string[]
  handler: RouteHandler | PublicRouteHandler
  public: boolean
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
   * 認証必須ルートを登録する。
   *
   * @param method HTTP メソッド（大文字。`GET`/`POST` 等）。
   * @param pattern path テンプレート（`:name` でパラメータを表す）。
   * @param handler 一致時に実行するハンドラ（`device` は非 null）。
   * @param options 省略、または `{ public: false }`。
   * @returns 連鎖登録用に自身を返す。
   */
  add(method: string, pattern: string, handler: RouteHandler, options?: { public?: false }): this
  /**
   * public（未認証許容）ルートを登録する。ハンドラは `device: null` を受け付ける必要がある。
   *
   * @param method HTTP メソッド。
   * @param pattern path テンプレート。
   * @param handler 一致時に実行するハンドラ（`device` は null になり得る）。
   * @param options `{ public: true }`。
   * @returns 連鎖登録用に自身を返す。
   */
  add(method: string, pattern: string, handler: PublicRouteHandler, options: { public: true }): this
  add(
    method: string,
    pattern: string,
    handler: RouteHandler | PublicRouteHandler,
    options: RouteOptions = {}
  ): this {
    const { regex, paramNames } = compilePattern(pattern)
    this.routes.push({
      method: method.toUpperCase(),
      regex,
      paramNames,
      handler,
      public: options.public ?? false,
    })
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
      try {
        route.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(captures[index + 1])
        })
      } catch {
        // 不正な percent-encoding（例 `%ZZ`）は decodeURIComponent が例外を投げる。
        // 500 化を避け、他の未一致分岐と同型の 404 として扱う（§8.1 / review #10）。
        return { kind: 'not_found' }
      }
      // ストレージ上はユニオン型。public フラグでハンドラ型を判別可能な結果へ振り分ける。
      return route.public
        ? { kind: 'matched', public: true, handler: route.handler as PublicRouteHandler, params }
        : { kind: 'matched', public: false, handler: route.handler as RouteHandler, params }
    }

    return pathMatchedButWrongMethod ? { kind: 'method_not_allowed' } : { kind: 'not_found' }
  }
}
