declare const epochMsBrand: unique symbol
declare const durationMsBrand: unique symbol

/**
 * UNIX epoch からのミリ秒（§7.2: タイムスタンプは epoch ミリ秒の INTEGER）。
 *
 * 素の `number` のままだと `DurationMs`（経過時間）との取り違えをコンパイラが
 * 検出できないため、branded 型で区別する。生成は {@link toEpochMs} を経由する。
 * 加減算（経過時間の計算等）は status-engine レイヤーの責務であり、ここでは
 * 型のみを定義する（ロジックを持たない）。
 */
export type EpochMs = number & { readonly [epochMsBrand]: true }

/**
 * ミリ秒単位の期間（放置昇格閾値・watch のポーリング間隔等）。`EpochMs` と
 * 取り違えないための branded 型。生成は {@link toDurationMs} を経由する。
 */
export type DurationMs = number & { readonly [durationMsBrand]: true }

/**
 * 素の `number` を {@link EpochMs} としてブランドする。
 *
 * DB から読み出した INTEGER 列や、既に epoch ミリ秒であることが分かっている値を
 * 型システムへ橋渡しするための入り口。
 *
 * @param value epoch ミリ秒。
 * @returns branded な {@link EpochMs}。
 */
export function toEpochMs(value: number): EpochMs {
  return value as EpochMs
}

/**
 * 素の `number` を {@link DurationMs} としてブランドする。
 *
 * @param value ミリ秒単位の期間。
 * @returns branded な {@link DurationMs}。
 */
export function toDurationMs(value: number): DurationMs {
  return value as DurationMs
}

/**
 * 現在時刻を {@link EpochMs} として取得する。
 *
 * @returns `Date.now()` を branding しただけの値。
 */
export function epochMsNow(): EpochMs {
  return toEpochMs(Date.now())
}
