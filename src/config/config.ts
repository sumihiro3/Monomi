import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { toDurationMs, type DurationMs } from '../domain/time.js'
import { resolvePaths, type MonomiPaths } from './paths.js'

export type { DurationMs }

/** 待受ポートの既定値。未解決事項として本項目で確定（§非機能要件: localhost バインド）。 */
export const DEFAULT_PORT = 47632

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

/** ロード・検証済みの Monomi 設定。 */
export interface MonomiConfig {
  /** v1 は `hub` 固定（child 解決ロジックは release-2）。 */
  role: 'hub'
  /** hub API の待受ポート。 */
  port: number
  /** device_id。未指定なら hub 起動時に hostname ベースで自動生成する（§9）。 */
  deviceId?: string
  /** watch モードのポーリング間隔（ミリ秒）。既定 3s。 */
  watchIntervalMs: DurationMs
  /** 放置昇格閾値。 */
  escalationThresholds: EscalationThresholdsConfig
}

/**
 * config.yml の生スキーマ（YAML のキーは snake_case）。
 * `prefault` を使い、キー欠落時にも既定値を transform（文字列→ミリ秒）に通す。
 * 未知キーは既定で除去され、release-2 で増えるフィールドと前方互換になる。
 */
const rawConfigSchema = z.object({
  role: z.literal('hub').default('hub'),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  device_id: z.string().min(1).optional(),
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
