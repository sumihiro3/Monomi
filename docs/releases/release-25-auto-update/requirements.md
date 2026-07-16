# release-25-auto-update 確定要件

- リリース識別子: release-25-auto-update
- ステータス: 確定
- 作成日: 2026-07-16
- 対応する設計・参照資料: `docs/ARCHITECTURE.md`（§2 プロセス構成 / §8 hub API / §3.1 reporter 配置）、`docs/known-issues.md` **U15**、`docs/releases/release-18-npx-quickstart/requirements.md`（hub 自動起動・pid/stop/status）、`docs/releases/release-23-terminal-focus/requirements.md`（「欠落＝情報なし縮退」後方互換方針・冪等マイグレーション）

## 背景と目的

npm 配布（release-17/18）後、パッケージを新版へ上げても (a) 常駐 hub は旧コードのままメモリ上で動き続け、(b) `~/.monomi/monomi-report.sh` も旧版のまま残るため、「ダッシュボードだけ新版」という版の混在が起きる（既知課題 **U15**）。実害として 2026-07-15 の release-23 実機検証で、旧 hub の zod strip が新設 `terminal` フィールドを黙って捨て、`f` キーが常に縮退する事象が発生し、原因特定と hub の手動再起動が必要だった。

本リリースは `npx monomi-cli@latest` の実行一発で、そのデバイス上の hub・ダッシュボード・reporter が新版に揃う自動更新導線を実装する。混在期間の安全性（どの新旧組み合わせでも 400 を出さず機能縮退に留まる）は release-23 で確立済みのため、本リリースの主眼は「壊れないが気づけない縮退」を「自動で解消される／気づける縮退」に変えることである。

現状調査で判明した前提（起票時の U15 記述との差分）:

- `monomi hub stop`（pid 生存確認 → SIGTERM → 5秒終了確認ポーリング）と hub の graceful shutdown（SIGTERM ハンドラで server/db close + pid ファイル削除）は release-18 で**実装済み**。U15 論点②の「クリーン停止機構も現状無い」は実態より古い
- バージョンの単一ソース `MONOMI_VERSION`（`src/version.ts`、package.json 由来）は存在するが、hub はこれを API・ログのいずれにも公開していない
- `spawnHub` は実行中 CLI と同一パッケージ実体の `dist/bin.js` を spawn するため、新版 CLI が走れば再 spawn される hub は自動的に新版になる
- DB スキーマは `applyMigrations`（追加専用・冪等）が hub 起動時に自動追随するため、hub 再起動を伴う更新はスキーマ面で安全
- reporter の上書き配置 `deployReporterScript` は「同梱版を正として手動改変も上書き」が JSDoc・テストで規約化済み。ただし発火は `install-hooks` 明示実行時のみで、reporter スクリプトに版マーカーは無い
- child デバイスへの更新伝搬は構造的に不可能（通信は reporter→hub の一方向 POST のみ）

## スコープの確定（壁打ちでの決定事項）

| 論点 | 決定 |
| --- | --- |
| 更新の起点（トリガー） | ダッシュボード起動時に常時自動適用（版照合 → ずれていれば hub 再起動・reporter 再配置してから起動）。専用 `monomi update` コマンドは設けない |
| CLI のレジストリ問い合わせ（自己更新チェック） | スコープ外。「新版 CLI が実行されること」が前提で、新版の取得は `npx monomi-cli@latest` / `npm update -g` に委ねる |
| graceful 停止タイムアウト時 | 警告 notice を出して旧 hub のまま継続（SIGKILL エスカレーションはしない）。次回起動時に再試行される |
| 版比較の向き | アップグレードのみ自動。CLI 版 > hub 版（または hub が版不明）のときだけ再起動。CLI 版 < hub 版のときは「CLI が旧版」警告のみで hub は巻き戻さない（新旧 CLI 交互実行によるフリップフロップ防止） |
| 版不明の旧 hub の扱い | バージョン公開機構を持たない既存 hub は「版不明 = 旧版」とみなし再起動対象（定義上必ず本リリース以前のビルドのため） |
| reporter 更新判定 | 版マーカー方式。設置済みファイルのマーカーが自版より古い/無い → 自動上書き。自版と同じ → 一切触らない（現行版への手動編集を自動では戻さない）。内容ハッシュ比較・毎回上書きは不採用 |
| 自動更新のオプトアウト | `config.yml` にフラグを設ける（既定は有効）。無効時は自動適用せず版ずれ notice 表示のみ |
| child デバイスのスコープ | reporter 自動更新（hub と同一ロジック、role 非依存）＋版ずれ可視化（リモート hub が自版より旧いときに更新を促す notice）まで。child からリモート hub の再起動はしない。hub 版のフッター常時表示は不採用 |
| hub 再起動の対象ロール | hub ロールのみ（child には hub プロセスも pid ファイルも存在しない） |

## 機能要件

### FR-01: hub が自身のバージョンを公開する（優先度: 必須）

- 場所: `src/hub/http-server.ts`、`src/hub/serve.ts`、`src/hub/hub-lifecycle.ts`
- 既知課題対応: **U15**（論点①「hub が自身のバージョンを公開する手段が無い」）

hub の全 HTTP 応答（401 認証エラー応答を含む）にレスポンスヘッダ `X-Monomi-Hub-Version: <MONOMI_VERSION>` を付与する。ヘッダ方式とする理由: (a) `ensureHubRunning` の疎通プローブ（未認証 GET `/api/v1/instances` → 401）の応答からゼロ追加リクエストで版を読めること、(b) child の CLI もポーリング応答から追加リクエストなしで読めること。付与は `HttpServer` の応答送出チョークポイント（`send` および 401 応答経路）に集約する。

あわせて hub 起動ログ（`Monomi hub listening on ...` 行）と `monomi hub status` の running 表示にも版を出力し、人間による確認手段を提供する。

- AC-1: hub の認証済み応答・401 応答の双方に `X-Monomi-Hub-Version` ヘッダが付与され、値が `MONOMI_VERSION` と一致することをテストで確認する
- AC-2: hub 起動時のログ出力に版が含まれる
- AC-3: `monomi hub status` が running のとき、稼働中 hub の版を表示する（版不明の旧 hub に対しては「版不明」相当の表示に縮退する）
- AC-4: 版ヘッダを返さない hub（本リリース以前のビルド）に対する読み取り側の扱いが「版不明」となることをテストで確認する

### FR-02: ダッシュボード起動時の hub 版照合と自動再起動（hub ロール）（優先度: 必須)

- 場所: `src/cli/hub-autostart.ts`、`src/hub/hub-lifecycle.ts`、`src/cli.ts`
- 既知課題対応: **U15**（論点②「`ensureHubRunning` は port 疎通のみで判定するため旧 hub が生きている限り置き換わらない」）

`ensureHubRunning`（hub ロール時）を「疎通 → 版照合 → 必要なら再起動」に拡張する:

1. 疎通プローブ応答の `X-Monomi-Hub-Version` を読み、semver 比較で自版（`MONOMI_VERSION`）と照合する
2. hub 版 < 自版、またはヘッダ欠落（版不明 = 旧版）の場合: 既存の `hubStop` 相当の graceful 停止（pid 生存確認 → SIGTERM → 終了確認ポーリング）を行い、成功したら `spawnHub` で新版を spawn して疎通を待ち、更新した旨（旧版 → 新版）を起動 notice で表示する
3. graceful 停止がタイムアウトした場合: SIGKILL へはエスカレーションせず、「hub の更新に失敗した。旧版のまま続行する」旨の警告 notice を表示してダッシュボードは旧 hub のまま起動する（次回起動時に再試行される）
4. hub 版 > 自版の場合: hub には触れず、「CLI が旧版である。`npx monomi-cli@latest` 等での更新を促す」警告 notice のみ表示する
5. 版一致の場合: 何もしない（現行挙動）
6. `config.yml` の自動更新フラグ（FR-05）が無効の場合: 停止・再起動は行わず、版ずれの notice 表示のみ行う

再起動後の DB スキーマ追随は既存の `applyMigrations`（hub 起動時に自動実行）に委ね、本 FR では何もしない。複数ダッシュボード同時起動時の再起動競合は、既存の EADDRINUSE 無害化（後着 spawn が起動失敗し `hub.log` に記録されるのみ）で許容する（非機能要件参照）。

- AC-1: 旧版（または版ヘッダ無し）の hub が疎通する状態で起動すると、graceful 停止 → 新版 spawn → 疎通確認が行われ、更新 notice が表示されることをテストで確認する（stop/spawn/プローブはテストダブルで差し替え）
- AC-2: graceful 停止のタイムアウト時に SIGKILL を送らず、警告 notice 付きで旧 hub のまま起動を継続することをテストで確認する
- AC-3: hub 版 > 自版のとき hub を停止・再起動せず、CLI 旧版警告 notice のみ表示することをテストで確認する
- AC-4: 版一致時は stop/spawn が一切呼ばれないことをテストで確認する
- AC-5: child ロールでは版照合・再起動を行わない（現行の no-op を維持）ことをテストで確認する
- AC-6: 自動更新フラグ無効時は stop/spawn を行わず notice のみ表示することをテストで確認する
- AC-7: notice 文言は i18n（`src/i18n/ja.ts`・`en.ts`）に ja/en 両方で追加する

### FR-03: reporter の版マーカー埋め込みと起動時自動再配置（優先度: 必須）

- 場所: `src/install-hooks/install-hooks.ts`、`reporter/monomi-report.sh`、`src/cli.ts`
- 既知課題対応: **U15**（論点③「reporter の版ずれ検知と手動編集の保全の整合」）

reporter に機械可読の版マーカーを導入し、ダッシュボード起動時（role 非依存、hub/child 共通）に設置済み reporter の版を照合して自動再配置する:

1. **マーカー埋め込み**: `deployReporterScript` が配置時に、同梱スクリプトへ `MONOMI_REPORTER_VERSION="<MONOMI_VERSION>"` のマーカー行を注入（既存マーカー行があれば置換）してから書き出す。ビルド時の版同期を不要にするため、注入は配置時に行う（同梱ファイル自体にはプレースホルダ行を置く）。マーカーは reporter の動作に影響しない（bash 変数定義1行）
2. **起動時判定**: フック登録済み（`install-hooks` 実施済み）のデバイスで、設置済み `~/.monomi/monomi-report.sh` のマーカーを読み取り:
   - マーカー版 < 自版、またはマーカー無し（既存全ユーザー）→ `deployReporterScript` で上書きし、更新した旨の notice を表示する
   - マーカー版 == 自版 → 一切触らない（現行版への手動編集は自動では戻さない。グローバル方針「手作業で編集されたファイルを確認なしに戻さない」との整合点）
   - マーカー版 > 自版 → 触らず、CLI 旧版警告（FR-02 の 4 と共通の notice）のみ
3. フック未登録デバイス（`install-hooks` 未実施）では何もしない（初回セットアッププロンプトの責務のまま）
4. 自動更新フラグ（FR-05）無効時は上書きせず版ずれ notice のみ
5. `MONOMI_HOME` による配置先変更は既存の `defaultReporterScriptFor` の解決に従う

- AC-1: `deployReporterScript` が配置したファイルに自版のマーカー行が含まれることをテストで確認する
- AC-2: マーカーが旧版・マーカー無しの設置済みファイルが起動時判定で上書きされ、notice が出ることをテストで確認する
- AC-3: マーカーが自版と同一の場合、ファイル内容を書き換えたうえでも（手動編集を模擬）上書きされないことをテストで確認する
- AC-4: フック未登録環境では reporter 判定・配置が行われないことをテストで確認する
- AC-5: 自動更新フラグ無効時は上書きせず notice のみであることをテストで確認する
- AC-6: 上書き後のファイルに実行権限（0o755）が維持されることをテストで確認する

### FR-04: child デバイスでのリモート hub 版ずれ可視化（優先度: 必須）

- 場所: `src/cli/hub-api-client.ts`、`src/cli/polling-loop.ts`、`src/cli/components/app-view.tsx`
- 既知課題対応: **U15**（論点④「マルチデバイス構成では hub デバイスと child デバイスの双方で更新が必要だが、揃えるための導線が無い」）

child ロールの CLI は、接続中のリモート hub の応答ヘッダ `X-Monomi-Hub-Version` を読み取り、hub 版 < 自版（またはヘッダ欠落 = 版不明）を検知したら「hub が旧版である。hub デバイスで `npx monomi-cli@latest` を実行するよう促す」notice を表示する。child からリモート hub の停止・再起動は行わない（構造的に不可能であり、スコープ外）。

- AC-1: 版ヘッダが自版より旧い（またはヘッダ無し）応答を受けた child の CLI が更新促し notice を表示することをテストで確認する
- AC-2: 版一致時は notice を出さないことをテストで確認する
- AC-3: notice が i18n（ja/en）両対応であることを確認する
- AC-4: notice はポーリングのたびに増殖せず、表示は1件に保たれる（同一状態の重複表示をしない）ことをテストで確認する

### FR-05: 自動更新のオプトアウト設定（優先度: 必須）

- 場所: `src/config/config.ts`、`docs/ARCHITECTURE.md`（config スキーマ節）
- 既知課題対応: **U15**（論点③の保全側の受け皿。reporter を意図的にパッチして使う運用の逃げ道）

`config.yml` にブール設定 `auto_update`（既定 `true`、省略時 `true`）を追加する。`false` のとき FR-02 の hub 自動再起動と FR-03 の reporter 自動上書きを抑止し、版ずれの notice 表示のみ行う（FR-04 の可視化は設定に関わらず常に有効）。

- AC-1: `auto_update` 省略時・`true`・`false` の3通りが zod スキーマで正しくパースされ、省略時に `true` となることをテストで確認する
- AC-2: 不正値（文字列等）はスキーマバリデーションエラーになることをテストで確認する

### FR-06: 実機受け入れ試験（優先度: 必須）

- 場所: 該当なし（受け入れ試験）

- AC-1: 実機での更新シナリオ確認（手動検証必須）— 旧版 hub が稼働中のデバイスで新版 CLI（ローカルビルドまたは npm 公開版）を起動し、(a) hub が新版へ自動再起動されること、(b) reporter が新版マーカー付きで再配置されること、(c) 更新 notice が表示されること、(d) ダッシュボードが正常動作することを確認する

## 非機能要件

- **後方互換**: 版ヘッダを返さない旧 hub・マーカーの無い旧 reporter を「版不明 = 旧版」として扱い、更新経路に乗せる。新 CLI ↔ 旧 hub の混在で 400 やクラッシュを発生させない（release-23 の「欠落＝情報なし縮退」方針を維持）
- **セキュリティ**: `X-Monomi-Hub-Version` は未認証応答（401）にも付与されるため、LAN 内の未認証クライアントへ版情報が開示される。開示されるのは版文字列のみで攻撃面の拡大は軽微と判断し許容する（本判断を `docs/ARCHITECTURE.md` に記録する）。hub の停止対象は既存 `hubStop` と同じく「pid ファイル由来かつ生存確認済みの pid」に限定し、無関係プロセスへのシグナル送出を防ぐ
- **競合耐性**: 複数ダッシュボードの同時起動で再起動が競合した場合、後着の spawn は既存の EADDRINUSE 経路で無害に失敗し `hub.log` に記録される。プロセス間ロックは導入しない（発生確率と影響の小ささから許容。既知課題 S11 と同様の判断）
- **性能**: 版照合は既存の疎通プローブ応答・ポーリング応答のヘッダ読み取りで行い、追加の HTTP リクエストを発生させない
- **i18n**: 追加する notice・ログ文言はすべて ja/en 両カタログへ追加する

## スコープ外（やらないと決めたこと)

- CLI がレジストリへ新版を問い合わせる自己更新チェック（新版の取得は `npx monomi-cli@latest` / `npm update -g` に委ねる）
- 専用の `monomi update` サブコマンド
- hub から child デバイスへの更新のリモート push（hub→child の管理チャネルが存在せず構造的に不可能）
- 自動 downgrade（CLI 版 < hub 版のとき hub を巻き戻すこと）
- SIGKILL による強制停止エスカレーション
- ダッシュボードフッター等への hub 版の常時表示
- `uninstall-hooks` 時の reporter ファイル清掃（現状維持。必要なら別課題として起票）

## 未解決事項（実装中に判断が必要な点）

- semver 比較の実装: 依存追加（`semver` パッケージ）を避け、`major.minor.patch` の数値比較の自前実装で足りる想定（プレリリースタグは配布運用上使っていない）。パース不能な版文字列は「版不明 = 旧版」に倒す
- 更新 notice の表示チャネル: Ink 起動前の stdout 出力は画面クリアで消えるため、ダッシュボード内 notice 機構（`app-view.tsx` の既存 notice）への載せ方は設計フェーズで確定する
- reporter マーカーのプレースホルダ形式（同梱ファイル側の行の書式）は実装時に確定する

## 次のステップ

```
Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "release-25-auto-update", config: <.claude/workflow.config.json の内容>}})
```
