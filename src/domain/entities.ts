import type { DeviceRole, EventType, ProjectKeyKind } from './enums.js'
import type { EpochMs } from './time.js'

/**
 * 正規化済みプロジェクト識別子（§0.1: `ProjectKeyNormalizer` の出力）。
 *
 * 正規化ロジック自体はこの型に含めない。値オブジェクトの形だけをここで定義し、
 * 生成は domain-model の別項目である `ProjectKeyNormalizer`（正規化ドメインサービス）
 * に閉じ込める。
 */
export interface ProjectKey {
  /** 正規化済みの文字列表現（例 `github.com/owner/repo`、`local:{device_id}:...`）。 */
  value: string
  kind: ProjectKeyKind
}

/**
 * レポート送信元デバイス（§7.3 `devices` テーブル）。
 */
export interface Device {
  /** config.yml の `device_id`（未指定なら hostname ベースで自動生成、§9）。 */
  id: string
  name: string
  role: DeviceRole
  firstSeenAt: EpochMs
  lastSeenAt: EpochMs
}

/**
 * 論理プロジェクト（git remote / common-dir 単位。§7.3 `projects` テーブル）。
 */
export interface Project {
  id: string
  projectKey: ProjectKey
  /** 未設定なら `project_key` から自動生成される表示用エイリアス（DDL: nullable）。 */
  displayName: string | null
  createdAt: EpochMs
}

/**
 * ディレクトリ単位のインスタンス（§7.1: worktree の有無に関わらず同じ扱い。
 * §7.3 `instances` テーブル）。
 */
export interface Instance {
  id: string
  projectId: string
  deviceId: string
  /** git toplevel。非 git なら cwd そのもの。 */
  path: string
  /** 非 git なら null。 */
  branch: string | null
  createdAt: EpochMs
  /** `WorktreeRemove` 等で埋まる。未削除なら null。 */
  removedAt: EpochMs | null
}

/**
 * Claude Code（等）のセッション（1 instance につき履歴として N 件。§7.3 `sessions`）。
 */
export interface Session {
  /** エージェント側の session_id。 */
  id: string
  instanceId: string
  /** v1 は `'claude_code'` 固定（§7.4）。将来 Codex 等を追加する受け皿。 */
  agentType: string
  /**
   * PID は hook payload に含まれないため（§0.5）、reporter が `$PPID` 系譜を
   * 辿って充填するまでは null。release-1 はライブネス検知スコープ外のため
   * 常に null のままでもよい。
   */
  pid: number | null
  startedAt: EpochMs
  /** 終了前は null。 */
  endedAt: EpochMs | null
  /** `clear`/`logout`/`prompt_input_exit`/`session_lost`/`other`。終了前は null。 */
  endReason: string | null
  /**
   * release-1 はハートビート未実装（§0.4 v1延期）のため常に null になる想定だが、
   * DDL 上の列として保持する。
   */
  lastHeartbeatAt: EpochMs | null
}

/**
 * 生イベントログ（status 導出 + Agent View 用の活動フィード。§7.3 `events` テーブル）。
 */
export interface Event {
  /** autoincrement な行 ID。 */
  id: number
  sessionId: string
  /** 非正規化列。最新状態クエリで JOIN を省くため（§7.3 注記）。 */
  instanceId: string
  eventType: EventType
  /** 例: `Notification` の matcher（`idle_prompt`/`permission_prompt`）。 */
  eventSubtype: string | null
  /** `PreToolUse`/`PostToolUse` のみ。 */
  toolName: string | null
  /** 切り詰めた tool_input（ファイルパス/コマンド先頭）。 */
  toolSummary: string | null
  /** レポーター（クライアント）側の時刻。 */
  occurredAt: EpochMs
  /**
   * hub がリクエストを受信した時刻。§0.5 により経過時間計算の権威時刻はこちら
   * （各デバイスのクロックスキューを排除するため）。
   */
  receivedAt: EpochMs
}

/**
 * デバイス認証用トークン（§0.3）。生 token は保存せず SHA-256 ハッシュのみ保持する。
 */
export interface DeviceToken {
  id: number
  deviceId: string
  /** SHA-256(token)。生 token は保存しない。 */
  tokenHash: string
  createdAt: EpochMs
  /** revoke 時刻。null なら有効。 */
  revokedAt: EpochMs | null
}

/**
 * PR レビュー状態（§7.3 `pr_status` テーブル）。
 *
 * release-1 は GitHub poller 未実装のためテーブルは作成されるが行は増えない
 * （`InstanceStatusService` が返す `hasPrWaiting` は常に false、§0.4 v1延期）。
 */
export interface PrStatus {
  id: number
  projectId: string
  branch: string
  prNumber: number | null
  /** `none`/`awaiting_review`/`changes_requested`/`approved`/`merged`。 */
  state: string
  url: string | null
  checkedAt: EpochMs
}
