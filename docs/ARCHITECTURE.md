# Monomi アーキテクチャ

> 本ドキュメントが Monomi の現行アーキテクチャの権威仕様。設計・検討の経緯（命名決定、要求の背景、Codex 対応調査、当初の未着手事項）は `monomi-handoff.md`（凍結）を参照する。
>
> 記述は実装ソース（`src/`・`reporter/`）を正とし、両者に齟齬がある場合は実装を正とする。

Monomi は、複数デバイス・複数プロジェクトで Claude Code を並行運用する際に、各プロジェクトの状態（稼働中／権限待ち／次の指示待ち／PR レビュー待ち／放置）を横断確認できる CLI ダッシュボードである。構成は次の 3 レイヤー。

- **reporter**（bash、macOS/Linux/WSL2）: Claude Code フックから発火し、状態イベントを hub へ POST する。
- **hub**（素の Node.js + SQLite）: イベントを集約・正規化し、status を導出して API で返す。`monomi` 実行時に不在なら自己修復的に自動起動し（release-18 FR-01、§2.3）、以後 detached で常駐する。
- **CLI**（Ink）: hub API をポーリングしてターミナルにダッシュボードを描画する。

---

## 1. 確定仕様の要点（handoff §0）

実装前レビューで確定し、以降の設計より優先される中核方針。実装はすべてこれに準拠している。

- **project_key 正規化を hub 側に一本化**（§0.1）: reporter は `git remote get-url origin` の生出力をそのまま送り、正規化は hub 側の唯一の Node 実装（`ProjectKeyNormalizer`）で行う。bash / PowerShell へ正規化を二重実装しない。表記ゆれで同一リポジトリが横断ダッシュボードで複数行に割れるのを防ぐため。
- **書き込み経路の耐障害性**（§0.2）: child は hub 到達先を複数併記（LAN / Tailscale 等）し、reporter は順に試して到達できた先へ POST する。全滅時のみ状態遷移イベントをローカル `~/.monomi/outbox/*.json` へ退避し、次回発火でまとめて再送する。
- **認証となりすまし書き込み防止**（§0.3）: `tokens` テーブルで Bearer トークンを SHA-256 保存（生トークンは保存しない）。各リクエストはトークンから `device_id` を導出し、ボディの `device_id` 指定は無視する。ペアリングコードは失敗 5 回で即無効化・成功で単発破棄。`chmod 600` で token / config / SQLite DB ファイルを保護し、これらを格納する `~/.monomi` ディレクトリ自体も `chmod 700`（`HOME_DIR_MODE`）に固定する。ルート作成は `serve`/`bootstrap`/`pairing-client` の3箇所が共通ヘルパー `ensureMonomiHome()`（`src/config/paths.ts`）を通して行い、新規・既存いずれのディレクトリにも起動のたび無条件に `chmod` を適用する（release-13、既知課題 S1 解消）。
- **status 導出の補正**（§0.5）: 権限待ちの観測は `Notification`(matcher `permission_prompt`) を用いる。raw_state は session 単位で導出し、instance 代表は最も新しい `lastEventAt` を持つ session を無条件で選ぶ（完全同時刻のみ優先度でタイブレーク。release-8 で優先度優先から recency 優先へ変更、§5.5）。closed が active を覆い隠さない不変条件は recency 優先化後も維持する。経過時間の起点は「現 raw_state 連続区間の最初のイベント時刻」、権威時刻は hub の `received_at`（クロックスキュー排除）。hub は numeric priority も返し、CLI ロールアップは `max()` するだけにする。
- **段階リリース区分**（§0.4）: 単機ウェッジ → 認証ハードニング／2 台目 → CLI ダッシュボードの順に段階リリースする（本節末の対応表を参照）。

---

## 2. 全体アーキテクチャ

```
Claude Code フック（各デバイス）
      ↓
reporter（bash。git 情報を解決し ISO8601 時刻を付けて POST）
      ↓
Hub API（role で hub/child を切り替え。素の Node.js プロセス、`monomi` からの自動起動 + detached 常駐）
      ↓
SQLite（devices / projects / instances / sessions / events / tokens / pr_status を集約）
      ↓
CLI（hub API をポーリングして Ink でターミナル表示）
```

### 2.1 hub / child の役割分担

- 各マシンの `~/.monomi/config.yml` の `role: hub | child` で役割を指定する（既定 `hub`）。
- `role: child` は `hub_endpoints`（到達先 URL の優先順リスト、§0.2）を持ち、reporter は先頭から順試行して到達できた先へ POST する。
- `role: hub` は `localhost` 宛でよく `hub_endpoints` は不要。1 台体制は hub 単体で成立する。2 台目は config を 1 つ足すだけ。
- `monomi hub` を `role: child` のデバイスで実行するとエラー終了する（`src/cli.ts` の child ガード）。

### 2.2 クロスプラットフォーム方針

- Node.js は Claude Code の前提にできない（ネイティブインストーラーは Node 非同梱）。よって reporter は OS ごとに用意する方針で、現状 **bash 版（macOS/Linux/WSL2）** を実装している。Windows ネイティブ（PowerShell）は現状スコープ外。
- **hub 自体は素の Node.js プロセス**（Tauri 等のアプリ化はしない）。`monomi` からの自己修復自動起動（§2.3）で detached 常駐させる。
- **画面は CLI**（Ink）。ブラウザ向け Web ダッシュボードは作らない。

### 2.3 常時稼働（autostart、release-18 FR-01/FR-02、release-25-auto-update FR-02）

hub の常駐は既定で自己修復的な自動起動に一本化されている（pm2 等の外部プロセスマネージャ前提は release-18 で撤廃）。

- **自動起動と版照合**（`src/cli/hub-autostart.ts` の `ensureHubRunning()`。release-18 FR-01、release-25-auto-update FR-02）: `monomi`（引数なし。`case undefined`、`cli.ts`）実行時、ダッシュボード表示前に呼ぶ。`role: child` なら何もしない（child は hub を起動しない）。`config.port` に疎通できれば、応答ヘッダ `X-Monomi-Hub-Version` を読み取って `src/version-compare.ts` の `compareVersion()`（§13）で自版と semver 比較する（release-25 FR-02）:
  - 疎通できない場合: 既存ロジック。自パッケージ内の `dist/bin.js` を `process.execPath` で `hub` サブコマンド付き detached spawn（`unref()` 済み）。以後リトライ付きポーリング。
  - hub 版 < 自版、またはヘッダ欠落（版不明=旧版）: graceful 停止（`hubStop` で SIGTERM → 終了確認）→ `spawnHub` で新版 spawn → 疎通確認。成功時に「hub を新版へ自動更新した」notice を表示。
  - graceful 停止タイムアウト: SIGKILL へはエスカレーションせず、警告 notice を出して旧 hub のまま継続（次回起動時に再試行される）。
  - hub 版 > 自版: hub には触れず、「CLI が旧版である」警告 notice のみ。
  - hub 版 == 自版: 何もしない（現行挙動）。
  - `config.auto_update: false` の場合（FR-05）: 停止・再起動は行わず、版ずれの notice 表示のみ。
- **pid 管理**（`src/hub/hub-lifecycle.ts`。FR-02）: `serve()` は待受成功後に自 pid を `~/.monomi/hub.pid` へ無条件上書きで書き込む（stale pid の自己回復）。`monomi hub status` は pid ファイルの存在・プロセス生存・port 疎通を突き合わせ `running`（pid ファイル由来の pid が生存していれば pid/port 併記、無ければ port のみ）／`stopped`／`stale`（pid ファイルはあるがプロセス不在）の3状態を報告する。`monomi hub stop` は生存確認済みの pid にのみ SIGTERM を送り（無検証 kill はしない）、終了確認後に pid ファイルを削除する。`monomi hub` 起動時に port が既に使用中（`EADDRINUSE`）なら「既に稼働中の可能性があります。`monomi hub status` で確認してください」という案内へ変換する。
- **常駐そのものの実体**: 自動起動された hub プロセスは detached + unref のため、ダッシュボード（親プロセス）を終了しても動き続ける。マシンを再起動するまで、または `monomi hub stop`／クラッシュで終了するまで常駐が続く。
- **マシン再起動後も常時待ち受けさせたい場合**（オプション。自動起動があるため通常は不要）: launchd の LaunchAgent（`~/Library/LaunchAgents/com.monomi.hub.plist`、`ProgramArguments` に node・`monomi` 双方の絶対パスを明示し launchd の最小 PATH に依存しない形、`RunAtLoad`/`KeepAlive` true）を手動設定する。README の「hub の起動と常駐化」にコピペ可能な設定例を掲載。専用の install コマンドは現状未実装（スコープ外、`docs/known-issues.md` 参照）。

### 2.4 起動エントリと Node バージョン検査（release-17）

`package.json` の `bin.monomi` は本体 `dist/cli.js` を直接指さず、軽量エントリ `dist/bin.js`（`src/bin.ts`）を指す二層構成。`bin.ts` は起動のたび `package.json` の `engines.node`（現行 `>=22.5.0`、単一ソース）を満たすかを検査し、満たさなければ必要バージョン・現在バージョンを明示した日英併記メッセージを表示して exit code 1 で終了する。満たす場合のみ `cli.ts` を dynamic import して `run()` を実行する。

- 本体（`cli.ts` → `hub/serve.ts` → `db/database.ts`）は `node:sqlite` を静的 import するため、下限を満たさない Node で検査を経ずに読み込むと `node:sqlite` 由来の不可解なスタックトレースで落ちる。検査用エントリを分離し本体の import 自体を検査後まで遅延させることでこれを防ぐ。
- バージョン比較（`src/node-version-check.ts`）は副作用を持たない pure function として実装している。
- `run()` に到達した後（`case undefined`）、ダッシュボード表示前に `ensureHubRunning()`（§2.3、release-18 FR-01）→ 初回セットアップ確認（`maybePromptInstallHooks()`、release-18 FR-03。フック未登録かつ対話端末なら `install-hooks` 実行を確認し、拒否は `~/.monomi` 配下の専用マーカーファイルへ永続化して再プロンプトしない。非対話端末では確認せず案内のみ）の順で副作用を実行してからダッシュボードを起動する。`npx monomi-cli`（パッケージ名解決後、単一 bin `monomi` の実行）もこの起動エントリを経由するため同じ流れに従う。

---

## 3. レポーター（reporter）

実体は `reporter/monomi-report.sh`。macOS の bash 3.2 + curl + git を前提にし、`jq` は「あれば使う／無くても動く」（有無を吸収）。Node.js に依存しない。npm パッケージには同梱物として含まれ、`monomi install-hooks` が実行時に配置する（release-17、§3.1）。詳細な仕様は `reporter/README.md`。

- **project_key**: 正規化は hub 側の一手（§0.1）。reporter は `git remote get-url origin` の生出力を `instance.remote_url` にそのまま載せる。
- **時刻**: `occurred_at` は ISO8601(Z)（§0.5）。hub が受信時に epoch ms へ変換する。
- **ターミナル特定情報の捕捉（release-23 FR-01、release-28-wezterm-focus FR-01 で `$WEZTERM_PANE` を追加、既知課題 U9/U17 対応）**: 毎フックイベントで `resolve_tty()`（bash 3.2 互換、`$$` から ppid チェーンを最大 15 段辿り `ps -o tty=` が `??`/空以外を返した最初の値に `/dev/` を前置。祖先を辿っても制御端末が無ければ何も出力せず失敗を返す＝非 TTY 実行は null）で TTY を解決し、`$TERM_PROGRAM`（tmux 内では `tmux` になる点に注意）・`$TMUX_PANE`・`$TMUX` の socket 部分（`${TMUX%%,*}`）・`$WSL_DISTRO_NAME`・`$WT_SESSION`（将来のタブ単位フォーカス用に列のみ確保、§14）・`$WEZTERM_PANE`（WezTerm ペイン単位フォーカス用、§14）とあわせて `terminal` ネストオブジェクト（`tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session`/`wezterm_pane`、取得不能はいずれも `null`）としてペイロードに含める（§8.3 に例）。`tmux_pane`/`tmux_socket` は `$TMUX` が非空のときのみ設定する。`SessionStart` に限定せず毎フックで捕捉するのは、`--resume` で同一 `session_id` が別 TTY で再開しうるため。jq 経路・bash フォールバック経路（`json_escape` 適用）の両方に実装し、追加コストは `ps` 最大数回＋環境変数参照のみに抑えているため SessionEnd 高速経路（後述）のワースト実行時間（< 3000ms）に影響しない。
- **マルチエンドポイント**: hub 到達先候補を優先順に順試行し、到達できた先へ POST する。候補解決順は「`MONOMI_HUB_URL`（単一・最優先）→ `MONOMI_PORT` の loopback → config `hub_endpoints`（複数候補）→ config `port` の loopback → 既定ポート `47632`」。
- **耐障害性（outbox）**: 全候補が接続失敗／5xx のときのみ、イベント本文を `~/.monomi/outbox/*.json` へ退避する。次回発火時にまず outbox を `occurred_at` 昇順で再送してから当該イベントを送る。
- **SessionEnd 高速経路（release-7 FR-02）**: `event_type=SessionEnd` のみ例外経路を通る。outbox flush をスキップし、候補 hub URL の先頭 1 件のみへ `connect-timeout=1s`/`max-time=2s` で単発 POST する（他候補への順次試行はしない）。Claude Code の Graceful shutdown 猶予（既定 5 秒）内に確実に完了させるため、マルチエンドポイント順次試行（候補ごと最大 8s）を待たない設計。失敗時は他イベント種別と同じく outbox へ退避し（4xx は `rejected/` へ隔離）、次回いずれかのイベント発火時に通常の `flush_outbox` 経路で再送される。`SessionEnd` 以外は本節冒頭の「マルチエンドポイント」「耐障害性（outbox）」の経路（outbox flush 先行 → 複数候補順次試行 → 候補ごと最大 8s）を維持する（回帰なし）。
- **4xx 隔離**: 4xx（不正 JSON／スキーマ不適合／失効トークン）は永久エラーとして `~/.monomi/outbox/rejected/` へ隔離し、キューを閉塞させない。件数上限（`MONOMI_REJECTED_MAX`、既定 200）超過分は最古から掃除する。
- **フック非破壊**: どんな失敗でも最終的に `exit 0` し、フック（特に PreToolUse）をブロックしない。
- **`~/.monomi` パーミッション防御**: reporter は `monomi pair` 前に発火して Node 側の `ensureMonomiHome()` を経由せず `~/.monomi` を単独作成しうる。`mkdir -p` 直後に `chmod 700 "$home"` を無条件実行し、hub 側の `HOME_DIR_MODE`（0o700）と同じ不変条件を reporter 単独でも保つ（release-13）。

### 3.1 フックの登録（install-hooks）と reporter 自動再配置（release-25-auto-update FR-03）

**フック登録時の reporter 配置**:
`monomi install-hooks` は、フック登録に先立って npm パッケージ同梱の reporter を `~/.monomi/monomi-report.sh`（`MONOMI_HOME` 環境変数で配置先を変えている場合はその配下）へ常に上書き配置し、実行権限（0755）を付与する（release-17 FR-02）。配置に失敗した場合はフック登録へ進まず例外で異常終了する。フック command 文字列に埋め込む reporter パスは実際の配置先から導出するため、`MONOMI_HOME` を変えても配置先と呼び出し先が乖離しない。

配置時に機械可読の版マーカー行 `MONOMI_REPORTER_VERSION="<MONOMI_VERSION>"` を reporter スクリプトへ注入する（既存マーカー行があれば置換）。この注入は `deployReporterScript`（`src/install-hooks/install-hooks.ts`）で行い、同梱ファイル自体にはプレースホルダ行を置く（ビルド時の版同期を不要にするため）。マーカーは bash 変数定義 1 行であり、reporter の動作に影響しない。

配置が済むと、Claude Code の 7 フックを `~/.claude/settings.json` へ冪等に登録する（`src/install-hooks/`）。command 文字列末尾に `#monomi:v1` マーカーを埋め込み（bash コメント扱いで無害）、これを判別に使うことで既存の他ツール由来フックを壊さず remove-then-add する。`Notification` は matcher 別に 2 エントリ（`permission_prompt` / `idle_prompt`）へ分割するため、登録数は 8 になる。除去は `monomi uninstall-hooks`（フックのみ除去。reporter 本体は残る）。

**ダッシュボード起動時の reporter 自動再配置**:
`monomi` 実行時（role 非依存。hub/child 共通）に、フック登録済みデバイス（`~/.monomi/monomi-report.sh` 存在）の設置済み reporter のマーカー版を読み取り、`src/version-compare.ts` の `compareVersion()`（§13）でバージョン照合を行う（release-25-auto-update FR-03）:

- マーカー版 < 自版、またはマーカー無し（既存全ユーザー）: `deployReporterScript` で上書きし、更新した旨の notice を表示。
- マーカー版 == 自版: 一切触らない（現行版への手動編集は自動では戻さない。グローバル方針「手作業で編集されたファイルを確認なしに戻さない」との整合）。
- マーカー版 > 自版: 触らず、CLI 旧版警告 notice のみ（§2.3 の hub 版照合と同じ機構）。
- フック未登録デバイス（`~/.monomi/monomi-report.sh` 未存在）では何もしない（初回セットアッププロンプトの責務のまま）。
- `config.auto_update: false` の場合（FR-05）: 上書きせず版ずれ notice のみ。
- `deployReporterScript` 自体が失敗した場合（ディスク満杯・権限エラー・`~/.monomi` 削除等。同関数は
  失敗時に例外を投げる契約）: `ensureReporterUpToDate`（`src/install-hooks/install-hooks.ts`）が
  例外を捕捉し、`isMonomiHooksInstalled`・reporter 読み込み失敗と同じ degrade-gracefully 方針で
  失敗 notice（`autoUpdate.reporterUpdateFailed`）へ変換する。`monomi install-hooks` コマンド自体
  （上記「フック登録時の reporter 配置」）が失敗時に例外で異常終了するのとは対照的に、この自動
  再配置は non-critical な起動前段の一部であり、失敗してもダッシュボード起動を止めない。

---

## 4. フック → raw_state マッピング

`src/status/raw-state-resolver.ts` の `rawStateOf()` が 1 イベントを raw_state へ写す唯一の定義。状態導出に無関係なイベントは `null`。

| フック（event_type）                                               | 条件                        | raw_state                         |
| ------------------------------------------------------------------ | --------------------------- | --------------------------------- |
| `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | —                           | `ACTIVE`                          |
| `Notification`                                                     | subtype `permission_prompt` | `APPROVAL_WAIT`                   |
| `Notification`                                                     | subtype `idle_prompt`       | `NEXT_WAIT`                       |
| `Notification`                                                     | 上記以外の matcher          | `null`（状態に無関係）            |
| `Stop`                                                             | —                           | `NEXT_WAIT`（暫定）               |
| `SessionEnd` / `session_lost`                                      | —                           | `CLOSED`                          |
| `WorktreeCreate` / `WorktreeRemove`                                | —                           | `null`（instance 登録の補助情報） |

- 権限待ちの観測は `PermissionRequest`（allow/deny/ask を返す同期ゲート）ではなく `Notification`(matcher `permission_prompt`) に一本化する（§0.5）。同期パスに観測 POST を挟んで遅延・誤判断を注入しないため。`PermissionRequest` は `EventType` 列挙に含めない。
- `Stop` は「ターン終了」の暫定 `NEXT_WAIT`。直後の `idle_prompt` か次の `UserPromptSubmit` で確定する。
- PR レビュー待ちはフックでは拾えないため、別系統（`GithubPrPoller`、release-27、§15）で取得する。`pr_status.state === 'awaiting_review'` を `hasPrWaiting` として `EscalationPolicy.classify()`（§5.3）へ渡す。

---

## 5. status 導出ロジック

**status カラムは持たない。表示のたびにイベント列から導出する**（放置判定が経過時間依存のため、キャッシュするとズレる）。導出エンジンは `src/status/` に責務ごとの値オブジェクト／ドメインサービスとして分解されている。

### 5.1 raw_state 判定

`RawStateResolver` が「`received_at` 基準で最も新しい、状態を持つイベント」の写像として現在の raw_state を決める。状態を持つイベントが 1 つも無い縮退ケースは `ACTIVE`（経過 0）扱い。

### 5.2 遷移時刻（経過時間の起点）

`StateTransitionFinder` が「現 raw_state 連続区間の最初のイベントの `received_at`」を遷移時刻とする。`idle_prompt` が複数回発火しても（同じ `NEXT_WAIT` が連続）起点はリセットされない。別の raw_state が挟まった時点で区間が切れ、その後の新しい区間の先頭が起点になる。時刻計算はすべて hub の `received_at` 基準（§0.5）で、`occurred_at`（クライアント時刻）は status 導出に用いない。

### 5.3 エスカレーション閾値

`EscalationThresholds` が raw_state 別の放置昇格閾値を保持する（`config.yml` の `escalation_thresholds` で上書き可能）。既定値:

| raw_state       | 既定閾値 |
| --------------- | -------- |
| `ACTIVE`        | 2h       |
| `APPROVAL_WAIT` | 6h       |
| `NEXT_WAIT`     | 24h      |
| `PR_WAIT`       | 72h      |

`EscalationPolicy.classify()` が遷移・経過時間・閾値・PR 有無から表示ステータスを確定する。手順は「候補選択（`ACTIVE` はそのまま／`APPROVAL_WAIT` はそのまま／`next_wait` は PR ありで `PR_WAIT`・なしで `NEXT_WAIT`）→ その候補状態の閾値で経過時間判定 → 超過なら `STALE` へ昇格」。`active` 中は PR が開いていても `ACTIVE` を優先する。`CLOSED` は非表示（放置判定の対象外）。

### 5.4 表示ステータスの優先順位（1 instance につき 1 つに絞る）

`STATUS_PRIORITY`（`src/status/status-priority.ts`）が優先順位を数値化する唯一のテーブル。数値が大きいほど注意を要する。

| 表示ステータス  | priority | 意味                                 |
| --------------- | -------- | ------------------------------------ |
| `STALE`         | 5        | 放置                                 |
| `APPROVAL_WAIT` | 4        | 権限待ち                             |
| `PR_WAIT`       | 3        | PR レビュー待ち                      |
| `NEXT_WAIT`     | 2        | 次の指示待ち                         |
| `ACTIVE`        | 1        | 稼働中                               |
| `CLOSED`        | 0        | 非表示（ロールアップの最下位比較用） |

「放置 > 権限待ち > PR レビュー待ち > 次の指示待ち > 稼働中」（§5.2）を数値の大小で表す。この定数はここ一箇所にのみ存在し、hub が `status.priority` として API で返すため、CLI ロールアップは `max()` するだけで済む（優先順位の二重管理を排除）。instance 内の代表 session 選定（§5.5）では release-8 以降、この優先度は完全同時刻のタイブレークにのみ用いる（主基準は recency）。project 単位の `ClientRollup`（§10.1）は引き続きこの優先度を主基準として `max()` する。

### 5.5 ロールアップ

`InstanceStatusRollup` が 1 instance 配下の複数 session の `RollupEntry`（`{ status: StatusResult, lastEventAt: EpochMs }`）から代表を選ぶ（release-8 FR-02: 完全 recency 優先化。`docs/known-issues.md` B8 対応／release-19 FR-01: 孤立 live session 除外。`docs/known-issues.md` B9 対応）。project 単位のロールアップは CLI 側（`ClientRollup`）の関心事で hub は持たない（§5.3）。`ClientRollup` は本変更の対象外で、従来通り優先度を主基準とする（§5.4／§10.1）。

選定は private メソッド `selectCandidates()`（前段フィルタ）と `rollup()` 本体（後段の recency 比較）の 2 部構成で、前段フィルタはさらに 2 段階。

1. **closed 除外（§0.5 不変条件）**: 他に live な（非 `CLOSED` の）session が instance 内に 1 つでもあれば、`CLOSED` の session は `lastEventAt` がどれだけ新しくても候補から除外する。全 session が `CLOSED` の場合のみ closed 自身が候補に残り代表になりうる（FR-01 の既定非表示化と組み合わさる想定）。この段階は recency 優先化後も変わらず維持され、closed が active を覆い隠すことはない。
2. **孤立（zombie）live session 除外（release-19 FR-01。`docs/known-issues.md` B9 対応）**: instance 内に `CLOSED` session が 1 件以上存在する場合に限り（`CLOSED` が皆無なら適用範囲外で、従来どおり全 live が次段の候補になる）、live session のうち「`STALE`（放置）表示に昇格済み、かつ `lastEventAt` が最新 `CLOSED` の `lastEventAt` より古い」ものを孤立とみなして候補から除外する。真に `ACTIVE`（`STALE` 未昇格）な live session は `lastEventAt` が常に最新であり続けるため除外対象にならず、B8 の recency 優先化を壊さない。除外の結果 live 候補が 0 件になった場合は closed 群へフォールバックし、次段の recency 比較で最新の `CLOSED` session が代表として選ばれる（instance 全体が「終了」表示になる）。異常終了で `SessionEnd`/`Stop` を送れないまま放置閾値を超過した孤立 session が、同一 instance の別 session が正常終了（`CLOSED`）した直後にその「終了」表示を乗っ取って「放置」表示にすり替わる不具合（B9）への対症療法であり、孤立 session 自体を `CLOSED` へ確定させる根本対応（ライブネス検知、§6）ではない。
3. **recency 優先（release-8 FR-02）**: 前段フィルタを通過した候補（通常は live session 群。全件 `CLOSED` か、孤立 live 除外の結果 0 件になった場合は closed 群）の中で、最も新しい `lastEventAt` を持つ session を無条件で代表に選ぶ。優先度（`StatusPriority`、§5.4）は、複数 session の `lastEventAt` が完全に同一のときにのみタイブレークに用いる（同値ならさらに `elapsedMs` が大きい方）。

release-7 で追加した孤立 session 除外（`STALE_SESSION_THRESHOLD_MS` によるハードコード 15 分閾値。instance 内最新イベントから 15 分以上離れた session を代表選定の候補から事前除外する対症療法、旧 B7 対応）は release-8 で完全に削除した。完全 recency 優先の下では「最も新しい `lastEventAt` を持つ session は必ず候補に残り必ず選ばれる」ため、事前フィルタリングは結果に一切影響せず不要になった（数学的に不要）。詳細な経緯は §6 を参照。release-19 FR-01 の孤立 live 除外（上記 2.）はこれとは判定基準が異なる別物（`CLOSED` の存在を前提とし、`STALE` 昇格済みかどうかで判定する）であり、release-7 ロジックの re-introduce ではない。

### 5.6 導出パイプライン

`StatusDeriver.deriveForSession()` は判断ロジックを持たない薄いオーケストレーターで、`RawStateResolver`（最新 raw_state）→ `StateTransitionFinder`（遷移時刻）→ `EscalationPolicy`（表示確定）を順に呼び `StatusResult` を組み立てる。hub の `InstanceStatusService` は、`loadEventsForCurrentRun()` で現在の連続区間の判定に十分なイベントだけを `received_at` 降順にページングしながら取得し（`scanForRunBoundary` で境界検出時に打ち切り）、session ごとに導出する。その際、同じ `loadEventsForCurrentRun()` の先頭（`received_at` 降順の最新イベント）を `lastEventAt` として `StatusResult` と組にした `RollupEntry`（§5.5）を作り rollup へ渡して代表を選び、`§8.2` の wire 行へ写す。イベント 0 件の縮退ケース（例: `upsertStarted` 後 `events.append` 前のクラッシュでイベントを一切持たない session 行だけが残るケース）は、`lastEventAt` に session の `startedAt`（固定の過去時刻）を安全値として使う。§5.5 の recency 優先ロールアップの下でここに `now`（呼び出しの都度更新される値）を使うと、このゼロイベント session が常に「最も新しい」と誤認され、実際に活動中の他 session を無条件に覆い隠す回帰を招くため（release-8 review-changes で検出）。

---

## 6. 異常終了・ライブネス（現状: 未実装）

- `SessionEnd` は Ctrl+C / `/clear` / 通常終了では発火するが、`kill -9` / 電源断 / ネットワーク切断では発火しない（原理的に不可能）。
- 検知できない異常終了はハートビート方式（`SessionStart` フック内で PID 監視のバックグラウンド子プロセスを生やし、対象 PID が死んだら `session_lost` を 1 回 POST）でカバーする設計だが、**現状はライブネス検知（常駐ハートビート／`session_lost`）を実装していない**。`sessions.last_heartbeat_at` 列と `session_lost` イベント種別は受け皿として先に用意済みで、更新経路はまだ設けていない。放置しきい値（§5.3）のセーフティネットに委ねる。
- release-7 で、`SessionEnd`/`session_lost` を受け取れず `ended_at` が NULL のまま残った孤立 session が、稼働中の別 session の表示を覆い隠す不具合（`docs/known-issues.md` B7）に対し、rollup 側で孤立 session を代表選定から除外する対症療法（`STALE_SESSION_THRESHOLD_MS` による 15 分閾値）を追加した。しかしこの閾値ロジックは、15 分以内に session が再開されたケースでは効かず、稼働中の新しい session（優先度最下位）が、15 分以内に残る古い session（優先度上位）に覆い隠される別の不具合（`docs/known-issues.md` B8）を生んだ。release-8 でこの閾値ロジックを完全に削除し、§5.5 の完全 recency 優先ロールアップへ置き換えたことで、孤立 session 除外という対症療法そのものが不要になった（最も新しい `lastEventAt` を持つ session が常に代表候補に残るため）。これも表示上の近似的な解決であり、孤立 session 自体を `CLOSED` へ確定させる根本対応（ライブネス検知）ではない——「見た目が新しい」ことと「実プロセスが生きている」ことは同義ではないため。加えて reporter の `SessionEnd` 送信を高速化（§3、release-7 FR-02）し、Graceful shutdown の猶予内での送達確度を上げたが、終了経路によっては `SessionEnd` フック自体が発火しない可能性が残るため、いずれも対症療法に留まる。
- release-8 の完全 recency 優先化は B7/B8 を解決した一方、新たな副作用（`docs/known-issues.md` B9）を生んだ。`SessionEnd`/`Stop` を一度も送れず異常終了した孤立 session は `CLOSED` に遷移しないため無期限に live 候補であり続け、真に稼働中の別 session がある間は recency により隠れるが、その session が正常に `SessionEnd` を送って `CLOSED` になった瞬間、instance 内で唯一残る live 候補が数日前の孤立 session になり、直前に正しく終了させた session の「終了」表示ではなく無関係な孤立 session の「放置」表示が代表として浮上する（2026-07-09、Monomi 自身のリポジトリで実機確認・再現済み）。release-19 FR-01 は、`InstanceStatusRollup` に「instance 内に `CLOSED` session が 1 件以上あるときに限り、`STALE` 昇格済みかつ最新 `CLOSED` より `lastEventAt` が古い live session を候補から除外する」ヒューリスティックを追加してこれに対処した（§5.5）。真に `ACTIVE` な live session は影響を受けないため B8 の解決を壊さない。`CLOSED` が 1 件も無い instance（孤立 session のみ、または現在進行形で放置中の session のみ）は適用範囲外で、従来どおりそのまま `STALE` へ昇格しうる。これも表示上の対症療法であり、孤立 session 自体を `CLOSED` へ確定させる根本対応（ライブネス検知）ではない。
- PID は hook payload に含まれないため（実機 Claude Code 2.1.197 で確認）、将来のハートビートでは reporter が `$PPID` 系譜を辿って `sessions.pid` を自前充填する想定。

---

## 7. データモデル

### 7.1 木構造

```
session（一番細かい単位。agent 側の session_id）
  └─ instance（ディレクトリ単位。git toplevel、非 git なら cwd）
       └─ project（正規化済み project_key 単位）
```

instance は「git worktree」ではなく「ディレクトリ」の単位。worktree を使わない場合は自然に 1 プロジェクト = 1 instance になるだけで特別扱いは不要。`WorktreeCreate` / `WorktreeRemove` は instance 登録の補助情報という位置づけ。

### 7.2 タイムスタンプ

内部の全時刻は **UNIX エポック（ミリ秒）の INTEGER**（放置判定が経過時間の引き算だから）。API 応答時に ISO8601(Z) 文字列へ変換して返す。型は branded 型 `EpochMs` / `DurationMs`（`src/domain/time.ts`）で取り違えを防ぐ。

### 7.3 DDL

`src/db/ddl.ts` の実体。すべて `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` で記述し、起動のたびに冪等適用する（マイグレーションフレームワークは持たない）。`events.received_at` は経過時間計算の権威時刻（§0.5）として DDL に含まれる。

```sql
-- デバイス（レポート送信元）
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,       -- config.yml の device_id
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('hub','child')),
  first_seen_at INTEGER NOT NULL,       -- epoch ms
  last_seen_at  INTEGER NOT NULL
);

-- 論理プロジェクト（正規化済み project_key で識別）
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  project_key  TEXT NOT NULL UNIQUE,    -- 正規化済み git remote、または local:/nogit: キー
  display_name TEXT,                    -- 未設定なら project_key から自動生成
  created_at   INTEGER NOT NULL
);

-- インスタンス（ディレクトリ単位。worktree の有無に関わらず同じ扱い）
CREATE TABLE IF NOT EXISTS instances (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  path        TEXT NOT NULL,            -- git toplevel。非 git なら cwd
  branch      TEXT,                     -- 非 git なら NULL
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,                  -- WorktreeRemove 等で埋まる
  UNIQUE(device_id, path)
);

-- セッション（1 instance につき履歴として N 件）
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,   -- エージェント側の session_id
  instance_id       TEXT NOT NULL REFERENCES instances(id),
  agent_type        TEXT NOT NULL DEFAULT 'claude_code',  -- 現状 claude_code 固定
  pid               INTEGER,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  end_reason        TEXT,               -- clear/logout/prompt_input_exit/session_lost/other
  last_heartbeat_at INTEGER,            -- ライブネス未実装のため現状常に NULL
  -- ターミナル特定情報（release-23 FR-02a、§14 のフォーカス機能で使用。全列 reporter 捕捉のスナップショット、最新値で上書き）
  tty               TEXT,               -- 例 /dev/ttys003。非TTY実行・未捕捉は NULL
  term_program      TEXT,               -- $TERM_PROGRAM（tmux 内は "tmux"）
  tmux_pane         TEXT,               -- $TMUX_PANE（例 %3）。tmux 外は NULL
  tmux_socket       TEXT,               -- $TMUX の socket 部分。tmux 外は NULL
  wsl_distro        TEXT,               -- $WSL_DISTRO_NAME。WSL 以外は NULL
  wt_session        TEXT,               -- $WT_SESSION。データ捕捉のみ（タブ単位フォーカスはスコープ外）
  wezterm_pane      TEXT,               -- $WEZTERM_PANE（release-28-wezterm-focus FR-02、§14）。WezTerm 以外/未捕捉は NULL
  terminal_seen_at  INTEGER             -- 上記スナップショットを hub が受信した時刻。未着なら NULL
);

-- 生イベントログ（status 導出 + Agent View 用の活動フィード）
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  instance_id   TEXT NOT NULL REFERENCES instances(id),  -- 非正規化。最新状態クエリで JOIN を省く
  event_type    TEXT NOT NULL,          -- SessionStart/.../SessionEnd/session_lost 等
  event_subtype TEXT,                   -- 例: Notification の matcher
  tool_name     TEXT,                   -- Pre/PostToolUse のみ
  tool_summary  TEXT,                   -- 切り詰めた tool_input
  occurred_at   INTEGER NOT NULL,       -- epoch ms。クライアント（デバイス）時刻
  received_at   INTEGER NOT NULL        -- epoch ms。hub 受信時刻（経過時間計算の権威時刻）
);
CREATE INDEX IF NOT EXISTS idx_events_instance_time ON events(instance_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_time  ON events(session_id, occurred_at DESC);

-- PR レビュー状態（`GithubPrPoller` が書く、§15）
CREATE TABLE IF NOT EXISTS pr_status (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  branch     TEXT NOT NULL,
  pr_number  INTEGER,
  state      TEXT NOT NULL,             -- none/awaiting_review/changes_requested/approved/merged
  is_draft   INTEGER NOT NULL DEFAULT 0, -- release-27。既存 DB へは §7.5 の冪等マイグレーションで追加
  url        TEXT,
  checked_at INTEGER NOT NULL,
  UNIQUE(project_id, branch)
);

-- デバイストークン（認証。§0.3）
CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  token_hash  TEXT NOT NULL UNIQUE,    -- SHA-256(token)。生 token は保存しない
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER                  -- revoke 時刻。NULL なら有効
);
CREATE INDEX IF NOT EXISTS idx_tokens_device ON tokens(device_id);
```

### 7.4 起動時の PRAGMA・冪等性

- DB を開く際に `journal_mode=WAL` + `synchronous=NORMAL`（電源断耐性）+ `foreign_keys=ON` を設定する（`src/db/database.ts`）。WAL は永続ファイルでのみ有効。
- `openDatabase()` は DDL 適用後、`:memory:` 以外なら DB ファイルを `chmod 600`（`DB_FILE_MODE`）へ固定する。起動のたび無条件に適用するため、release-13 以前に作られた既存 DB も次回起動時に自動修復される（既知課題 S1 解消）。WAL の `-wal`/`-shm` 補助ファイルは個別に chmod せず、親ディレクトリ `~/.monomi` の `chmod 700`（§0.3）で保護する前提。
- 初出の project / instance / session はイベント受信時に自動登録される（冪等）。project は正規化キーで findOrCreate、instance は `(device_id, path)` で upsert（branch は DO UPDATE）、session は `session_id` で upsertStarted。device 行はイベント経路では新規作成せず、認証済み device の `last_seen_at` を touch するに留める（device の登録は bootstrap／pairing 経路が担う）。

### 7.5 スキーマの冪等マイグレーション（release-23 で新設、release-27 でテーブル横断へ汎化。§7.3 方針からの初の意図的逸脱）

新規 `src/db/migrations.ts` の `applyMigrations(db)` を `openDatabase()` が `db.exec(DDL)` 直後に呼ぶ。DDL の `CREATE TABLE IF NOT EXISTS` は新規作成にしか効かず、既存テーブルへの列追加はできない。release-23 で `sessions` に §7.3 の 7 列（`tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session`/`terminal_seen_at`）を追加した際、release-22 以前に作られた既存 DB ファイルへこれらを後付けする手段としてこの機構を新設した。release-27 で `pr_status` へ `is_draft` 列（§7.3・§15.6）を追加する必要が生じたのを機に、`applyMigrations()` を「`sessions` 列固定」の実装から `TABLE_MIGRATIONS`（`readonly { table: string; columns: ColumnDefinition[] }[]`）によるテーブル横断の汎用構造へリファクタし、`sessions`/`pr_status` 双方の追加列をこの1つの関数で扱う。release-28-wezterm-focus では `sessions` エントリへ `wezterm_pane`（TEXT、§7.3・§14）を追加しただけで、この汎用構造自体への変更は不要だった。

- `applyMigrations()` は `TABLE_MIGRATIONS` の各エントリについて、対象テーブルの存在を `tableExists()` で確認したうえで（`PRAGMA table_info()` は存在しないテーブルにも例外を投げず空行を返すため、1テーブルの欠落が他テーブルのマイグレーションを止めないためのガード）現在の列名集合を `PRAGMA table_info(<table>)` で取得し、欠落している列だけを `ALTER TABLE <table> ADD COLUMN <name> <type>[ NOT NULL DEFAULT <値>]` する。`NOT NULL` 制約付き列（`pr_status.is_draft`）は SQLite の制約上 `DEFAULT` の指定が必須なため、列定義に `notNullDefault` を持たせ DDL の定義と一致させて保守する。新規 DB では DDL が全列を作成済みのため何もしない（何度実行しても結果が変わらない冪等関数）。
- **§7.3 冒頭「マイグレーションフレームワークは持たない」からの初の意図的逸脱である。** 列追加（既存データを破壊しない単調な追加）に限れば、「起動のたび冪等適用する」という DDL の運用モデルをそのまま `PRAGMA table_info` 差分適用へ拡張するだけで足り、バージョン管理・up/down・適用履歴テーブルを持つ本格的なマイグレーションツールを導入するほどの複雑さは要さない。列の削除・型変更・データ移行を伴う変更が今後必要になった場合は、この「追加専用・履歴を持たない」前提の限界を踏まえて改めて設計を見直す（本節は現状のスコープに限定した最小実装という位置づけ）。
- ダウングレード（当該リリース未満のコードで、それ以降に追加された列を持つ DB を開く場合）は、未知の列が単に無視されるだけで動作に影響しない（互換性方針、requirements.md 非機能要件）。

---

## 8. Hub API 設計

`src/hub/http-server.ts` の `createHubServer()` が Repository → UseCase/Service → Controller → Router を DI 配線する。リクエストパイプラインは「ルート照合 → 認証（認証必須ルート）→ ボディ JSON パース（POST 系）→ ハンドラ実行 → JSON 応答」。境界での時刻変換（wire は ISO8601、内部は epoch ms）は Controller/DTO 側が担う。

- 既定で全インターフェース（`0.0.0.0`）にバインドし他デバイスからの到達を許可する。config `bind:` で `127.0.0.1` 等へ上書き可能。既定ポートは `47632`（config `port:`）。
- 送信元アドレスは生 TCP 接続の `socket.remoteAddress` のみを見る。`X-Forwarded-For` は一切参照しない（§0.3）。
- リクエストボディ上限は 1 MB（超過は 413）。

### 8.1 認証と応答ヘッダ

- 認証必須ルートは `Authorization: Bearer <device_token>` を要求する。`AuthResolver` が生トークンを SHA-256 照合して device を解決し（`TokenService.verify`）、無効／失効／欠落はすべて 401（`WWW-Authenticate: Bearer`）。
- 書き込みでは、認証済み device の id でボディの `device_id` を必ず上書きする（なりすまし書き込み防止、§0.3）。
- 読み取り API は、有効なトークンであれば発行元デバイスを問わず全デバイスの instance／イベントを返す（所有権チェックは行わない。既知課題 S2）。
- ペアリング系（`pair/start` / `pair/claim`）は認証をスキップする public ルート。デバイス管理系（`devices`）は Bearer 認証に加えて loopback 限定ガードを上乗せする。

**レスポンスヘッダ（release-25-auto-update FR-01）**:

- `X-Monomi-Hub-Version: <MONOMI_VERSION>` を全 HTTP 応答（401 認証エラー応答を含む）に付与する（`src/hub/http-server.ts` で集約して送出）。ダッシュボード起動時のバージョン照合（§2.3 の版照合導線）で、未認証疎通プローブ（GET `/api/v1/instances` → 401）の応答からゼロ追加リクエストで hub の版を読める。child 側（remote hub）の版照合（§8.4、FR-04）でもポーリング応答から追加リクエストなしに読める。版ヘッダはレスポンスボディに依存しない応答メタデータのため、401/404/500 等のエラー応答にも付与される。

### 8.2 実装済みルート一覧

| メソッド | パス                         | 認証              | 用途                                                               |
| -------- | ---------------------------- | ----------------- | ------------------------------------------------------------------ |
| `POST`   | `/api/v1/events`             | Bearer            | 全イベント共通の受け口。project/instance/session を初出自動登録    |
| `GET`    | `/api/v1/instances`          | Bearer            | 一覧。status 導出済みの行を `{ generated_at, instances[] }` で返す |
| `GET`    | `/api/v1/instances/:id`      | Bearer            | 詳細。一覧 1 行 + `recent_events`（直近 100 件、Agent View 用）    |
| `GET`    | `/api/v1/devices`            | Bearer + loopback | 登録デバイス一覧（トークン有効/失効つき）                          |
| `POST`   | `/api/v1/devices/:id/revoke` | Bearer + loopback | 当該 device の有効トークンを一括失効                               |
| `POST`   | `/api/v1/pair/start`         | public + loopback | 6 桁ペアリングコード発行（loopback からのみ）                      |
| `POST`   | `/api/v1/pair/claim`         | public            | コード照合して child 用 device_token を発行                        |

> `POST /api/v1/heartbeat` は handoff §8.1 の設計に含まれるが、ライブネス検知が現状未実装のため**ルートとして登録されていない**（§6 参照）。

### 8.3 書き込みペイロード（`POST /api/v1/events`）

`src/hub/dto.ts` の `rawEventPayloadSchema`（zod）で検証する。reporter は正規化前の生 remote を `instance.remote_url` に載せ、`occurred_at` は ISO8601(Z) 文字列で送る。

```json
{
  "device_id": "macmini-1",
  "session_id": "a1b2c3d4",
  "instance": {
    "remote_url": "git@github.com:sumihiro/ProjectLens.git",
    "path": "/Users/sumihiro/dev/ProjectLens",
    "branch": "feature/ai-sidecar",
    "is_git_repo": true,
    "common_dir": null
  },
  "event_type": "Notification",
  "event_subtype": "permission_prompt",
  "tool_name": "Bash",
  "tool_summary": "npm install",
  "occurred_at": "2026-07-01T05:12:03Z",
  "terminal": {
    "tty": "/dev/ttys003",
    "term_program": "Apple_Terminal",
    "tmux_pane": null,
    "tmux_socket": null,
    "wsl_distro": null,
    "wt_session": null,
    "wezterm_pane": null
  }
}
```

- `device_id` は body で送るが、hub は認証済み Bearer トークン由来の値で上書きする（body 値は信頼しない）。
- `project_key` は hub が `ProjectKeyNormalizer` で導出する（§11）。
- 成功は 201（`event_id` 等の ack）、スキーマ不適合は 400（`invalid_payload`）。
- `terminal`（release-23 FR-01/FR-02、release-28-wezterm-focus FR-01/FR-02 で `wezterm_pane` を追加、§14）: reporter が捕捉したターミナル特定情報。`rawEventPayloadSchema` はキー自体を `.nullable().optional()` とし、`terminal` を送らない旧 reporter のペイロードも引き続き 2xx で受理する（後方互換）。`wezterm_pane`（`$WEZTERM_PANE`）も他フィールドと同じく `.nullable().optional()` で、未捕捉の旧 reporter のペイロードは引き続き受理される。`ingest()` は `payload.terminal` が undefined/null でないときのみ `sessions.updateTerminal()` を呼び、最新スナップショットで上書きする（旧 reporter の欠落ペイロードで既存値を NULL 上書きしない。新 reporter が明示的に送った `tty: null` 等はそのまま採用する）。

### 8.4 読み取りレスポンス（`GET /api/v1/instances`）と child デバイスの版ずれ可視化（release-25-auto-update FR-04）

**レスポンス構造（既存）**:

```json
{
  "generated_at": "2026-07-01T05:20:00Z",
  "instances": [
    {
      "instance_id": "inst_01",
      "project": { "id": "proj_01", "name": "ProjectLens" },
      "device": { "id": "macmini-1", "name": "Mac mini" },
      "path": "/Users/sumihiro/dev/ProjectLens",
      "branch": "feature/ai-sidecar",
      "status": {
        "display": "approval_wait",
        "raw_state": "approval_wait",
        "elapsed_seconds": 720,
        "is_stale": false,
        "priority": 4
      },
      "pr": { "state": "none", "number": null, "url": null, "is_draft": false },
      "session": {
        "id": "a1b2c3d4",
        "last_heartbeat_at": null,
        "terminal": {
          "tty": "/dev/ttys003",
          "term_program": "Apple_Terminal",
          "tmux_pane": null,
          "tmux_socket": null,
          "wsl_distro": null,
          "wt_session": null,
          "wezterm_pane": null
        }
      },
      "running_work": null
    }
  ]
}
```

- `status.display` / `raw_state` は wire では小文字 snake（例 `approval_wait`）。`priority` は §5.4 の numeric priority。
- **`pr`（release-27 FR-05a、§15.7）**: `state` に加え `number: number | null`・`url: string | null`・`is_draft: boolean` を持つ。`dto.ts` の `toPrDto()` がドメインの `PrStatus | null` から変換し（`pr` が `null` なら `{ state: 'none', number: null, url: null, is_draft: false }` の既定値）、他の wire 変換と同じ「ドメイン型→薄い変換→wire DTO」パターンに揃える。`pr.state === 'awaiting_review'` を `hasPrWaiting` として status 導出へ配線する仕組みは §15.6 参照。
- **`session.terminal`（release-23 FR-03、release-28-wezterm-focus FR-02 で `wezterm_pane` を追加、§14）**: 代表 session のターミナル特定情報。wire 型は `dto.ts` の `TerminalDto`（`toTerminalDto()` でドメインの `SessionTerminal` から変換、`toRunningWorkDto()` と同型の「ドメイン型→薄い変換→wire DTO」パターン踏襲）。reporter から一度も届いていなければ（旧 reporter・非 TTY 実行含む）`null`。`GET /api/v1/instances/:id`（`InstanceDetail`）も同じ形で含む。CLI は `null`／キー欠落（旧 hub 混在時）のいずれも「情報なし」として扱い `f` キーを無効化する（`RunningWorkDto.started_at` と同じ後方互換方針）。
- project 単位のロールアップは CLI 側で `project_id` により groupBy して計算する（hub は持たない）。
- watch モードは単純ポーリング（数秒おきに叩き直す）。SSE/WebSocket は使わない。
- **`running_work`（release-16 で追加、release-18 FR-04 で導出規則を再設計、release-18 FR-05 で `started_at` を追加）**: 「実行中の作業名」。`null` または `{ "kind": "workflow" | "agent" | "skill", "name": "run-release", "started_at": "2026-07-01T05:12:03Z" }`。`instance_id` 直下（`status`/`session` と同じ階層）に置く。`GET /api/v1/instances/:id`（`InstanceDetail`）も `InstanceStatusRow` を継承するため同じ形で含まれる。`started_at` はこの作業を採用した `PreToolUse` イベントの発生時刻（reporter 側時刻、hub 権威時刻ではない）を ISO8601(Z) にした値で、CLI の一覧カード・詳細ビューが経過時間表示に使う（`▶ <name> (<経過時間>)`）。旧 hub（release-16/17）との混在時の後方互換のため `null` を許容し、その場合 CLI は経過時間なしの表示にフォールバックする。wire 型は `dto.ts` の `RunningWorkDto`（status レイヤーの `RunningWork` から `toRunningWorkDto()` で変換、既知課題 A6 解消。class-diagram.md 参照）。
  - 導出元は既存 `events` テーブルの `tool_name`/`tool_summary`（DB スキーマ変更なし）。代表 session の直近イベントを `received_at` 降順に遡って走査する（`RunningWorkResolver.scanForRunningWork`）。
  - **消灯境界は候補種別ごとに非対称（release-18 FR-04）**: release-16 時点では Workflow/Skill/Agent を単一の境界集合（`Stop`/`Notification(idle_prompt)`/`SessionEnd`/`UserPromptSubmit`）で対称に扱っていたが、バックグラウンド実行される Workflow はツール呼び出し自体（`PreToolUse`→`PostToolUse`）が数秒で完結し直後のターン終了で `Stop` が発火するため、稼働中の Workflow 名がターン境界の向こうに取り残されて消灯する不具合があった（既知課題 U8、解決済み）。この実態（「Workflow の寿命 ≠ ターンの寿命」）に合わせ、境界を候補種別ごとに次のとおり非対称化した:
    - **Workflow 候補**: `SessionEnd` のみで消灯する。`Stop`/`UserPromptSubmit`/`Notification(idle_prompt)` は跨いでよく、既存のページング上限の範囲で最新の `PreToolUse(tool_name=Workflow)` まで遡って採用する。
    - **Skill/Agent（fallback）候補**: release-16 からの従来の境界集合（`Stop`/`Notification(idle_prompt)`/`SessionEnd`/`UserPromptSubmit`）をそのまま維持する。境界を跨いだ先の Task/Agent/Skill は採用しない。
    - **優先順位**: 境界を跨いで見つかった Workflow は、境界内で見つかった fallback より常に優先する（`received_at` 降順走査で Workflow を見つけた時点で即確定してよく、それより古い候補で上書きされる余地は無いため）。
    - `Notification(idle_prompt)` は Workflow 候補の境界から外れる。実イベント列（2026-07-07 の run-release 実行区間、hub DB で実測）でも、バックグラウンド Workflow 稼働中に `idle_prompt` が複数回発火しつつ `raw_state=active` が継続するケースを確認済みで、この判断と矛盾しない。
  - **ACTIVE ゲート**: 代表 session の `status.raw_state` が `active` のときだけ上記の走査を行う。非 active（`approval_wait`/`next_wait`/closed 相当）は走査せず即 `null` を返す（release-18 でも変更なし）。上の例は `raw_state: "approval_wait"` のため `running_work` が `null` になっている（`Workflow` 実行中に承認待ちへ入っても、待機中は表示を消す。要件上「消灯は `SessionEnd`（Workflow）／従来境界（fallback）のみ」という記述と「非 active なら null」という記述が承認待ち中に衝突するが、**後者（ACTIVE ゲート優先）で確定**しており実装・レビューで再度議論しない）。
  - 区切り判定は既存の raw_state 境界（`RunBoundaryScanner`／`APPROVAL_WAIT` 等への遷移）を再利用しない専用スキャンで行う。理由: Workflow 実行中に `permission_prompt` を経て承認・再開するケースでは raw_state 境界（`ACTIVE→APPROVAL_WAIT`）が先に来てしまい、承認前に開始した Workflow の `PreToolUse` を取りこぼすため（`docs/design/class-diagram.md` `RunningWorkResolver` 参照）。
  - **性能上のトレードオフ（release-18 で意図的に受容、既知課題 P8）**: ACTIVE ゲートにより非 active な instance では追加のイベント読み取りは発生しない（release-16 から変更なし）。一方 ACTIVE な instance では、`loadRunningWorkForCurrentRun()` が status 導出用の `loadEventsForCurrentRun()` とは別に代表 session のイベントを再度ページング読み込みする（区切り集合が異なるため単純な再利用はできない、上記）。release-16 時点ではこれは「ポーリング間隔（~2s）に対して軽微（クエリ 1 回 ~1ms）」な N+1 隣接パターンだったが、release-18 の非対称境界により、Workflow 候補が `SessionEnd` を送らずに長時間 ACTIVE のまま稼働し続けるセッション（バックグラウンド Workflow 実行中はこれが通常のパターン）では、ポーリングのたびにセッション開始付近まで遡る＝**履歴長に比例したイベント読み込み**が発生するようになった。これは「Workflow 名を稼働中ずっと表示し続ける」という機能要件（FR-04）と「P8（この N+1 パターン）を悪化させない」という NFR が両立しないために生じたトレードオフであり、release-18 では前者を優先し後者の悪化を意図的に受容する（`docs/known-issues.md` P8 参照）。非 ACTIVE な instance への影響は無い。
- **child デバイスの版ずれ可視化（release-25-auto-update FR-04）**: child ロール（role: child）の CLI は、接続中のリモート hub の応答ヘッダ `X-Monomi-Hub-Version` を読み取り、`src/version-compare.ts` の `compareVersion()`（§13）で hub 版 < 自版（またはヘッダ欠落=版不明）を検知したら「hub が旧版である。hub デバイスで `npx monomi-cli@latest` を実行するよう促す」notice を表示する（§8.1）。child からリモート hub の停止・再起動は行わない（構造的に不可能。hub デバイスで child 側の影響を受けて自動更新される仕組みになっていないため、hub デバイス側での `npx monomi-cli@latest` 実行を促すのみ）。notice はポーリングのたびに増殖せず、同一状態の重複表示をしない機構（`src/cli/components/app-view.tsx` の `remoteHubNotice`/`remoteHubNoticeRef` による状態管理）を持つ。

### 8.5 エラー応答

| ステータス | error                                                   | 契機                                                  |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------- |
| 400        | `invalid_json` / `invalid_payload`                      | JSON パース不能／zod 検証失敗                         |
| 401        | `unauthorized`                                          | トークン欠落／無効／失効                              |
| 403        | `loopback_required`                                     | devices/pair-start へ非 loopback からアクセス         |
| 404        | `not_found` / `instance_not_found` / `device_not_found` | 未一致ルート／対象なし                                |
| 405        | `method_not_allowed`                                    | パス一致・メソッド不一致                              |
| 409        | `device_conflict`                                       | claim 時、申告 device が既存かつ有効トークン保持      |
| 413        | `payload_too_large`                                     | ボディが 1 MB 超                                      |
| 500        | `internal_error`                                        | Controller が写し損ねた想定外例外（詳細は漏らさない） |

### 8.6 非機能要件とセキュリティ（release-25-auto-update）

**バージョンヘッダの情報開示**（release-25-auto-update FR-01 AC-3）:
`X-Monomi-Hub-Version` ヘッダは全応答（401 認証エラー応答を含む）に付与されるため、LAN 内の未認証クライアント（トークン無しで hub へアクセス可能な立場）へ hub のバージョン文字列が開示される。ただし開示される情報は `MONOMI_VERSION`（semantic version 文字列のみ）であり、構築日時・build hash・debug symbol 等の補助情報は含まれない。hub のバージョンがどのリリース版かが知られること自体は攻撃面の拡大として「軽微」と判断し、セキュリティ上許容する。`X-Monomi-Hub-Version` の削除によるメリット（版非開示）よりも、child デバイスの版ずれ検知（§8.4 FR-04）や hub 自動再起動（§2.3 FR-02）の利便性を優先する設計判断。

---

## 9. ペアリングフロー

hub API は常時起動している前提。ペアリングは別モードではなく、常時稼働 API に生えた 2 エンドポイント（`src/hub/pairing-service.ts`・`pair-controller.ts`）。この「常時稼働」は release-18 以降、hub デバイスで `monomi`（引数なし）／`npx monomi-cli` を一度実行すれば自動起動（§2.3 FR-01）によって満たされ、`monomi hub` の明示実行を必須としない。

- **hub 側** `monomi hub pair`: 既に起動している hub API に loopback 宛でリクエストを 1 回投げるクライアント。`PairingService` が 6 桁コードを 5 分 TTL でメモリ上の Map に保持する（SQLite 永続化はしない）。あわせて LAN / Tailscale の到達先候補 URL を表示する。
- **child 側** `monomi pair --code <code> [--hub <url> ...]`: 到達先 URL を手動指定（複数可、指定順が到達優先順）して claim する。成功で発行された device_token を `~/.monomi/config.yml`（`role: child` / `hub_endpoints` / `device_id`）と token ファイルへ保存する（いずれも `chmod 600`）。mDNS 自動探索は現状スコープ外。
- **総当り対策（§0.3）**: `pair/start` は `socket.remoteAddress` のみで loopback 判定する。コード不一致 claim はアクティブな全コードの失敗回数を加算し、5 回で即無効化。正しいコードでの claim は単発破棄（再利用不可）。TTL 切れは `expired`(400)、不一致・使用済みは `invalid_code`(400)、申告 device が既存かつ有効トークン保持なら乗っ取り拒否 `device_conflict`(409) を返し `monomi hub devices revoke <id>` を案内する。
- **1 台体制**（hub のみ）はペアリング不要。hub 起動時（`bootstrap`。`monomi hub` の明示実行、または `monomi`/`npx monomi-cli` からの自動起動（§2.3）のいずれでも同じ `bootstrap` を通る）に hostname ベースで device_id を自動生成し、ローカル用 token を自動発行して `~/.monomi/token` へ書き出す。冪等（2 回起動しても重複しない）。
- **デバイス管理**: `monomi hub devices list` / `monomi hub devices revoke <id>`。

---

## 10. CLI 設計

### 10.1 ライブラリ

Ink（React reconciler + Yoga レイアウト）。フィルタ・展開など状態遷移の多い画面に宣言的状態管理が向くため採用。watch モードで常駐する用途なので起動コスト 1 回きりは許容範囲。CLI は status 導出ロジックを一切持たない（すべて hub 側 `StatusDeriver` / `InstanceStatusRollup` の責務）。`ClientRollup` は hub が返す numeric priority を `max()` するだけ。

### 10.2 画面イメージ

```
 Monomi ── 8 projects · 2 devices ───────────────────────── 14:32:07

  [1]稼働中 2   [2]権限待ち 1   [3]次の指示待ち 2   [4]PRレビュー待ち 1   [5]放置 2   [6]終了 1
 ─────────────────────────────────────────────────────────────────────────────
    PROJECT                 DEVICE     BRANCH                    STATE          AGE
  > ProjectLens              Mac mini   feature/ai-sidecar      ● 稼働中        2m
    Monban                   Mac mini   design-b/pty-injection  ○ 権限待ち      12m
 ─────────────────────────────────────────────────────────────────────────────
```

状態ラベル等はアクティブロケールに応じて `t()`（§12）で解決される。上記は `locale: ja` 設定時の表示例で、既定（`locale` 未設定）では英語表示になる（§12）。

実際の一覧描画は上記 ASCII の単純な行形式ではなく、`InstanceTable`（`src/cli/components/instance-table.tsx`）がレスポンシブなカードグリッド（1 instance = 1 枚の `InstanceCard`、列数は `card-grid.ts` の `columnsForWidth` が端末幅と TTY 判定のみから決める）として描画する。1 枚のカードは既定 6 行（release-24-dashboard-display-polish FR-05 で 5→6 行、既知課題 U18 対応）: `project` → `device` → `branch`（未設定は `-`） → `path` → `status`（グリフ＋ラベル＋age） → `running_work`（`▶ <name>`、`null` は `-` または branch と同じ扱い）。

- **`device` 行のターミナル併記（release-24-dashboard-display-polish FR-03、既知課題 U16 対応）**: `src/cli/terminal-display.ts` の `terminalDisplayName(termProgram, wslDistro)` が非 `null` を返すときのみ、`device-name (Ghostty)` のように括弧付きで追記する（カードの行数は増やさない）。`terminalDisplayName` は `session.terminal.term_program`（`Apple_Terminal`→`Terminal.app`、`ghostty`→`Ghostty`、`iTerm.app`→`iTerm2`、`vscode`→`VS Code`、`tmux`→`tmux`。未知値はそのまま返す）を優先し、`term_program` が `null`/空文字列のときのみ `wsl_distro` を代わりに返す。両方 `null`/空文字列なら `null`（device 名のみ表示、既知課題 U16 解消前と同じ見た目）。戻り値は reporter 由来の自由記述を含み得るため `sanitizeDisplayText` で除染してから連結する（CWE-150）。同じ関数を詳細ビュー（§10.4）の `terminal` フィールドからも呼ぶ（表示ロジックの単一化）。
- **`path` 行（release-24-dashboard-display-polish FR-04・FR-05、既知課題 U18 対応）**: `src/cli/truncate-path.ts` の `collapseHomeDir(path)`（`/Users/<name>/...`・`/home/<name>/...` → `~/...`）を適用した後、`truncateMiddle(path, maxWidth)` で `先頭…末尾` 形式の中間省略を行う（末尾のリポジトリ名・worktree 名の識別性を優先する末尾優先配分。Ink 標準の `wrap="truncate-end"`〈末尾省略〉だと末尾が消えて識別性が落ちるための専用ロジック）。`maxWidth` はカードの `width` prop から罫線＋`paddingX={1}` 分（計 4 桁）を引いた値、`width` 未指定（非TTY等の1列フォールバック）時は `box-border.ts` の `FALLBACK_BOX_WIDTH` を基準にする。`truncateMiddle`/`collapseHomeDir` は `box-border.ts` の `displayWidth`/`truncateToWidth`/`isFullWidthCodePoint`（release-24 で非公開→ `export` 化）を再利用し、全角文字混じりの path でも表示幅の判定基準を単一化する。`card-grid.ts` の `columnsForWidth` は幅・TTY 判定のみに依存し高さ（カードの行数）を見ないため、行数増加は列数計算に影響しない。

### 10.3 キーバインド（`src/cli/key-binding-controller.ts`）

| キー             | 動作                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `1`–`6`          | 状態フィルタのトグル（複数選択可、一覧表示中のみ。`6` は `closed`）                                |
| `j`/`k`・`↑`/`↓` | 一覧: カーソル移動（vim 流・矢印両対応） / 詳細: イベント履歴スクロール                            |
| `Enter`          | 選択 instance の詳細（Agent View Lv.1）を開く                                                      |
| `←`/`→`          | 詳細: 隣接プロジェクトへ移動（release-6 FR-04）                                                    |
| `w`              | 詳細: イベント行の折り返し/切り詰め切替（release-6 FR-08）                                         |
| `f`              | 選択 instance のセッション実行中ターミナルへフォーカス移動（一覧/詳細両方、release-23 FR-05。§14） |
| `esc`            | 戻る（ヘルプを閉じる／詳細から一覧へ）                                                             |
| `?`              | ヘルプオーバーレイの表示切替                                                                       |
| `q`              | 終了                                                                                               |

watch モードにトグルキーは持たない（ファジー検索 `/`・ソート `s`・デバイス循環 `d` は現状スコープ外）。一覧表示中は一覧用 `PollingLoop` が数秒おきに自動更新する。詳細ビュー（§10.4）表示中は、この一覧用 `PollingLoop` を `stop()` し、一覧へ戻ると `start()` し直す（release-20-dashboard-heap-guard FR-04、`docs/known-issues.md` B5 対応。詳細ビュー中の二重ポーリング・非表示一覧の無駄な再描画を回避）。詳細ビューは自身の独立した `PollingLoop` を持つ（§10.4）ため、ユーザー体験としては表示中の画面が常に自動更新される点は変わらない。`KeyBindingController.handleKey()` は release-20-dashboard-heap-guard FR-03 で戻り値を `boolean`（操作をディスパッチしたか）へ変更した。詳細は §10.5。

既定表示（フィルタ未選択時）では `status.display === 'closed'` の instance を一覧から自動的に除外する（`InstanceListStore.filtered()`、release-8 FR-01／`docs/known-issues.md` B6）。`6` キーで `closed` フィルタをトグルすれば表示できる（他フィルタとの複数選択も可）。ヘッダーの「X projects · X devices」件数は `filteredRows` から算出するため、既定表示では closed のみの project/device がそのぶん数から外れる（副次効果。実装上の特別対応はしていない）。

### 10.4 詳細ビュー（Agent View Lv.1）

1 instance を選択すると、上部「概要」BOX（instance_id・project・device・branch・status・running・session_id・path・terminal・pr。`running` は release-16 で追加した実行中の作業名で §8.4 参照。`terminal` は release-24-dashboard-display-polish FR-02（既知課題 U16 対応）で `path` の直後に追加した行で、§10.2 の `terminalDisplayName()` を再利用して `session.terminal` の `term_program`/`wsl_distro` から表示名を導出する。`session.terminal` が `null`（旧 reporter・情報未捕捉）、または導出結果が `null` の場合は他の nullable フィールドと同じ `-` 表示。i18n キーは `detail.terminal`（§12）。`pr` は release-27 で i18n ラベル化（`pr.none`/`pr.awaitingReview`/`pr.changesRequested`/`pr.approved`/`pr.merged`）＋draft 注記＋PR 番号の OSC 8 ハイパーリンク化を追加した（§15.8・§15.9））と下部「イベント履歴」BOX（`event_type` / `tool_name` / `tool_summary` 等、`GET /api/v1/instances/:id` の `recent_events`・直近 100 件）を、ともに端末幅一杯の罫線 BOX（タイトルを上辺に左寄せ埋め込み）として重ねて表示する。イベントは hub からは新しい順（API 契約は不変）で届くが、CLI 表示側で反転し古い順・最新が下端のターミナルログ風に描く。`j`/`k`・`↑`/`↓` で 1 行スクロールでき、最下部を表示している間は新着イベントに自動追従（tail-follow）、下辺罫線には表示範囲 `X-Y of Z`（`Z` は取得上限 100 件が上限）を右寄せで埋め込む。`w` でイベント行の切り詰め⇔全文折り返しを切替可能（既定は切り詰め）。詳細ビュー表示中はターミナルのタブ/ウィンドウタイトルが `project名 @ device名` に変わり、一覧に戻ると既定値 `Monomi` に戻る。LLM 要約 recap（Lv.2）は現状スコープ外。

上記の「概要」「イベント履歴」等のタイトル・見出しもアクティブロケールに応じて `t()`（§12）で解決される表示例（`locale: ja`）であり、固定文言ではない。

### 10.5 稼働監視ログとバックプレッシャー対策（cli.log、release-20-dashboard-heap-guard）

ダッシュボードを約65時間起動したまま放置すると V8 の OOM（`JavaScript heap out of memory`）でクラッシュする不具合が実機で確認された（`docs/known-issues.md` B11）。クラッシュ直前の GC ログは Mark-Compact でほぼ回収できておらず（回収率 0.1% 未満）、真性リークのシグネチャと判断した。CLI 側の配列無限増殖や `fs.watch` 等の未解放リソース、Ink `<Static>` の使用は調査で見つからず、最有力仮説は **stdout 書き込みバックプレッシャー未処理**——Ink には `stream.write()` の戻り値チェックや `'drain'` イベント待ちが無く、ターミナル側が読み出しを止める状況（バックグラウンドタブ・固まった SSH セッション・detach された tmux 等）で未消費バイト列が Node の Writable 内部バッファへ溜まり続ける——である。ただし heap snapshot 等の直接証拠は無く、本節の対策は確証済みの根本修正ではなく緩和策と診断手段の追加であり、仮説の最終確証は下記 `MemoryWatchdog` による実運用ログ観測（FR-01 AC-7）待ちで残存する。

- **`MemoryWatchdog`（`src/cli/memory-watchdog.ts`、FR-01）**: `monomi`（引数なし、ダッシュボード起動経路）実行時のみ、`cli.ts` の `startMemoryWatchdog` 経由で `ensureHubRunning()`／`maybePromptInstallHooks()`（§2.4）の後・ダッシュボード表示の直前に起動する（`hub` サブコマンドや `--help`/`--version` 経路では起動しない）。既定 60 秒間隔（`DEFAULT_SAMPLE_INTERVAL_MS`）で `process.memoryUsage()`（rss/heapTotal/heapUsed/external/arrayBuffers）と `stdout.writableLength` を `paths.cliLogFile`（`~/.monomi/cli.log`、`hubLogFile` と同じパターンで `resolvePaths()` に追加）へ 1 行 1 サンプルで `fs.appendFileSync` 追記する。書込み前に `ensureMonomiHome()`（§0.3）を呼ぶため、稼働中に `~/.monomi` が消えても次回サンプルで自己修復する。`sample()` 本体は try/catch で囲み `ENOSPC`/`EACCES` 等の失敗を静かに握りつぶす——診断ログの欠落でダッシュボード本体をクラッシュさせないため。`process.exit` は一切呼ばない（誤検知でダッシュボードが突然落ちる方がリスクが高いという判断）。内部タイマーは `unref()` 済みでプロセスの自然終了を妨げない。
- **バックプレッシャー判定の共有（`isStdoutBackpressured(stdout, thresholdBytes)`、FR-02）**: `stdout.writableLength >= thresholdBytes`（既定 64KB、`DEFAULT_BACKPRESSURE_THRESHOLD_BYTES`）を返す純粋関数。`memory-watchdog.ts` が export し、3箇所が同一の判定基準を共有する: ①`MemoryWatchdog` 自身が既定 3 回連続（`DEFAULT_BACKPRESSURE_WARN_CONSECUTIVE_COUNT`）の閾値超過を検出すると、その回のサンプル行を通常の `INFO` から区別可能な `WARN` 行として出力する、②`AppView`（§10.3）はポーリングの `onUpdate`/`onError` で `bump()`（再描画トリガー）を呼ぶ直前に判定し、バックプレッシャー中はスキップする（`store.setInstances()`/`setError` によるデータ更新自体は継続し、ドレイン後の次回描画で反映される）、③`WatchingIndicator`（§10.2）は 1 秒点滅の `setVisible` トグルをバックプレッシャー中はスキップする（`setInterval` 自体は止めない）。
- **既知課題 P4 の解消（FR-03）**: `AppView` は `store.filtered()` の呼び出しを 1 レンダー 1 回（`useMemo`）に統一し、`InstanceListStore.projectRows(rows?: InstanceStatusRow[])` に省略可能引数を追加して計算済みの filtered 結果を渡せるようにした（二重計算の解消）。`countByDisplay`/`projectRows`/`deviceCount` の集計値も `useMemo` 化した。`KeyBindingController.handleKey()`（§10.3）は戻り値を `void` から `boolean`（操作をディスパッチしたか）へ変更し、`AppView` の `useInput` はこれが `true` のときのみ `bump()` を呼ぶ（無効キー入力での無駄な再描画を防ぐ）。これらは間接的に stdout への書き込み量そのものを減らす対策でもある。
- **`cli.log` のローテーション（`release-21-known-issues-cleanup` FR-01、既知課題 S10 解消）**: `MemoryWatchdog.sample()` は追記の直前に `paths.cliLogFile` のサイズを確認し、`DEFAULT_LOG_ROTATION_THRESHOLD_BYTES`（既定 10MB）以上なら `paths.cliLogOldFile`（`~/.monomi/cli.log.old`、`resolvePaths()` が解決）へ `fs.renameSync` でリネーム退避してから新規 `cli.log` へ追記を再開する。直近 1 世代のみ保持し、既存の `cli.log.old` があれば上書きする。`cli.log` が未存在（初回 tick）の場合は `existsSync` でガードしローテーション判定自体をスキップする。ローテーション処理は専用の内側 try/catch で吸収し、失敗（`EPERM` 等）時はその tick のローテーションのみを見送ってサンプル追記は続行する（記録の継続をサイズ上限の厳守より優先する。codex adversarial review 対応、`docs/known-issues.md` S11 参照）。ローテーションは次 tick で再試行するため自己修復する。ディスク使用量は概ね閾値の2倍（`cli.log` + `cli.log.old` で最大約20MB）で頭打ちになる。`hub.log` は対象外（起動/停止でログが区切られる点が `cli.log` の絶え間ない追記と異なるため、`docs/known-issues.md` S10 参照）。

---

## 11. project_key 正規化

`src/domain/project-key-normalizer.ts` の `ProjectKeyNormalizer` が唯一の実装（§0.1）。他のどのクラスも正規化の詳細を知らない。

- **git remote あり**（`GIT_REMOTE`）: scheme / 認証情報を除去 → host 小文字化・ポート除去 → 末尾 `.git` 除去 → `host/owner/repo` 形式に固定。scp 形式（`git@host:owner/repo.git`）と URL 形式の両対応。GitLab のネストサブグループはパスを丸ごと保持。owner/repo の大小文字は保持し、host のみ小文字化する。
- **remote 無し git**（`LOCAL_NO_REMOTE`）: `local:{device_id}:{common-dir または cwd}`。
- **非 git**（`NO_GIT`）: `nogit:{device_id}:{cwd}`。

非 remote / 非 git は device_id を鍵に前置することで、クロスデバイス融合を構造的に禁止する（別マシンの無関係なローカルディレクトリが同一プロジェクトに融合しない）。表示名（`display_name` 未設定時）は project_key 末尾セグメントから自動生成する。

---

## 12. CLI 表示言語（i18n）

`src/i18n/`（`en.ts`・`ja.ts`・`index.ts`）が CLI 表示文言の翻訳層を担う（release-9-i18n、`docs/known-issues.md` I1 対応）。対象は CLI 表示層（`src/cli.ts`・`src/cli/status-display.ts`・`src/cli/components/*.tsx`）に加え、`cli.ts` の起動 notice チャネル（release-25-auto-update、§2.3・§3.1）向けに i18n 解決済み文字列を生成する関数（`src/cli/hub-autostart.ts` の `ensureHubRunning`、`src/install-hooks/install-hooks.ts` の `ensureReporterUpToDate`）も含む。これらは戻り値の notice 文字列がそのまま CLI 表示に流れるため、生成時点で `t()` により解決しておく必要がある（呼び出し元の `cli.ts` へ未解決のキーを持ち越さない設計）。hub 側 API・reporter（bash スクリプト本体）・pairing-client、および install-hooks のうち上記 `ensureReporterUpToDate` を除く関数群には実行時の日本語文字列が現存しないため、これらは引き続き i18n 化の対象外（意図的なスコープ境界。事前調査で確認済み）。`i18next` 等の外部 i18n ライブラリは導入せず、キー→文言マップの自前実装で済ませる（依存追加なし）。

- **文言テーブル**: `en.ts` の `EN` が authoritative（ground truth）で、`TranslationKey` 型はこのキー集合から導出する。`ja.ts` の `JA` は `satisfies Record<TranslationKey, string>` でキーの過不足を型チェック時に検出する（`pnpm tsc --noEmit`/`pnpm build` に依存し、`pnpm vitest` だけでは検出できない）。
- **解決**: `t(key, vars?)`（`src/i18n/index.ts`）が唯一の解決入口。`{var}` プレースホルダー置換に対応し、アクティブロケールのテーブルにキーが無ければ `EN` の値へフォールバックする。`resolveLocale(configLocale?, osLocale?)` が「`config.yml` の `locale:`、OS からの判定、既定 `en` の3階層で解決」唯一の場所（release-19 FR-02 AC-5）。
- **アクティブロケールの保持**: React context ではなく、`setActiveLocale`/`getActiveLocale` によるモジュールレベル・シングルトンで持つ（`status-display.ts` が全コンポーネントから使われる純粋モジュール関数である既存規約に合わせた設計）。CLI 起動時（`run()` 冒頭）に一度だけ `setActiveLocale(deps.loadLocale())` を実行する。`t()` をモジュールスコープの `const` 初期化から呼ぶと import 時点の既定ロケール（`en`）で文言が凍結される落とし穴があるため、`cli.ts` の `USAGE` はモジュール定数から関数（`usage(): string`）へ変更した。
- **config スキーマ**: `MonomiConfig.locale?: MonomiLocale`（`'ja' | 'en'`、`LOCALES` 定数、`src/config/config.ts`）を追加。`locale` に `ja`/`en` 以外の値を指定するとバリデーションエラーになる。ロケール解決優先順位は `config.yml` の `locale:` → OS からの自動判定（`detectOsLocale()`、`src/i18n/os-locale.ts`）→ 既定値 `en`（release-19 FR-02）。`detectOsLocale()` は macOS（`process.platform === 'darwin'`）では `defaults read -g AppleLocale` を最優先し、取得できない場合のみ `LANG` 環境変数へフォールバックする。非 macOS では `LANG` のみを見る。`LANG` は macOS のシステム言語設定と自動連動する保証がなく（ターミナルアプリの設定・シェルプロファイル依存で古い値のまま残ることがある）、`LANG` のみに依存する設計では実際のシステム言語を反映できないケースが実機検証で見つかったため、`AppleLocale` を優先する設計へ修正した（いずれも `ja`/`en` のみを判定対象、他は `undefined` で次段階へ）。
- **既定表示言語の変更（重要・仕様変更）**: 本リリース以前は文言が日本語決め打ちだったが、本リリース以降は `config.yml` に `locale: ja` を明示しない限り既定表示言語は英語になる。既存の日本語運用は `locale: ja` の追記が移行対応として必要。
- 移行対象は `status-display.ts`（状態ラベル、最優先移行）と `app-view.tsx`／`detail-view.tsx`／`help-overlay.tsx`／`instance-table.tsx`／`status-filter-bar.tsx`。`instance-card.tsx` は文言を直接持たず `status-display.ts` 経由のため変更不要。

**自動更新設定（release-25-auto-update FR-05）**:
`MonomiConfig.auto_update?: boolean`（既定 `true`、省略時 `true`）を追加（`src/config/config.ts`）。`false` のとき、hub の自動再起動（§2.3 FR-02）と reporter の自動上書き（§3.1 FR-03）を抑止し、版ずれの notice 表示のみ行う（child の版ずれ可視化（§8.4 FR-04）は設定に関わらず常に有効）。設定例は `config.yml` インライン記法で記載。

---

## 13. バージョン管理

`src/version.ts`（新規の葉モジュール）が `MONOMI_VERSION` の定義を一元管理する唯一の実装。`import packageJson from '../package.json' with { type: 'json' }`（`tsconfig.json` の `resolveJsonModule: true` が前提）で `package.json` の `version` を実行時に動的読み込みし、`monomi --version` と TUI 表示の両方をここへ単一ソース化する（以前は `src/index.ts` に文字列をハードコードし、bump のたびに手動で二重更新していた）。

- **依存の向き**: `src/index.ts`（公開 API バレル）は `version.ts` から re-export するのみで値を持たない。`app-view.tsx`／`help-overlay.tsx`（TUI 表示用）も `version.ts` から直接 import する。バレル経由（`index.ts` から取得）にすると、`index.ts`（`AppView` を re-export）→ `app-view.tsx` → `index.ts` の循環依存が生じるため、値の定義を `version.ts` へ切り出し、バレル・内部コンポーネントの双方から一方向に参照させる。
- **版比較（release-25-auto-update）**: `src/version-compare.ts` の `compareVersion(other, self = MONOMI_VERSION)` が「自版と他方バージョン文字列の相対関係（`'older'`/`'same'`/`'newer'`/`'unknown'`）」を返す唯一の実装で、FR-02（hub 自動再起動、§2.3）・FR-03（reporter 版マーカー照合、§3.1）・FR-04（child のリモート hub 版ずれ可視化、§8.4）が共通で使う。比較そのものは §2.4 の `src/node-version-check.ts` の `parseVersionTriple`/`compareVersionTriples`（major.minor.patch の数値比較）を再利用する薄いラッパーで、semver パッケージは追加しない。パース不能・欠落は `'unknown'` を返し、呼び出し側はこれを `'older'` と同一の更新経路（自動更新・上書き対象）に載せる（「版不明 = 旧版」ポリシーをこのモジュール1箇所に集約）。
- **TUI 表示**: ヘッダーの「Monomi」バッジ直後に `v{MONOMI_VERSION}` を dim 表示する（§10.2）。ヘルプオーバーレイ（`?`）はキーバインド一覧末尾に `Monomi v{MONOMI_VERSION}` の1行を追加する（`HELP_OVERLAY_ROWS` はこの1行ぶん加算済み）。いずれもロケールに依存しない技術的表示のため i18n キー（§12）は介さない。
- **bump の安全弁**: `package.json` の `scripts.preversion` に `pnpm run test` を必須化し、テストが red の状態での `pnpm version <patch|minor|major>`（`version:patch`/`version:minor`/`version:major` 経由の呼び出しを含む）を bump・commit・tag いずれも実行せず失敗させる。bump の実行手順・`main` 直接 push の例外運用は `docs/development-workflow.md` を参照（本ドキュメントでは重複記載しない）。
- **npm 公開（release-17 以降）**: `package.json` は `monomi-cli` として公開可能な状態（`private` 未設定・`license: MIT`・`engines.node`・配布物を限定する `files`）に整備済み。`v*` タグ push を契機に test/build ゲート後 npm publish する CI/CD パイプラインを GitHub Actions として用意した。実際の初回 publish・`NPM_TOKEN` 発行・`pnpm version:minor` 実行はマージ後の手動運用ステップで、手順は `docs/development-workflow.md` を参照。
- **GitHub Release 自動作成（release-22、既知課題 N5 解消）**: `publish.yml` のステップ順序を「test → build → リリースノート抽出 → npm publish → GitHub Release 作成」へ拡張し、npm publish 成功後に `gh release create "${GITHUB_REF_NAME}" --verify-tag` で GitHub Release を自動作成する。リリースノート本文は新設 `scripts/extract-changelog-notes.mjs`（単体テスト付き）が `CHANGELOG.md` から該当バージョンの節（`## [x.y.z]` 見出しから次の `## [` 見出し直前までの本文）を抽出して stdout へ出力したものをそのまま `--notes-file` へ渡す（CHANGELOG を単一ソースとし Release 本文の二重管理をしない）。該当バージョンの見出しが無い、または本文が空の場合は非0で終了し、npm publish 実行前にジョブを失敗させる（fail fast）。Release 作成には `contents: write` 権限が要るため `permissions` を `read` から `write` へ変更した（この権限が Release 作成と無関係な checkout〜build 等のステップにも及ぶ点は未解消で既知課題 S13 として残存、`docs/known-issues.md` 参照）。`gh` は GitHub ホステッドランナー同梱のものを使い、新規のサードパーティ Action は追加していない。
- **スコープ外**: バージョン bump 後の `git push` 自動化。

---

## 14. ターミナルフォーカス（`f` キー、release-23。release-28-wezterm-focus で WezTerm 対応を追加）

一覧・詳細ビューで instance を選択中に `f` キー 1 発で、そのセッションが実行中のターミナルタブ/ウィンドウへフォーカスを移す（既知課題 U9 解消。参考実装 [claude-code-monitor](https://github.com/onikan27/claude-code-monitor) の方式調査に基づく）。データフローは「reporter が TTY 等を捕捉（§3）→ hub が `sessions` へ保存（§7.3/§7.5）→ API で `session.terminal` として露出（§8.4）→ CLI の `FocusService` が strategy を選んで前面化」。

### 14.1 対応範囲

- **対象ターミナル**: Terminal.app・Ghostty・tmux・WezTerm（併用可）。iTerm2・VS Code 統合ターミナルはスコープ外だが、strategy を配列へ追加するだけで拡張できる構造にしている（§14.3）。
- **対応 OS**: macOS・WSL2。
  - **macOS**: Terminal.app・Ghostty・WezTerm・tmux のいずれも対応。WezTerm は追加設定不要でペイン単位フォーカスが効く。**`wezterm cli activate-pane` は mux 内部のペイン選択のみを変え OS レベルのウィンドウ前面化は行わないため**（実機検証で判明）、`WeztermFocusStrategy` は成功後に AppleScript `tell application "WezTerm" to activate`（`raiseWeztermWindowDarwin`）を追加実行して初めてウィンドウが前面化・フォーカスされる（§14.3）。
  - **WSL2**: `$WEZTERM_PANE` を捕捉できれば WezTerm ペイン単位フォーカスを先に試行し、未検出（未設定・従来ユーザー）またはフォーカス失敗時は既存の Windows Terminal ウィンドウ前面化（タブ単位の特定はスコープ外）へフォールバックする（後方互換維持）。WSL2 で WezTerm フォーカスを使うには、利用者側で Windows 側 `.wezterm.lua` に `WSLENV` へ `WEZTERM_PANE` を追記する設定が前提（自動設定はしない設計判断、§14.5）。macOS と同様 `activate-pane` だけでは前面化されないため、`raiseWeztermWindowWsl`（`wezterm-gui` プロセスへ `SetForegroundWindow`）を追加実行する。**実機検証で確認済みの制約**: Monomi CLI（ダッシュボード）と対象セッションの WSL2 シェルの両方が WezTerm のペイン内から起動されている場合は `activate-pane`・前面化とも成功するが、いずれか一方でも別の Windows ターミナルアプリ（PowerShell 等）経由で起動した WSL2 シェルでは `wezterm.exe cli activate-pane` が mux ソケットへの接続に失敗する（upstream の議論、wezterm/wezterm discussions #6964 と一致）。`verifyActivation` がこの失敗を検知し既存の Windows Terminal フォールバックへ進めるが、Windows Terminal を使っていない場合はどちらの経路でも前面化されない（既知の制限、known-limitations.md 参照）。
  - **ネイティブ Linux（X11/Wayland）**: 未対応のまま（既知課題 U21）。release-28-wezterm-focus の壁打ち当初は「`wezterm cli` 呼び出しのみで完結し X11/Wayland のウィンドウ操作 API に依存しない」という前提でスコープに含めていたが、macOS の実機検証で `activate-pane` 単体では OS レベルの前面化が行われないことが判明し（上記 macOS の項参照）、ネイティブ Linux 向けの X11/Wayland 非依存な前面化手段を用意できなかったため、未検証のまま対応と謳うのを避けスコープから外した。`focus-service.ts` のディスパッチ構造（`weztermStrategy` オプション）自体は汎用のまま残しており、前面化手段が見つかり実機検証できれば `cli.ts` から再配線できる。
  - **tmux と WezTerm の併用構成**（tmux pane が WezTerm pane 内で動く構成）はスコープ外のまま。既存の tmux 優先ロジック（外側クライアント TTY で以降の判定を続行）がそのまま勝ち、外側ウィンドウ前面化のみになる（§14.3 ディスパッチ参照）。ネストした tmux（tmux in tmux）の解決も引き続きスコープ外。
- **別デバイスの instance**: フォーカス移動は CLI と同一マシンのセッションに限定する（device_id 照合、§14.2）。

### 14.2 CLI 配線（`src/cli/key-binding-controller.ts`・`src/cli/components/app-view.tsx`）

- `KeyBindingHost` に `focusTerminal()` を追加し、`KeyBindingController.handleKey()` は viewMode によらず（list/detail 両方）`f` をこれへディスパッチして `true` を返す。実行可否の判断はコントローラーの責務ではなく host（`AppView`）側が担う。
- `AppView` は `runDashboard()`（`src/cli.ts`）から注入された `localDeviceId`（`loadConfig().deviceId ?? deriveDeviceId(os.hostname())`。`bootstrap.ts` と同一規則）と `focusRunner`（`FocusService`、DI でテストは mock に差し替え）を持つ。`focusTerminal()` は選択行に対し次の順でゲートし、いずれかで不合格なら理由別 notice を表示して実行しない:
  1. 選択行なし → 何もしない（no-op）
  2. 選択行の `device.id !== localDeviceId` → `focus.otherDevice`
  3. `status.display === 'closed'`（stale TTY 誤爆防止）→ `focus.sessionClosed`
  4. `session.terminal` が無い、または `tty`/`tmuxPane`/`weztermPane`（release-28-wezterm-focus で追加。実機検証で判明した所見への対応 — 以前は `tty`/`tmuxPane` のみを見ており `weztermPane` のみ有効な行を誤って縮退させていた）のいずれも検証を通らない → `focus.noTerminalInfo`
  5. 上記いずれも通過すれば `focusRunner` を実行し、`FocusResult`（§14.4）が `ok` 以外なら理由別 notice（`focus.tmuxDetached`/`focus.notFound`/`focus.unsupported`/`focus.failed`）を表示する
- 成功時（`ok`）は notice を出さない（タブ/ウィンドウの前面化自体がフィードバックのため）。notice は既存の `error` state と同様の時限式 state（約 4 秒で自動消去、タイマーの cleanup とアンマウント後 setState 防止ガード付き）で表示する。
- フッターヒントは、選択中の行が同一デバイス（`device.id === localDeviceId`）のときのみ ` f focus` を表示する。
- ヘルプオーバーレイ（`?`）の `HELP_LINES` に `f` 行（`help.focusTerminal`）を追加。`focus.*`（`otherDevice`/`noTerminalInfo`/`sessionClosed`/`tmuxDetached`/`notFound`/`unsupported`/`failed`）と `help.focusTerminal` の i18n キーを `en.ts`（authoritative）と `ja.ts` の両方に追加する（§12 の規約どおり）。`focus.notFound`/`focus.failed` の文言には Ghostty 利用時のヒント（アクセシビリティ許可・`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`）を含める。

### 14.3 `src/cli/focus/`（フォーカス実行モジュール）

`focus-target.ts`・`osascript.ts`・`applescript.ts`・5 strategy（`terminal-app-strategy.ts`・`ghostty-strategy.ts`・`tmux-strategy.ts`・`wsl-strategy.ts`・`wezterm-strategy.ts`。最後は release-28-wezterm-focus 新設）と `focus-service.ts` から成る。iTerm2 等の対応追加は、共通 `Strategy` インターフェイス（ヒント一致判定 `matchesHint(target)` + `focus(target)`）を実装した strategy を配列へ足すだけで済む構造にしている。

- **`focus-target.ts`**: hub API が返す `TerminalDto`（snake_case wire。§8.4）を厳格検証し、CLI 内部用の `FocusTarget`（camelCase）へ写す。不合格フィールドは個別に「情報なし」（`null`）へ縮退させる（オブジェクト全体は拒否しない。例えば `tty` が不正でも `tmux_pane` が有効なら tmux strategy は機能しうるため）。`wezterm_pane`（release-28-wezterm-focus FR-03a）は `sanitizeWeztermPane()` が `/^\d+$/`（数字のみ）で検証し、不合格は `null` へ縮退する。
- **`Strategy.focus()` のシグネチャ（release-28-wezterm-focus FR-04-pre、破壊的変更）**: release-23 時点の `focus(tty: string)` から `focus(target: FocusTarget)` へ変更した。`WeztermFocusStrategy` は `tty` ではなく `target.weztermPane` を必要とするため、tty 単独ではなく検証済み `FocusTarget` 全体を受け取る形に統一している。既存の `TerminalAppStrategy`/`GhosttyStrategy` は内部で `target.tty` を参照するよう追従し、`target.tty === null`（`weztermPane` のみ有効なケースを含む）なら自身で `not_found` を返す（従来の「呼び出し側が非 null を保証する」前提を廃止し、各 strategy がフィールドごとに自身の前提を検証する形にした）。
- **`focus-service.ts`（ディスパッチ、release-28-wezterm-focus FR-04 で拡張）**: 手順は次のとおり。
  1. `tmux_pane` があれば先に tmux strategy でクライアントを解決・切替し、成功すれば外側クライアント TTY へ差し替えて続行する。この際 `weztermPane` は `null` へ縮退させる（tmux 併用時の WezTerm ペイン特定はスコープ外で、tmux 切替前に捕捉した `weztermPane` は切替後の外側クライアントに対応するとは限らないため。review-changes 修正）。tmux 切替の失敗（`tmux_detached`/`error`）はそのまま最終結果として返す。
  2. （tmux 切替後を含め）`tty` と `weztermPane` の両方が無ければ `no_terminal`（release-28-wezterm-focus 以前は `tty === null` のみで確定していたが、`weztermPane` のみでも WezTerm 経路が機能しうるよう緩和した）。
  3. `platform === 'darwin'` なら `darwinStrategies`（Terminal.app・Ghostty・`WeztermFocusStrategy`）を `term_program` ヒント（Terminal.app / Ghostty / WezTerm）で並べ替えた総当たり（tmux 内は `TERM_PROGRAM=tmux` でヒント不能なため総当たりが本命）。
  4. darwin でなく WSL2（`WSL_DISTRO_NAME` または `/proc/version` の `microsoft`）なら、`weztermPane` があれば先に `WeztermFocusStrategy`（`command: 'wezterm.exe'`、WSL interop 経由）を試行し、`ok` 以外なら既存の wsl strategy（Windows Terminal 前面化）へフォールバックする。`weztermPane` が無ければ従来どおり即座に wsl strategy。
  5. それ以外（ネイティブ Linux 等）は `unsupported_platform`。`FocusServiceOptions.weztermStrategy` を配線すれば `weztermPane` があるとき `WeztermFocusStrategy` を試行する構造自体はあるが、`cli.ts` の既定実装は意図的に配線していない（既知課題 U21）。

  結果は `FocusResult`（`ok | no_terminal | tmux_detached | not_found | unsupported_platform | error`）。

- **strategy 詳細**:
  - **Terminal.app**（`terminal-app-strategy.ts`）: `tell application "Terminal"` ブロックへ入る前に、System Events で `exists process "Terminal"` を確認するガードを置く（release-24-dashboard-display-polish FR-06、既知課題 B12 解消）。AppleScript の `tell` は対象アプリが未起動だと Apple Events 送信経由でアプリ自体を自動起動させてしまう仕様のため、このガードで未起動時は `tell application "Terminal"` へ進まず `"false"`（→ `not_found`）を返し、Terminal.app の意図しない自動起動を防ぐ。起動済みなら従来通り AppleScript で windows/tabs を走査し `tty of aTab` が対象 TTY と一致するタブを選択、ウィンドウを前面化して `activate`。osascript の stdout `true` で成功判定する。
  - **Ghostty**（`ghostty-strategy.ts`）: AppleScript からは tty を取得できないため、対象 TTY デバイスファイルへ OSC タイトルタグ（`monomi:<tty のベース名>`）を書き込み、System Events で Ghostty の Window メニューをタグ名で検索してクリック（2 回 + `AXRaise`）して前面化する。**タグ書き込みより前に** System Events で Ghostty プロセスの存在確認を行うよう順序を変更しており（release-24-dashboard-display-polish FR-06、既知課題 B12 解消）、未起動なら `writeTtyTitle` を一切呼ばずに `not_found` を返す（変更前は先にタグを書き込んでいたため、Ghostty 未起動時に対象外ターミナルのタブタイトルが一瞬変化する副作用があった）。起動済みの場合の書き込み→メニュー操作の手順が失敗した場合はプロセス存在確認からやり直して 1 回だけリトライし、タグを書き込んだ試行が 1 回でもあれば `finally` で必ずタグを消去する（一度も書き込んでいなければ消去自体を省略する）。**アクセシビリティ許可**と環境変数 **`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`** が前提（§14.5）。
  - **tmux**（`tmux-strategy.ts`）: `tmux -S <socket> list-clients` でアタッチ中クライアントを解決する。0 件なら `tmux_detached` を返し、複数あれば `client_activity` 最大のクライアントを採用する。`switch-client`/`select-window`/`select-pane` を実行し、外側ターミナル（Terminal.app/Ghostty/WezTerm 等）はクライアント TTY を使って続けて前面化する。
  - **WSL**（`wsl-strategy.ts`）: `powershell.exe` 経由で Windows Terminal のウィンドウを前面化する（best-effort。タブ単位の特定はスコープ外）。`weztermPane` が無い、または `WeztermFocusStrategy`（WSL 用インスタンス）が `ok` を返せなかった場合のフォールバック先（§14.3 ディスパッチ手順 4）。
  - **WezTerm**（`wezterm-strategy.ts` の `WeztermFocusStrategy`、新規、release-28-wezterm-focus FR-03b）: WezTerm 公式 CLI を `execFile`（非 shell）で呼び出す。`<command> cli activate-pane --pane-id <weztermPane>` を実行し、exit 0 なら `ok`、`ENOENT`（バイナリ不在）なら `not_found`、それ以外の失敗（タイムアウト含む）なら `error`。`command` はコンストラクタ引数（darwin は `'wezterm'`、WSL2 interop 経由は `'wezterm.exe'`）で同一実装を両環境に使い回す。単一文字列に加え候補の配列も受け付け、先頭候補が `ENOENT` のとき次候補へフォールバックする（実機検証で判明した所見への対応。macOS では `cli.ts` が `['wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm']` を渡す）。既定 **5 秒タイムアウト**（`WEZTERM_EXEC_TIMEOUT_MS`）を持ち、`wezterm`/`wezterm.exe` がハングしても `focus()` は無期限に解決しないまま留まらない。あわせて **in-flight ガード**（インスタンス単位で前回呼び出し未完了時は新規 `execFile` を起動せず進行中の Promise を共有）を持ち、`f` キー連打による子プロセス蓄積を防ぐ。任意の `verifyActivation` オプション（既定 `false`。`cli.ts` が WSL 用インスタンスにのみ `true` を渡す）は `activate-pane` 成功後に `<command> cli list --format json` で対象 pane id の実在を確認し、確認できなければ `ok` ではなく `error` に丸める——WSL interop 経由の呼び出しは exit 0 でもサイレント失敗しうる（upstream の議論、wezterm/wezterm discussions #6964）ため、既存の Windows Terminal フォールバックへ確実に進められるようにする後追い検証(この検証は「pane がまだ mux 上に存在するか」の確認に留まり「前面化が実際に効いたか」までは確認できない）。**任意の `raiseWindow` オプション**（実機検証で判明した所見への対応）: `wezterm cli activate-pane` は mux 内部のペイン選択のみを変え OS レベルのウィンドウ前面化を行わない（macOS 実機で確認済み。`wezterm cli --help` にも `activate-window` 相当のサブコマンドは無い）ため、`activate-pane`/`verifyActivation` 成功後に前面化を行う関数を注入できる。`cli.ts` は darwin インスタンスへ `raiseWeztermWindowDarwin`（AppleScript、System Events で `WezTerm` プロセス存在確認後に `activate`。B12 と同種のガード）、WSL 用インスタンスへ `raiseWeztermWindowWsl`（`wsl-strategy.ts` と同型の `SetForegroundWindow`、`wezterm-gui` プロセス対象。実 Windows/WSL2 環境で動作確認済み — ただし WezTerm 経由で起動した WSL2 シェルに限る。詳細は §14.1）を渡す。`raiseWindow` が例外を投げた場合も `activate-pane` 自体の成否に関わらず `error` に丸め、無条件の成功にしない。ネイティブ Linux 向けの `raiseWindow` 相当は未検証のため用意しておらず、`FocusServiceOptions.weztermStrategy` 自体を `cli.ts` から配線していない（既知課題 U21、§14.1）。
- **セキュリティ三段防御（S9/S12 と同じ脅威モデル。reporter 由来の値は「認証済みだが信頼しない」）**:
  1. **`focus-target.ts` の厳格検証**: `tty` は `/^\/dev\/[A-Za-z0-9._\/-]+$/` かつ `..` 非含有、`tmux_pane` は `/^%\d+$/`、`tmux_socket` は絶対パスかつ制御文字・引用符を含まないこと、`wezterm_pane` は `/^\d+$/`（数字のみ）。`term_program`/`wsl_distro`/`wt_session` は strategy 選定のヒントにのみ使い（AppleScript・シェルへ埋め込まない）、この厳格検証の対象外。
  2. **`applescript.ts` の `escapeAppleScriptString()`**: AppleScript へ埋め込む文字列は必ずこの関数（`\` と `"` をエスケープ）を経由してから組み立てる。
  3. **`execFile`（非 shell）起動**: 子プロセスは shell を経由しない `execFile` で起動する。Terminal.app/Ghostty strategy は `osascript.ts` の `runOsascript()` を経由し、tmux/WSL/WezTerm strategy は AppleScript を使わないため `osascript.ts` には依存せず、`tmux`/`powershell.exe`/`wezterm`(`.exe`) をそれぞれ独立宣言の同形 `ExecFileFn`（共有モジュール化はしていない）で直接起動する。いずれも外部プロセス起動は `ExecFileFn` 型で DI 可能にし（`src/cli/hub-autostart.ts` の `SpawnFn` と同じ「テストでは mock、実行時は `node:child_process` を注入」パターンを踏襲）、strategy のテストは実プロセスを起動せずコマンド・引数・stdout の判定を検証する。`WeztermFocusStrategy` は pane id を引数配列の要素として渡す（数字のみの検証と合わせた二段防御、review-changes 修正）。

### 14.4 `FocusResult`

| 値                     | 意味                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `ok`                   | 対象タブ/ウィンドウの前面化に成功した                                           |
| `no_terminal`          | 対象セッションにターミナル特定情報が無い（旧 reporter 由来、または非 TTY 実行） |
| `tmux_detached`        | `tmux_pane` はあるが、アタッチ中の client が 0 件                               |
| `not_found`            | いずれの strategy でも対象タブ/ウィンドウを特定できなかった                     |
| `unsupported_platform` | 対応ターミナル/OS の組み合わせ外（ディスパッチがどの strategy にも到達しない）  |
| `error`                | strategy 実行中に想定外の例外が発生した                                         |

### 14.5 既知の前提条件（自動設定しない設計判断）

`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` の設定と macOS アクセシビリティ許可は、**`install-hooks` などでは自動設定しない**。全ターミナルで Claude Code の動的タイトル書き換えを止める副作用が大きいこと、`~/.claude/settings.json` への書き込み範囲拡大を避けたいこと（既知課題 U12 関連）が理由。README（利用者向け設定手順）とフォーカス失敗時の notice（`focus.notFound`/`focus.failed`）のヒント文言で案内する（既知課題、`docs/known-issues.md` 参照）。

同様に、WSL2 で WezTerm ペイン単位フォーカスを使うための Windows 側 `.wezterm.lua` への `WSLENV`（`WEZTERM_PANE` を追記）設定も**自動設定しない**（release-28-wezterm-focus、既知課題 U17 解消時の設計判断）。Ghostty の場合と同様、`reporter`/`install-hooks` 側から利用者のターミナル設定ファイルを書き換える範囲拡大を避けるため。未設定のままでも `terminal.wezterm_pane` が `null` になるだけでエラーにはならず、既存の Windows Terminal 前面化フォールバック（§14.1・§14.3）へ自然に縮退する。設定手順は README の「WezTerm: pane-level focus」節に記載する。

---

## 15. GitHub PR ポーリング（`GithubPrPoller`、release-27）

既知課題 U7（PR レビュー待ちが実装されておらず `pr` が常に `none` のまま変わらない）に対応する。`src/hub/github-pr-poller.ts` の `GithubPrPoller` は `serve()` 起動シーケンス（`server.listen()` 後）で生成・起動され、`HubHandle.close()` から確実に `stop()` される。データフローは「`InstanceRepository.listActive()` から対象 branch を収集（§15.1）→ `gh` CLI で PR 情報取得（§15.2・§15.3）→ `mapPrToStatus()` で写像（§15.5）→ `PrStatusRepository.upsert()` へ永続化 → `hasPrWaiting` として status 導出へ配線（§15.6）→ wire `pr` フィールド（§8.4）・CLI 詳細ビュー（§15.8・§15.9）で表示」。

### 15.1 対象収集

`collectTargets()` が `InstanceRepository.listActive()` から `(project_id, branch)` のユニーク組を洗い出す。対象化条件は「`instance.branch !== null`」かつ「所属 project の `projectKey.kind === 'GIT_REMOTE'`」かつ「`projectKey.value`（正規化済み `host/owner/repo`、§11）が `github.com/` で始まる」（GitHub 以外のホストはスコープ外）。`config.yml` の `github_pr_poll.allowed_repos`（§15.10）が設定されている場合はさらに `owner/repo` がその allowlist に含まれるものだけへ絞り込む。

### 15.2 `gh` CLI 呼び出し

対象 branch ごとに `gh pr list --repo <owner>/<repo> --head <branch> --state all --json number,state,reviewDecision,isDraft,url` を `execFile`（非 shell。既存 `osascript.ts`/`tmux-strategy.ts` と同じ「テストは mock、実行時は `node:child_process` を注入」DI パターン、§14.3）で呼び出す。既定 15 秒（`GH_EXEC_TIMEOUT_MS`。他モジュールの疎通確認用 timeout より長め）でタイムアウトし、`gh` の応答停止（認証プロンプト待ち等）で hub が無期限にハングしない。同一 branch に複数 PR が存在する場合は `pickLatestPr()` が OPEN を優先しその中で番号最大（＝最新）を採用する（OPEN が無ければ全件中の番号最大。fork からの重複 PR 等を想定）。

- **サイクルの直列化**: `pollOnce()` は進行中サイクルの目印として `AbortController` を保持し、前サイクルが完了していない間は即座に return して `gh` 呼び出しを一切行わない（`setInterval` は前回 tick の完了を待たないため、直列化しないと後発サイクルが古い応答で先発サイクルの新しい状態を上書きしうる巻き戻りが起きる）。
- **個別 branch の失敗**: try/catch で捕捉しログへ残すのみで、当該 branch の `pr_status` 行は前回値を保持し、他 branch のポーリングやサイクル自体を止めない。
- **`stop()`**: タイマー停止に加え、進行中サイクルがあれば `inFlightController.abort()` で `gh` の子プロセスを起動途中含めて中断する。

### 15.3 `gh` 未導入・未認証・稼働中の認証失効

`start()` は `gh auth status` の成否で可用性を判定し、失敗（未導入は `ENOENT`、未認証は非 0 終了）なら `disabledDueToGh` を立てて 1 回だけ警告ログを出し、ポーリング自体を no-op にする（既存ダッシュボード動作には影響しない、後方互換）。稼働開始後の認証失効も検知する: 1 サイクル内の対象 branch が 1 件以上あり、かつ全件失敗した場合にのみ `gh auth status` を再確認し、なお失敗していれば起動時と同じ「無効化 + 1 回警告 + `stop()`」に倒す（個別 branch の孤立した障害はここでは無効化対象にしない）。

### 15.4 対象が複数 owner/org にまたがる場合の警告（confused-deputy 対応）

ポーリング対象の `(project_id, branch)` は reporter が申告する `project_key`/branch 由来で、hub は自身の `gh` 認証情報でこれを問い合わせる。ペアリング済み device が任意の `github.com/owner/repo` を申告すれば、hub の権限で当該 repo の PR 状態が問い合わせられてしまう confused-deputy 構造があるため、`config.yml` の `github_pr_poll.allowed_repos`（§15.10）で運用者が明示的に制限できる。未設定（既定）は後方互換のため従来どおり全 branch を対象にするが、対象が複数 owner/org にまたがる場合は `start()` が 1 回だけ警告ログを出す（単一 owner のみの構成では偽陽性を避けるため警告しない）。

### 15.5 マッピング（`mapPrToStatus()`、`src/domain/pr-status-mapper.ts`）

DB アクセス・`gh` 呼び出しを持たない純粋関数（`ProjectKeyNormalizer`・`toRunningWorkDto` と同じ「純粋関数を domain 層に置く」方針を踏襲）。

| `gh` の `state`               | `reviewDecision`                | → `pr_status.state` |
| ----------------------------- | ------------------------------- | ------------------- |
| PR 無し／`CLOSED`（未マージ） | —                               | `none`              |
| `OPEN`                        | `null` または `REVIEW_REQUIRED` | `awaiting_review`   |
| `OPEN`                        | `CHANGES_REQUESTED`             | `changes_requested` |
| `OPEN`                        | `APPROVED`                      | `approved`          |
| `MERGED`                      | —                               | `merged`            |

`isDraft` は上記の分岐と独立してそのまま `is_draft` へ反映する（draft PR は主に `awaiting_review` と組み合わさる想定だが、値自体は状態遷移から切り離して保持する）。

### 15.6 スキーマ拡張と `hasPrWaiting` 配線修正（既知課題 U7 本体）

- **`pr_status.is_draft`**（§7.3）: `INTEGER NOT NULL DEFAULT 0`。新規 DB は DDL で作成し、既存 DB は §7.5 の冪等マイグレーションで追随する。
- **配線バグの修正**: `src/hub/instance-status-service.ts` は従来、常時 `false` 固定のモジュール定数 `HAS_PR_WAITING` を各 session の `deriveForSession()` へ渡しており、同ファイル内で計算される実際の `pr`（`instance.branch` 別の PR 状態）は wire `pr` フィールド表示にしか使われず判定には無反映だった。`PrStatusRepository.upsert()` を呼ぶ poller（本節）自体は release-27 で新設されたが、この配線を直さない限り実データが入っても `PR_WAIT` 表示には反映されない。`HAS_PR_WAITING` 定数を削除し、`prStatus.findByProjectBranch()` の結果を `entries` 構築（`deriveForSession()` 呼び出し）より前に計算した `hasPrWaiting = pr !== null && pr.state === 'awaiting_review'` を各 session の status 導出へ渡すよう修正した。draft PR も `awaiting_review` に含まれるため `PR_WAIT` の対象になる（§15.5）。

### 15.7 wire DTO 拡張（`PrDto`、§8.4）

`src/hub/dto.ts` の `PrDto` に `number: number | null`・`url: string | null`・`is_draft: boolean` を追加し、`toPrDto(pr: PrStatus | null)` が `pr` が `null`（対象外ブランチ等）なら `{ state: 'none', number: null, url: null, is_draft: false }` の既定値を返す（他の wire 変換と同じ「ドメイン型→薄い変換→wire DTO」パターン）。`GET /api/v1/instances`・`GET /api/v1/instances/:id` いずれの `pr` フィールドもこの形になる。

### 15.8 CLI 表示（詳細ビュー、`detail-view.tsx`）

詳細ビュー（§10.4）の `pr` フィールドは、i18n ラベル（`pr.none`/`pr.awaitingReview`/`pr.changesRequested`/`pr.approved`/`pr.merged`。`en.ts`・`ja.ts` 両方に追加、§12 の規約どおり）+ PR が存在する場合のみ `#<number>` を付記し、`is_draft: true` のときは末尾に `(<pr.draft の訳語>)` を付けて区別表示する。一覧カード（`instance-card.tsx`）への表示追加は本リリースのスコープ外（§15.11）。

### 15.9 OSC 8 ハイパーリンク（`src/cli/osc8-hyperlink.ts`）

`toOsc8Hyperlink(text, url)` が PR 番号（`#<number>`）を OSC 8 エスケープ（`\x1b]8;;<url>\x07<text>\x1b]8;;\x07`）でラップし、対応端末（Ghostty/iTerm2 等）でクリック可能にする。`url` は `isLinkableGithubUrl()`（`URL` でパースしたうえでスキーム `https:`・ホスト `github.com` 完全一致・資格情報なし・`/owner/repo/pull/<正の整数>` 形式のパス・文字列全体に ASCII 制御文字を含まないことを検証）を通らない限りエスケープを生成せず `text` をそのまま返す（プレーンテキストフォールバック）。単なる接頭辞一致（`startsWith('https://github.com/')`）では `https://github.com/x\x07\x1b]...` のような値で BEL がシーケンスを途中終端させ後続をターミナルエスケープとして注入できてしまうため、`URL` パース＋個別フィールド検証を採用する（`focus-target.ts` の厳格検証、§14.3 と同じ「認証済みだが信頼しない reporter/外部 API 由来の値」の脅威モデルの踏襲）。

### 15.10 config.yml `github_pr_poll`

```yaml
github_pr_poll:
  enabled: true # false で完全無効化（gh 可用性チェックも行わない）
  interval: '5m' # 1分〜60分の範囲（範囲外は起動時バリデーションエラー）
  allowed_repos: # owner/repo の allowlist。省略・空配列は「制限なし」（後方互換）
    - 'sumihiro3/Monomi'
```

未設定時は既定値（`enabled: true`・`interval: 5m`・`allowed_repos` なし＝制限なし）で後方互換動作する。`interval` を 1〜60 分の範囲に制限するのは、下限を設けないと `setInterval` がタイトループになり GitHub API レート制限・CPU を消費するため（既定 5 分は認証済み実行の標準レート制限 5000 req/h に対し十分な余裕を残す間隔という非機能要件に基づく）。

### 15.11 スコープ外

GitHub 以外のリモートホスト（GitLab・Bitbucket 等）の PR ポーリング、config.yml への Personal Access Token 保持、`pr_status` の古い行（対象 branch が使われなくなった後）の自動クリーンアップ、一覧カードへの PR 表示（詳細ビューのみ対応）、draft PR を `PrStatus.state` の独立した列挙値にする案（`is_draft` フラグ方式を採用）はいずれもスコープ外。

---

## 段階リリースと現状スコープ

handoff §0.4 の段階方針（単機ウェッジ → 認証ハードニング／2 台目 → CLI）は、実際のリリースへ次のように展開された。

| リリース                                       | 主な内容（現状仕様として実装済み）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| release-1 single-machine-wedge                 | install-hooks（冪等注入）／bash reporter（outbox・4xx 隔離）／Hub API + SQLite（WAL）／project_key 正規化 hub 一本化／event-time status 導出／単機ウェッジ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| release-2 biome-migration                      | Lint・フォーマットを Biome へ統一（Markdown のみ Prettier）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| release-3 multi-device-pairing                 | 手動ペアリング／tokens 認証・なりすまし防止／マルチエンドポイント順試行／devices 管理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| release-4 cli-dashboard-ux                     | Ink ダッシュボード／常時 watch／状態フィルタ／詳細ビュー（Agent View Lv.1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| release-5 docs-restructure                     | 現状スナップショット（本ドキュメント等）と設計経緯（handoff 凍結）の分離                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| release-6 detail-view-redesign                 | 詳細ビュー（Agent View Lv.1）をボーダー付きBOXへ作り直し（概要BOX＋スクロール可能なイベント履歴BOX）／`recent_events` 取得上限を 20→100 件に引き上げ／古い順（最新が下端）表示＋tail-follow／隣接プロジェクト移動（`←`/`→`）／イベント行の折り返し⇔切り詰め切替（`w`）／ターミナルのタブ/ウィンドウタイトル追従                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| release-7 session-status-reliability           | 孤立 session（`SessionEnd` 未達で `ended_at` NULL のまま残った session）が稼働中 session の表示を覆い隠す不具合（B7）の対症療法として、rollup に stale session 除外（instance 内最新イベントから相対 15 分、§5.5）を追加／reporter の `SessionEnd` 送信高速化（outbox flush スキップ＋先頭候補 1 件のみ `connect-timeout=1s`/`max-time=2s`、§3）。ライブネス検知の本実装は引き続きスコープ外                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| release-8 dashboard-freshness                  | closed instance の既定非表示化とフィルタ拡張（`StatusFilter`/`FILTER_ORDER` を 5→6 状態化、キー `1`-`6`、B6 対応、§10.3）／`InstanceStatusRollup` を優先度優先から完全 recency 優先へ変更（§5.5、B8 対応）し、release-7 の孤立 session 除外（`STALE_SESSION_THRESHOLD_MS`、15 分閾値）を削除。ライブネス検知の本実装は引き続きスコープ外                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| release-9 i18n                                 | CLI 表示層（`status-display.ts`／`components/*.tsx`／`cli.ts`）を `src/i18n/` 経由の翻訳キー参照へ全面移行（ja/en 両ロケール完成、I1 対応、§12）／`config.yml` に `locale` 設定キーを追加。既定表示言語が日本語→英語に変わる仕様変更（§12）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| release-10 dashboard-polish                    | ヘッダータイトルを `Claude Code Status` から `Monomi` バッジ（`backgroundColor="blue"` + bold）へ変更（U1、§10.2）／watching インジケータを新規 `WatchingIndicator` コンポーネントへ分離し 1000ms 間隔で点滅化、表示文言を i18n キー `app.watching`＝`WATCHING` へ切り出し（U2、`AppView` 本体の再レンダーを誘発しない設計で P4 の悪化を回避）／選択中カードの強調を `borderColor="cyan"` 単体から `borderStyle="double"` 併用へ変更（U3）／状態フィルタの有効バッジ強調を `inverse` 反転から `backgroundColor="blue"` へ置換（U4）／ヘルプ文言 `help.openDetail` からユーザー向け表示中の内部用語「Agent View Lv.1」を除去（§12）。P4（`AppView` の無条件再レンダー・集計重複計算）の本格修正は引き続きスコープ外                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| release-11 version-automation                  | `MONOMI_VERSION` を `package.json` から動的読込む単一ソース化（`src/version.ts` 新設。循環依存回避のため `index.ts`／TUI コンポーネントの双方から一方向参照、§13）／バージョン bump npm スクリプト（`version:patch`/`version:minor`/`version:major` + `preversion` でのテスト必須化、§13）／TUI ヘッダー・ヘルプオーバーレイへのバージョン表示追加（§13、§10.2）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| release-13 monomi-home-permissions             | `~/.monomi` ディレクトリを `chmod 700`（`ensureMonomiHome()`／`HOME_DIR_MODE`、§0.3）、SQLite DB ファイルを `chmod 600`（`DB_FILE_MODE`、§7.4）に固定。`serve`/`bootstrap`/`pairing-client` に重複していた `mkdirSync` 呼び出しを `ensureMonomiHome()` へ集約し、reporter（bash）側にも同等の `chmod 700` 防御を追加（§3）。既存インストールも次回起動時に自動修復（既知課題 S1 解消）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| release-16 running-work-display                | `running_work`（`kind: "workflow"\|"agent"\|"skill"` + `name`、§8.4）を一覧・詳細 API 双方に追加。既存 `events.tool_name`/`tool_summary` から導出（DB スキーマ変更なし）し、代表 session が ACTIVE のときのみ走査するゲートで非 active な instance では既知課題 P3 の悪化を回避（ACTIVE な instance では新規の軽微な N+1 隣接パターンが既知課題 P8 として残存）。reporter（`monomi-report.sh`）は `Workflow`/`Task`・`Agent`/`Skill` の表示名抽出を `extract_tool_summary()` に追加（§3）。CLI 一覧カードは末尾行に `▶ <name>`（`null` は `-`、§10.2）、詳細ビュー概要 BOX には `running` フィールドを `<name> (<kind>)` 形式で追加（§10.4）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| release-17 npm-distribution                    | パッケージ名を `@tep-lab/monomi`（private）から `monomi-cli`（公開、MIT ライセンス）へ変更し npm 公開可能な状態に整備（`engines.node >=22.5.0`、配布物を `dist/`・`reporter/monomi-report.sh`・`CHANGELOG.md` に限定する `files`、§13）／`monomi` bin を `dist/bin.js` → `dist/cli.js` の二層構成へ変更し起動時 Node バージョン検査を追加（§2.4）／`monomi install-hooks` が同梱 reporter を `~/.monomi/monomi-report.sh` へ自動配置してからフック登録するよう変更、手動 `cp` 手順を撤廃（§3.1）／PR 用 CI（`ci.yml`）と `v*` タグ契機の npm publish（`publish.yml`）を GitHub Actions として新設／CHANGELOG.md・LICENSE（MIT）を新設し、README を利用者向け一気通貫ガイド（導入〜常駐化〜フック登録〜ペアリング〜アップデート〜アンインストール）へ再構成、開発者向け内容は `docs/development.md` へ分離（既知課題 D1 解消）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| release-18 npx-quickstart                      | `monomi`（引数なし）実行時に hub へ疎通できなければ自パッケージ内 `dist/bin.js` を detached spawn して自己修復的に自動起動する `ensureHubRunning()` を追加し、pm2 等の外部プロセスマネージャ前提を撤廃（FR-01、§2.3）／`~/.monomi/hub.pid` の書込・削除と `monomi hub status`（running/stopped/stale）・`monomi hub stop`（生存確認済み pid にのみ SIGTERM）を追加、`EADDRINUSE` 時の案内文言変換も追加（FR-02、§2.3）／フック未登録かつ対話端末なら `install-hooks` 実行を確認するプロンプトを起動シーケンスに追加、拒否は `~/.monomi/setup-prompt-declined` へ永続化して再プロンプトしない（FR-03、§2.4）／`running_work` の消灯境界を候補種別ごとに非対称化（Workflow 候補は `SessionEnd` のみで消灯・fallback 候補は従来境界を維持・境界を跨いだ Workflow は fallback より優先）し、バックグラウンド Workflow がターン境界の向こうへ取り残されて消灯していた不具合を解消（既知課題 U8 解消、FR-04、§8.4）／`running_work` に `started_at` を追加し CLI 一覧カード・詳細ビューに経過時間表示（`▶ <name> (<経過時間>)`／`<name> (<kind>) <経過時間>`）を追加、wire 型を `RunningWorkDto`/`toRunningWorkDto()` として `RunningWork` から分離（既知課題 A6 解消、FR-05）／詳細ビューの `running_work.kind` 未知値フォールバックを `sanitizeDisplayText()` 経由へ変更（既知課題 S6 解消、FR-06）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| release-19 session-status-and-locale-detection | `InstanceStatusRollup` に孤立（zombie）live session 除外を追加（instance 内に `CLOSED` session が 1 件以上あるときに限り、`STALE` 昇格済みかつ最新 `CLOSED` より `lastEventAt` が古い live session を候補から除外、真に `ACTIVE` な live session は対象外。既知課題 B9 対応、FR-01、§5.5／§6）／OS から表示言語を判定する `detectOsLocale()`（`src/i18n/os-locale.ts`。macOS は `defaults read -g AppleLocale` を優先し取得不可時のみ `LANG` へフォールバック、非 macOS は `LANG` のみ）を追加し、`resolveLocale(configLocale?, osLocale?)` の優先順位を「`config.yml` の `locale:` → OS からの判定 → 既定 `en`」の3階層へ拡張（release-9-i18n の「`LANG` は解決に使わない」決定を後方互換な形で見直し、FR-02、§12。実装完了後の実機検証で `LANG` が macOS のシステム言語設定と連動しない事例が見つかり `AppleLocale` 優先の設計へ修正）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| release-20 dashboard-heap-guard                | 約65時間の連続稼働で発生した OOM クラッシュ（既知課題 B11、stdout バックプレッシャー未処理が最有力仮説）に対し、`MemoryWatchdog`（`src/cli/memory-watchdog.ts`）による稼働監視ログ（メモリ・stdout backpressure を60秒間隔で `~/.monomi/cli.log` へ記録、FR-01、§10.5）を追加し、共有判定関数 `isStdoutBackpressured()` で `AppView`/`WatchingIndicator` の再描画をバックプレッシャー中はスキップする緩和策（FR-02、§10.5）を実施。付随して既知課題 P4（`store.filtered()` の二重計算解消・集計値の `useMemo` 化・`KeyBindingController.handleKey()` の戻り値を `boolean` 化し無効キーでの `bump()` を抑止、FR-03、§10.5）と B5（詳細ビュー表示中は一覧側 `PollingLoop` を `stop()`/`start()`、FR-04、§10.3）を解消。OOM の根本原因（stdout バックプレッシャー仮説）自体は heap snapshot 等の直接証拠が無く、実運用ログでの最終確証待ち（FR-01 AC-7、`docs/known-issues.md` B11 に未解決のまま残存）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| release-22 github-releases-and-english-readme  | npm 公開まわりの運用整備と README 英語化を中心とした配布・ドキュメント整備リリース。`v*` タグ push 契機の `publish.yml` に GitHub Release 自動作成を追加（新設 `scripts/extract-changelog-notes.mjs` が `CHANGELOG.md` の該当バージョン節を抽出し `gh release create --verify-tag` へ渡す、既知課題 N5 解消、FR-01、§13）。Release 作成に要る `contents: write` へ `permissions` を変更（この権限がジョブ全体に及ぶ点を既知課題 S13 として新規起票）／README を英語版（`README.md`）＋日本語版（`README.ja.md`、新規）の二本立てへ再構成し相互言語リンクを追加、対応環境節に npm 10.8.2 等の既知バグ注記を英日両方へ追加（既知課題 N4 解消、FR-02）／`package.json` の `description` を英語化し GitHub About の説明文と表記統一（FR-03）／LICENSE の著作権表記からメールアドレスを削除（既知課題 N6 解消、FR-04）／GitHub リポジトリ About（description・homepage・topics）を整備（既知課題 N7 解消、FR-05、コード差分なし）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| release-23 terminal-focus                      | ダッシュボードから対象 instance の実行中ターミナルへ `f` キー1発でフォーカスを移す機能を追加（既知課題 U9 解消、§14）。reporter が毎フックで TTY 等のターミナル特定情報を捕捉して `terminal` ペイロードへ追加（FR-01、§3）／`sessions` テーブルへ `tty`/`term_program`/`tmux_pane`/`tmux_socket`/`wsl_distro`/`wt_session`/`terminal_seen_at` を追加し、新規 `src/db/migrations.ts` の `applyMigrations()` で既存 DB への列追加を冪等に行う（§7.3 方針からの初の意図的逸脱、FR-02、§7.5）／`SessionDto.terminal`（`TerminalDto`）として一覧・詳細 API に露出（FR-03、§8.4）／新規 `src/cli/focus/`（`focus-target.ts` の厳格検証・`applescript.ts`/`osascript.ts` のエスケープ＋`execFile` 非 shell 起動・Terminal.app/Ghostty/tmux/WSL の 4 strategy）でフォーカス実行を実装（FR-04、§14.3）／`KeyBindingHost.focusTerminal()`・device_id 照合・`status.display === 'closed'` 等のゲート・notice 表示・フッターヒント・ヘルプオーバーレイを CLI へ配線（FR-05、§14.2）。別デバイスの instance は device_id 照合でフォーカス無効化。Ghostty はアクセシビリティ許可・`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` の手動設定が前提で自動設定はしない設計判断（§14.5）。iTerm2/VS Code 統合ターミナル・Linux ネイティブ・ネストした tmux・`wt_session` によるタブ単位フォーカス・`sessions.pid` の充填はスコープ外                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| release-24 dashboard-display-polish            | 表示系の要望2件とフォーカス機能のバグ修正1件を1リリースにまとめた小粒バンドル（hub 側のスキーマ変更なし、`src/cli/`・`src/i18n/` 配下のみで完結）。新規 `src/cli/terminal-display.ts` の `terminalDisplayName(termProgram, wslDistro)`（`term_program` の既知 wire 値→表示名の写像、未知値はそのまま返す、両方 null/空文字列は `null`、FR-01）を、詳細ビューの新規 `terminal` フィールド行（`path` の直後、i18n キー `detail.terminal`、FR-02、§10.4）と一覧カードの既存 `device` 行（`device-name (Ghostty)` のように括弧付き併記、行数据え置き、FR-03、§10.2）の両方から利用し、どのターミナルアプリで動いているかを一覧・詳細で分かるようにした（既知課題 U16 解消）。新規 `src/cli/truncate-path.ts` の `truncateMiddle()`（表示幅ベースの `先頭…末尾` 中間省略、末尾優先配分、`box-border.ts` の `displayWidth`/`truncateToWidth`/`isFullWidthCodePoint` を非公開→ `export` 化して再利用）・`collapseHomeDir()`（`/Users\|home/<name>/...` → `~/...`）で、一覧カードに新規 `path` 行を追加（5行→6行、`card-grid.ts` の列数計算は幅のみに依存するため変更不要、FR-04・FR-05、§10.2、既知課題 U18 解消）。バグ修正として、`terminal-app-strategy.ts`（`tell application "Terminal"` の前に System Events で `exists process "Terminal"` を確認するガードを追加）・`ghostty-strategy.ts`（TTY へのタグ書き込みより前に Ghostty プロセスの存在確認を行う順序へ変更し、タグ消去も書き込み成功時のみに条件化）に System Events ガードを追加し、`f` キーのフォーカス総当たりが未起動の Terminal.app を AppleScript の仕様で誤って自動起動してしまう不具合を解消（FR-06、§14.3、既知課題 B12 解消）。                                                                                                                                                                                                                                                                                                                   |
| release-25-auto-update                         | npm 配布後の版混在（既知課題 U15 解消）に対応する版照合〜自動更新導線。hub の全 HTTP 応答（401 含む）へ `X-Monomi-Hub-Version` ヘッダを付与（`src/hub/http-server.ts` の `HttpServer.send()` で集約、FR-01、§8.1）／`monomi`（引数なし）起動時に `ensureHubRunning()` が hub 版を照合し、旧版またはヘッダ欠落なら graceful 停止→新版 spawn→疎通確認、停止タイムアウト時は警告のみで旧版継続、hub の方が新しければ CLI 側が旧版である警告のみ（FR-02、§2.3）／`install-hooks` の `deployReporterScript` が配置時に reporter へ版マーカー行を注入し、ダッシュボード起動時に `ensureReporterUpToDate()` が照合して旧い/無ければ自動上書き、同版なら手動編集を保全して不干渉（FR-03、§3.1）／child ロールの CLI が接続中リモート hub の版ずれをポーリング応答ヘッダから検知し重複増殖しない notice を表示（FR-04、§8.4）／`config.yml` に `auto_update`（既定 `true`）を追加し `false` で自動更新のみ抑止しつつ通知は維持（FR-05、§12）。版比較は新設 `src/version-compare.ts` の `compareVersion()` を単一ソースとし、パース不能・欠落を `'unknown'`（＝旧版扱い）に倒すポリシーを一元化（§13）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| release-27 github-pr-poller                    | GitHub PR レビュー待ち（`PR_WAIT`）表示を実装（既知課題 U7 解消、§15）。新規 `src/hub/github-pr-poller.ts` の `GithubPrPoller` が `InstanceRepository.listActive()` から GitHub リモート×branch の組を重複排除収集し、`gh pr list --state all --json number,state,reviewDecision,isDraft,url` を `execFile`（非 shell）で呼び出して `pr_status` へ upsert（FR-01、§15.1・§15.2）。`gh` 未導入・未認証は起動時 1 回警告して無効化し、稼働中の認証失効も検知して縮退（FR-01 AC-4、§15.3）。新規 `src/domain/pr-status-mapper.ts` の `mapPrToStatus()` が gh の state/reviewDecision/isDraft を `pr_status.state`＋`isDraft` へ写像（FR-02、§15.5）。`pr_status.is_draft` 列を追加し、`applyMigrations()` をテーブル横断の汎用構造へリファクタ（FR-03、§7.3・§7.5）。`instance-status-service.ts` の常時 `false` 固定だった `HAS_PR_WAITING` 定数を削除し実データへ配線する既知課題 U7 本体の配線バグを修正（FR-04、§15.6）。`PrDto` に `number`/`url`/`is_draft` を追加し、詳細ビューの `pr` フィールドを i18n ラベル化＋draft 注記＋新規 `src/cli/osc8-hyperlink.ts` による PR 番号の OSC 8 ハイパーリンク化（FR-05、§15.7〜§15.9）。`config.yml` に `github_pr_poll`（`enabled`/`interval` 1〜60分・既定5分/`allowed_repos`）を追加（§15.10）。GitHub 以外のホスト・PAT 認証・古い行の自動クリーンアップ・一覧カードへの PR 表示はスコープ外（§15.11）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| release-28-wezterm-focus                       | ターミナルフォーカス（`f` キー、§14）の対象へ WezTerm を追加（既知課題 U17 解消）。reporter が毎フックで `$WEZTERM_PANE` を捕捉し `terminal.wezterm_pane` としてペイロードへ含める（FR-01、§3）。`sessions.wezterm_pane TEXT` 列を追加し `applyMigrations()` の `TABLE_MIGRATIONS`（`sessions` エントリ）へ組み込み、`TerminalDto`/`FocusTarget` に `wezterm_pane`/`weztermPane` を配線（FR-02、§7.3・§7.5・§8.3・§8.4）。`focus-target.ts` に `sanitizeWeztermPane()`（`/^\d+$/` のみ許容）を追加し、新規 `src/cli/focus/wezterm-strategy.ts` の `WeztermFocusStrategy` が `execFile`（非 shell）で `wezterm cli activate-pane --pane-id <id>` を実行（5 秒タイムアウト・in-flight ガード・`command` 候補配列によるフォールバック付き、任意の `verifyActivation` で WSL 向け後追い検証）（FR-03、§14.3）。`Strategy.focus()` のシグネチャを `focus(tty)` → `focus(target: FocusTarget)` へ破壊的変更し、darwin 総当たりへ `WeztermFocusStrategy` を追加、WSL2 は `weztermPane` があれば WezTerm を先に試し失敗時 Windows Terminal へフォールバック、tmux 併用時は `weztermPane` を `null` へ縮退（FR-04、§14.1・§14.3）。macOS は追加設定不要、WSL2 は Windows 側 `.wezterm.lua` への `WSLENV=WEZTERM_PANE` 追記が前提（自動設定はしない設計判断、§14.5）。macOS 実機検証で `activate-pane` 単体では OS レベルの前面化が起きないことが判明し `raiseWindow`（AppleScript／WSL は `SetForegroundWindow`）を追加（FR-03 AC-9）。install-hooks 完了後、WSL2 なら WezTerm の `WSLENV` 設定ヒントを表示（FR-06）。実機検証（macOS・実 Windows 11 Home + WSL2）を実施し、WSL2 は「Monomi CLI・対象セッション双方が WezTerm 経由で起動された WSL2 シェル」の場合にのみ確実に動作する制約を確認（既知課題 U20）。ネイティブ Linux（X11/Wayland）は前面化手段が未検証のため当初のスコープから外した（既知課題 U21）。tmux と WezTerm の併用構成でのペイン特定・iTerm2/VS Code 統合ターミナル対応はスコープ外のまま（§14.1）。 |

**現状スコープ外／未実装**（受け皿のみ用意、または将来検討）:

- ライブネス検知（常駐ハートビート／`session_lost`／`sessions.last_heartbeat_at` 更新）
- GitHub 以外のリモートホスト（GitLab・Bitbucket 等）の PR ポーリング、config.yml への Personal Access Token 保持、`pr_status` の古い行の自動クリーンアップ、一覧カードへの PR 表示（詳細ビューのみ対応、release-27、§15.11）
- mDNS 自動探索、Windows ネイティブ reporter（PowerShell）、フル TLS
- 読み取り API のデバイス所有権チェック（既知課題 S2）
- CLI の絞り込み系（fuzzy 検索 `/`・ソート `s`・デバイス循環 `d`）／Agent View Lv.2（LLM 要約）
- 他エージェント（Codex 等）対応（`sessions.agent_type` 列のみ先行して用意済み）
- `ja`/`en` 以外の第三ロケール追加、`LANGUAGE`/`LC_ALL`/`LC_MESSAGES` 等の環境変数への対応（§12。現行は `config.yml` の `locale:` と OS からの判定（macOS: `AppleLocale`→`LANG`、非 macOS: `LANG`）で一本化。将来の拡張課題）
- バージョン bump 後の `git push` 自動化（§13。手動ステップのまま）
- ターミナルフォーカス（§14）の iTerm2/VS Code 統合ターミナル対応、Linux ネイティブ（X11/Wayland）全般（WezTerm を含む。前面化手段が未検証のためスコープ外、既知課題 U21）、tmux と WezTerm の併用構成でのペイン特定、ネストした tmux/WezTerm 解決、`wt_session` によるタブ単位フォーカス、`sessions.pid` の充填、`CLAUDE_CODE_DISABLE_TERMINAL_TITLE`/WSL2 `WSLENV` 設定の install-hooks 自動設定（いずれも release-23/release-28-wezterm-focus で strategy 追加等の拡張可能な構造のみ用意）
