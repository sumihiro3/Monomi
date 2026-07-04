import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { type DurationMs, toDurationMs } from '../domain/time.js'
import { type MonomiPaths, resolvePaths } from './paths.js'

export type { DurationMs }

/** 待受ポートの既定値。未解決事項として本項目で確定（§非機能要件: localhost バインド）。 */
export const DEFAULT_PORT = 47632

/**
 * config.yml のファイルパーミッション（`chmod 600` 相当 / §0.3・FR-01 AC-3）。
 *
 * child の config には device_token を書き込むため、所有者のみ読み書き可能にする。
 * 規約を config レイヤーに一元化し、実際の書き込み（`monomi pair` = FR-02b）が参照する。
 */
export const CONFIG_FILE_MODE = 0o600

/** 期間文字列の書式: 整数 + 単位（`ms`/`s`/`m`/`h`/`d`）。例 `500ms` `3s` `30m` `2h` `1d`。 */
const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * 人間可読な期間文字列をミリ秒へ変換する。
 *
 * 単位の付かない裸の数値は「ミリ秒か秒か」の曖昧さを生むため受け付けない
 * （config では必ず単位付き文字列で書く）。
 *
 * @param input 期間文字列（例 `2h`）。
 * @returns ミリ秒。
 * @throws {Error} 書式に一致しない場合。
 */
export function parseDurationMs(input: string): DurationMs {
  const match = DURATION_RE.exec(input)
  if (!match) {
    throw new Error(
      `invalid duration "${input}": expected an integer with unit ms/s/m/h/d (e.g. "2h", "30m", "500ms")`
    )
  }
  return toDurationMs(Number(match[1]) * DURATION_UNIT_MS[match[2]])
}

/** config.yml の期間フィールド用スキーマ。文字列で受けてミリ秒へ変換する。 */
const durationSchema = z
  .string()
  .regex(DURATION_RE, 'expected a duration like "2h", "30m", "3s", "500ms", or "1d"')
  .transform(parseDurationMs)

/**
 * raw_state 別の放置昇格閾値（ミリ秒）。`docs/design/class-diagram.md` の
 * `EscalationThresholds` 値オブジェクトに対応する。既定は 2h / 6h / 24h / 72h。
 */
export interface EscalationThresholdsConfig {
  active: DurationMs
  approvalWait: DurationMs
  nextWait: DurationMs
  prWait: DurationMs
}

/** hub / child の役割。`hub` は API サーバを起動する側、`child` はそこへ接続する側（§3.1）。 */
export type MonomiRole = 'hub' | 'child'

/**
 * CLI 表示言語（release-9-i18n FR-01）。既定値の解決は `src/i18n/` の `resolveLocale()` が担い、
 * ここでは型とサポート値の集合のみを所有する（`src/i18n/` はこれを import する）。
 */
export type MonomiLocale = 'ja' | 'en'

/** サポートするロケールの一覧（zod スキーマとロケール解決の両方から参照する）。 */
export const LOCALES = ['ja', 'en'] as const

/** ロード・検証済みの Monomi 設定。 */
export interface MonomiConfig {
  /** 役割。既定 `hub`。`child` の場合は {@link hubEndpoints} で到達先を指定する（FR-01）。 */
  role: MonomiRole
  /** hub API の待受ポート。 */
  port: number
  /** device_id。未指定なら hub 起動時に hostname ベースで自動生成する（§9）。 */
  deviceId?: string
  /**
   * child が試行する hub 到達先候補（優先順）。`role: child` のとき必須（§0.2 / FR-04）。
   * 各要素は `http://host:port` 形式の URL 文字列（例 LAN と Tailscale の2併記）。
   */
  hubEndpoints?: string[]
  /** hub の待受バインドアドレスの上書き。既定 `0.0.0.0`（FR-06）。 */
  bind?: string
  /** watch モードのポーリング間隔（ミリ秒）。既定 3s。 */
  watchIntervalMs: DurationMs
  /** 放置昇格閾値。 */
  escalationThresholds: EscalationThresholdsConfig
  /**
   * CLI 表示言語。未設定は `undefined` のまま通す（既定 `en` への解決は
   * `src/i18n/` の `resolveLocale()` に委譲する。§release-9-i18n FR-01 AC-2）。
   */
  locale?: MonomiLocale
}

/**
 * config.yml の生スキーマ（YAML のキーは snake_case）。
 * `prefault` を使い、キー欠落時にも既定値を transform（文字列→ミリ秒）に通す。
 * 未知キーは既定で除去され、release-2 で増えるフィールドと前方互換になる。
 */
const rawConfigSchema = z.object({
  role: z.enum(['hub', 'child']).default('hub'),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  device_id: z.string().min(1).optional(),
  // reporter（bash）は sed で行単位に読むため、YAML のブロックシーケンス記法
  //   hub_endpoints:
  //     - http://192.168.1.100:47632
  //     - http://100.64.0.1:47632
  // を採用する（`- ` プレフィックス + 1 行 1 URL）。フロー記法 `[a, b]` は使わない。
  hub_endpoints: z.array(z.string()).optional(),
  // hub の待受アドレス上書き。既定は serve 側の 0.0.0.0（FR-06）。
  bind: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
  watch_interval: durationSchema.prefault('3s'),
  escalation_thresholds: z
    .object({
      active: durationSchema.prefault('2h'),
      approval_wait: durationSchema.prefault('6h'),
      next_wait: durationSchema.prefault('24h'),
      pr_wait: durationSchema.prefault('72h'),
    })
    .prefault({}),
})

/**
 * 検証済み設定オブジェクトから公開用の {@link MonomiConfig}（camelCase）へ変換する。
 * zod の透過的な transform ではなく明示関数にして、snake→camel の対応を一箇所に集約する。
 */
function toMonomiConfig(raw: z.infer<typeof rawConfigSchema>): MonomiConfig {
  return {
    role: raw.role,
    port: raw.port,
    deviceId: raw.device_id,
    hubEndpoints: raw.hub_endpoints,
    bind: raw.bind,
    locale: raw.locale,
    watchIntervalMs: raw.watch_interval,
    escalationThresholds: {
      active: raw.escalation_thresholds.active,
      approvalWait: raw.escalation_thresholds.approval_wait,
      nextWait: raw.escalation_thresholds.next_wait,
      prWait: raw.escalation_thresholds.pr_wait,
    },
  }
}

/**
 * YAML 由来の任意オブジェクトを検証し、既定値を補完した {@link MonomiConfig} を返す。
 *
 * `null`/`undefined`（空の config.yml など）は空オブジェクト扱いにして全項目を既定値で埋める。
 *
 * @param input YAML パース結果などの任意値。
 * @returns 検証・既定値補完済みの設定。
 * @throws {z.ZodError} 型や書式が不正な場合。
 */
export function parseConfig(input: unknown): MonomiConfig {
  const raw = rawConfigSchema.parse(input ?? {})
  return toMonomiConfig(raw)
}

/**
 * `locale` フィールドのみを検証するスキーマ（release-9-i18n review-changes 修正）。
 *
 * `rawConfigSchema` は未知キーを既定で除去するだけで他フィールドの妥当性チェックは避けられない
 * ため、`locale` 以外のフィールドが不正な config.yml（例 `port: abc`）だと {@link loadLocale} まで
 * 巻き込まれて失敗し、--help/--version のようなロケール解決だけで足りるコマンドまで落ちてしまう。
 * `locale` だけを検証する軽量スキーマで独立させることでこれを避ける。
 */
const localeOnlySchema = z.object({ locale: z.enum(LOCALES).optional() })

/**
 * YAML テキストをパースして設定を返す。ファイル I/O を伴わないので単体テストしやすい。
 *
 * @param yamlText config.yml の中身。
 * @returns 検証・既定値補完済みの設定。
 */
export function loadConfigFromYaml(yamlText: string): MonomiConfig {
  return parseConfig(parseYaml(yamlText))
}

/**
 * `~/.monomi/config.yml` を読み込んで設定を返す。ファイルが無い場合は全項目を既定値にする。
 *
 * @param paths パス集合（省略時は {@link resolvePaths} で解決）。
 * @returns 検証・既定値補完済みの設定。
 */
export function loadConfig(paths: MonomiPaths = resolvePaths()): MonomiConfig {
  if (!fs.existsSync(paths.configFile)) {
    return parseConfig({})
  }
  const text = fs.readFileSync(paths.configFile, 'utf8')
  return loadConfigFromYaml(text)
}

/**
 * `~/.monomi/config.yml` から `locale` フィールドのみを検証・解決する（release-9-i18n
 * review-changes 修正）。{@link loadConfig} と異なりスキーマ全体を検証しないため、`locale` と
 * 無関係なフィールドが不正な config.yml でも、ロケール解決だけで足りるコマンド（--help/--version
 * 等）を巻き込んで失敗させない。`locale` 自体が不正な値（`ja`/`en` 以外）の場合は引き続き
 * {@link z.ZodError} を投げる（他フィールドが必要なコマンドは {@link loadConfig} 側で検証される）。
 *
 * @param paths パス集合（省略時は {@link resolvePaths} で解決）。
 * @returns config.yml の `locale`（ファイル無し・未設定なら `undefined`）。
 * @throws {z.ZodError} `locale` の値が `ja`/`en` 以外の場合。
 */
export function loadLocale(paths: MonomiPaths = resolvePaths()): MonomiLocale | undefined {
  if (!fs.existsSync(paths.configFile)) {
    return undefined
  }
  const text = fs.readFileSync(paths.configFile, 'utf8')
  return localeOnlySchema.parse(parseYaml(text) ?? {}).locale
}
