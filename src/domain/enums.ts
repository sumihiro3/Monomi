/**
 * Claude Code フック起因のイベント種別（§7.3 `events.event_type` に対応）。
 *
 * `PermissionRequest` は含まない（§0.5: 同期ゲートを観測用 POST で遅延させないため、
 * `Notification`(matcher `permission_prompt`) に一本化）。`WorktreeCreate`/
 * `WorktreeRemove` は instance 登録の補助情報、`session_lost` はライブネス検知
 * （release-1 ではスコープ外、§0.4）が発生させる想定の値で、将来の拡張に備えて
 * 列挙にだけ含めておく。
 */
export const EVENT_TYPES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
  'WorktreeCreate',
  'WorktreeRemove',
  'session_lost',
] as const

/** {@link EVENT_TYPES} のいずれか。 */
export type EventType = (typeof EVENT_TYPES)[number]

/**
 * デバイスの役割（§3.1: どのマシンも hub になれる）。
 *
 * release-1 は `HUB` 固定で運用する（`role: child` の解決は release-2）が、
 * DB 上は `CHECK(role IN ('hub','child'))` として両方を許容するため、値としては
 * `CHILD` も先に定義しておく。
 */
export const DEVICE_ROLES = ['HUB', 'CHILD'] as const

/** {@link DEVICE_ROLES} のいずれか。 */
export type DeviceRole = (typeof DEVICE_ROLES)[number]

/**
 * イベント列から導出される session の内部状態（§4/§0.5）。
 *
 * `Notification(permission_prompt)` → `APPROVAL_WAIT`、`Notification(idle_prompt)` →
 * `NEXT_WAIT`、`SessionEnd` → `CLOSED`、それ以外の稼働系イベントは `ACTIVE`。
 */
export const RAW_STATES = ['ACTIVE', 'APPROVAL_WAIT', 'NEXT_WAIT', 'CLOSED'] as const

/** {@link RAW_STATES} のいずれか。 */
export type RawState = (typeof RAW_STATES)[number]

/**
 * CLI/API が表示する状態（§5.2 優先順位: 放置 > 権限待ち > PR待ち > 次の指示待ち > 稼働中）。
 *
 * {@link RawState} に対して `PR_WAIT`（GitHub poller 由来）と `STALE`（放置への昇格）が
 * 追加される一方、`CLOSED` は非表示（§5.1）のため含まない。
 */
export const DISPLAY_STATUSES = [
  'ACTIVE',
  'APPROVAL_WAIT',
  'NEXT_WAIT',
  'PR_WAIT',
  'STALE',
] as const

/** {@link DISPLAY_STATUSES} のいずれか。 */
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number]

/**
 * `project_key` の由来（§0.1）。remote の有無・git の有無でクロスデバイス融合の
 * 可否が変わる（`GIT_REMOTE` のみ複数デバイス間で同一 key に融合しうる）。
 */
export const PROJECT_KEY_KINDS = ['GIT_REMOTE', 'LOCAL_NO_REMOTE', 'NO_GIT'] as const

/** {@link PROJECT_KEY_KINDS} のいずれか。 */
export type ProjectKeyKind = (typeof PROJECT_KEY_KINDS)[number]
