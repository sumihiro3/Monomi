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
  /**
   * reporter からターミナル特定情報が一度でも届いていれば {@link SessionTerminal}、
   * 未着（旧 reporter・非 TTY 実行含む）なら null（release-23 FR-02b）。
   */
  terminal: SessionTerminal | null
}

/**
 * reporter が捕捉したセッション実行中ターミナルの特定情報（release-23 FR-02b）。
 *
 * 毎フックイベントで reporter が送信するスナップショットを最新値でそのまま保持する
 * （`SessionRepository.updateTerminal` が上書き）。個々のフィールドは reporter が
 * 取得できなかった場合 null になりうるが、`seenAt` はスナップショットが一度でも
 * 届いていれば必ず値を持つ（`Session.terminal` 自体が null の場合との違い）。
 */
export interface SessionTerminal {
  /** 解決済み TTY（例 `/dev/ttys003`）。非 TTY 実行や解決失敗時は null。 */
  tty: string | null
  /** `$TERM_PROGRAM`（tmux 内では `tmux` になる）。未設定は null。 */
  termProgram: string | null
  /** `$TMUX_PANE`。tmux 外や未設定は null。 */
  tmuxPane: string | null
  /** `$TMUX` の socket 部分（`${TMUX%%,*}`）。tmux 外や未設定は null。 */
  tmuxSocket: string | null
  /** `$WSL_DISTRO_NAME`。WSL 以外は null。 */
  wslDistro: string | null
  /** `$WT_SESSION`（Windows Terminal）。将来のタブ単位フォーカス用に温存。未設定は null。 */
  wtSession: string | null
  /** `$WEZTERM_PANE`（WezTerm ペイン id）。ペイン単位フォーカスに使う（release-28 FR-02）。未設定は null。 */
  weztermPane: string | null
  /** このスナップショットを hub が受信した時刻。 */
  seenAt: EpochMs
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
 * PR レビュー状態（§7.3 `pr_status` テーブル。release-27 で GitHub poller が書き込む）。
 */
export interface PrStatus {
  id: number
  projectId: string
  branch: string
  prNumber: number | null
  /** `none`/`awaiting_review`/`changes_requested`/`approved`/`merged`。 */
  state: string
  /**
   * Draft PR か（release-27 FR-02）。`state` は Draft でも `'awaiting_review'` のまま
   * （独立した state 列挙値にはしない設計判断。requirements.md スコープ外を参照）。
   */
  isDraft: boolean
  url: string | null
  checkedAt: EpochMs
}
