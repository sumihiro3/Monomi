# FR-06: 実機受け入れ試験チェックリスト

このドキュメントは **手動検証必須** の受け入れ試験手順です。自動テストでは検証できない hub 自動再起動・reporter 自動配置・notice 表示・ダッシュボード正常動作を確認します。

## 前提条件

- テスト対象マシン上で、旧版の hub がバックグラウンドで稼働中な状態
- テスト対象の新版 Monomi CLI がローカルビルド済み（`pnpm build` 実行済み）または npm から入手可能
- Claude Code がこのマシンでフック登録済み（`monomi install-hooks` 実施済み）な状態
- `~/.monomi/config.yml` の `auto_update` が `true`（既定値）または未指定な状態

## テスト環境の準備

### 手順 1: 旧版 hub の確認

```bash
# hub が稼働中か確認（既に起動している場合）
monomi hub status

# hub が未起動の場合は起動
monomi hub

# 別ターミナルで hub プロセスを確認
ps aux | grep "node.*hub"

# hub のログで「listening on」が表示されていることを確認
tail ~/.monomi/hub.log
```

### 手順 2: 旧版の version.ts の内容を記録

テスト開始前に、現在実行中の hub が旧版であることを確認するため、ビルド前の `src/version.ts` の version 文字列を記録します。

```bash
grep "version" src/version.ts
# 出力例: export const MONOMI_VERSION = "0.1.0";
```

この記録を `OLD_VERSION` とします。

### 手順 3: 新版のビルド

新版 Monomi をビルドします（既にビルド済みの場合はスキップ）。

```bash
pnpm build
```

新ビルド後の `src/version.ts` の version 文字列を確認し、`OLD_VERSION` より新しいことを確認します。これを `NEW_VERSION` とします。

```bash
grep "version" src/version.ts
# 出力例: export const MONOMI_VERSION = "0.2.0";
```

## テスト実行

### テストシナリオ 1: hub の自動再起動と notice 表示

**目的**: 旧版 hub が稼働中のとき、新版 CLI 起動で hub が新版へ自動再起動され、notice で更新を通知することを確認。

#### 前提

- 旧版 hub が `~/.monomi/hub.pid` に pid を記録したまま稼働中
- 新版 CLI がローカルビルド済み（`dist/cli.js` 最新）

#### 手順

1. **新版 CLI の起動**

   ```bash
   # 新版のダッシュボードを起動
   node dist/cli.js
   # または npx 利用時
   npx ./dist/cli.js
   ```

2. **起動時 notice の確認**（ダッシュボード表示前）

   - 「hub を新版へ自動更新しました」相当の notice が表示されることを確認
   - notice に旧版バージョン→新版バージョンの表記が含まれることを確認（例: `Updated hub from 0.1.0 to 0.2.0`）
   - 日本語ロケール設定時は日本語メッセージが表示されることを確認

3. **hub プロセスの確認**

   ```bash
   # 別ターミナルで、hub プロセスの再起動を確認
   ps aux | grep "node.*hub"
   # 新しい pid が表示されていることを確認（古い pid とは異なる）

   # hub.pid ファイルが新しい pid を記録していることを確認
   cat ~/.monomi/hub.pid
   ```

4. **hub.log の確認**

   ```bash
   # hub の再起動ログが記録されていることを確認
   tail -30 ~/.monomi/hub.log
   # 「Monomi hub listening on」と version 表記が含まれることを確認
   # 例: "Monomi hub v0.2.0 listening on http://..."
   ```

5. **ダッシュボード正常動作**

   - ダッシュボードが起動し、instance 一覧が表示されることを確認
   - 複数 instance がある場合は、すべてが正常に表示されることを確認
   - フィルタ `1`–`6`、カーソル移動 `j`/`k`、詳細表示 `Enter` が正常に動作することを確認

### テストシナリオ 2: reporter の自動再配置

**目的**: 新版 CLI 起動時に reporter の版マーカーが照合され、旧版の場合は自動上書きされることを確認。

#### 前提

- シナリオ 1 の hub 再起動が完了済み
- reporter が `~/.monomi/monomi-report.sh` に設置済み

#### 手順

1. **旧版 reporter のマーカー確認（事前確認）**

   hub を停止してからこのテストを行うと安全です：

   ```bash
   monomi hub stop
   ```

   旧版の reporter に旧版マーカーが含まれていることを確認：

   ```bash
   grep "MONOMI_REPORTER_VERSION" ~/.monomi/monomi-report.sh
   # 出力例: MONOMI_REPORTER_VERSION="0.1.0"
   ```

   この時点でのマーカー版を `OLD_REPORTER_VERSION` として記録します。

2. **新版 CLI 起動と reporter 更新**

   ```bash
   node dist/cli.js
   # または npx 利用時
   npx ./dist/cli.js
   ```

3. **起動時 notice の確認**

   - 「reporter を新版へ自動更新しました」相当の notice が表示されることを確認
   - notice に旧版バージョン→新版バージョンの表記が含まれることを確認

4. **reporter のマーカー確認**

   ```bash
   grep "MONOMI_REPORTER_VERSION" ~/.monomi/monomi-report.sh
   # 新版バージョンが記録されていることを確認
   # 出力例: MONOMI_REPORTER_VERSION="0.2.0"
   ```

5. **reporter ファイルの実行権限確認**

   ```bash
   ls -l ~/.monomi/monomi-report.sh
   # -rwxr-xr-x 相当の権限（755）であることを確認
   ```

6. **ダッシュボード正常動作**

   - シナリオ 1 と同じく、ダッシュボード・フィルタ・詳細表示が正常に動作することを確認

### テストシナリオ 3: version 一致時の無処理（スキップ）

**目的**: hub・reporter の版が既に揃っている場合、不要な再起動・再配置が行われないことを確認。

#### 前提

- シナリオ 1・2 が完了し、hub・reporter の版が揃っている状態

#### 手順

1. **hub の pid 記録**

   ```bash
   HUB_PID=$(cat ~/.monomi/hub.pid)
   echo "Hub PID: $HUB_PID"
   ```

2. **新版 CLI 再起動**

   ```bash
   node dist/cli.js
   ```

3. **notice の確認**

   - hub/reporter の更新 notice が表示されないこと（「already up-to-date」相当のメッセージも表示されない）
   - 版照合の notice が表示されないことを確認

4. **hub の pid が変化していないことを確認**

   ```bash
   # 別ターミナルで
   cat ~/.monomi/hub.pid
   # 手順 1 で記録した HUB_PID と同じであることを確認
   ```

5. **ダッシュボード正常動作**

   - ダッシュボードが起動し、正常に動作することを確認

### テストシナリオ 4: hub 再起動タイムアウト時の動作

**目的**: hub graceful 停止がタイムアウトした場合、警告を出して旧版のまま継続することを確認。

#### 前提

- hub が稼働中

#### 手順（オプション、再現困難な場合はスキップ可）

このシナリオは hub の graceful shutdown をブロックして再起動をタイムアウトさせる必要があり、実機での確認は困難です。以下の代替確認で許容します：

- `src/cli/hub-autostart.test.ts` の AC-2 テストケース（タイムアウト時に SIGKILL を送らず警告 notice で継続）が green で合格していることを確認

  ```bash
  pnpm test -- src/cli/hub-autostart.test.ts
  ```

### テストシナリオ 5: auto_update フラグ無効時の動作

**目的**: `config.yml` の `auto_update: false` 設定時、更新を行わず notice 表示のみになることを確認。

#### 前提

- シナリオ 2 で reporter が新版に更新済み
- `~/.monomi/monomi-report.sh` が新版マーカー付き
- hub が新版で稼働中

#### 手順

1. **設定の変更**

   ```bash
   # ~/.monomi/config.yml を編集
   # 以下を追加または修正
   auto_update: false
   ```

2. **reporter を旧版にダウングレード（テスト目的）**

   ```bash
   # reporter マーカーを旧版に変更（テスト用）
   sed -i 's/MONOMI_REPORTER_VERSION=.*/MONOMI_REPORTER_VERSION="0.1.0"/' ~/.monomi/monomi-report.sh
   # 確認
   grep "MONOMI_REPORTER_VERSION" ~/.monomi/monomi-report.sh
   ```

3. **hub を停止・旧版で再起動**

   ```bash
   monomi hub stop
   # 旧版 CLI で hub を起動（テスト環境の都合上、git checkout 等で旧版コードに戻す、または旧版ビルド物を別保管していれば利用）
   # ここでは理想的なテスト流程を記述するため、簡略化し「hub が旧版の想定」として進める
   ```

4. **新版 CLI 起動**

   ```bash
   node dist/cli.js
   ```

5. **notice の確認**

   - 「hub が旧版です。更新するには自動更新を有効化してください」相当の notice が表示されることを確認
   - hub の再起動は行われず、旧版のまま動作することを確認（hub.log に再起動ログが新たに記録されないこと）

6. **設定の復元**

   ```bash
   # config.yml から auto_update: false を削除または true に戻す
   ```

## テスト結果の記録

以下を確認・記録してください：

| テストシナリオ         | AC 項目                    | 結果    | 備考                                                                                                                         |
| ---------------------- | -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1. hub 自動再起動      | AC-1 hub が新版へ再起動    | ☑ Pass  | pid 70777（7/15 起動・版ヘッダ無し旧ビルド）→ 16052。401 応答に `X-Monomi-Hub-Version: 0.2.0` 付与、hub.log に `version: 0.2.0` |
| 1. hub 自動再起動      | AC-2 notice に版情報が表示 | ☑ Pass  | 「hub が旧版（不明）だったため、現在の版（0.2.0）へ自動的に再起動しました。」（版ヘッダ無し hub の「版不明=旧版」経路を実機確認） |
| 2. reporter 自動再配置 | AC-1 reporter マーカー更新 | ☑ Pass  | マーカー無し（旧版）→ `MONOMI_REPORTER_VERSION="0.2.0"`。実行権限 755（rwxr-xr-x）維持                                        |
| 2. reporter 自動再配置 | AC-2 notice に版情報が表示 | ☑ Pass  | 「reporter スクリプト（~/.monomi/monomi-report.sh）が旧版（不明）だったため、現在の版（0.2.0）へ自動的に再配置しました。」        |
| 3. 版一致時スキップ    | AC-4 hub が再起動されない  | ☑ Pass  | pid 16052 不変、更新系 notice 0 件                                                                                            |
| 5. auto_update 無効時  | AC-6 更新が抑止される      | ☑ Pass  | 抑止 notice 表示・マーカー 0.1.0 を保全（上書きなし）。フラグ復元後の再起動で 0.2.0 へ自動復旧することも確認                     |
| 全シナリオ             | ダッシュボード正常動作     | ☑ Pass  | 一覧描画・`j`/`k`・`Enter`（詳細）・`Esc`・フィルタ・`q` を確認（PTY 自動化＋最終目視）                                        |

すべて Pass の場合、FR-06 の受け入れ試験は合格です。

### 実施記録（2026-07-17）

- 実施環境: sumihiromacmini（macOS / hub ロール、実運用 hub デバイス）、Node 24.13.1
- 旧版: 2026-07-15 18:19 起動の dev ビルド hub（バージョン公開機構なし=「版不明」扱い）＋マーカー無し reporter — release-25 が対象とする実運用シナリオそのもの
- 新版: release-25-auto-update ブランチのローカルビルド（`MONOMI_VERSION` 0.2.0、版ヘッダ・マーカーあり）
- シナリオ 4 はチェックリスト記載の代替確認（`pnpm test -- src/cli/hub-autostart.test.ts` 11 件 green、AC-2 含む）で実施
- 実行方法: シナリオ 1〜3・5 は PTY（expect）上でダッシュボードを起動して notice・状態遷移を捕捉し、前後の pid／HTTP 応答ヘッダ／hub.log／マーカー／権限を検証。ダッシュボード操作は PTY キー送信に加えユーザーが実ターミナルで目視確認済み
- 試験後の状態: config.yml 復元済み・hub は新版（pid 16052）で稼働・reporter はマーカー 0.2.0 — 原状復帰ではなく「更新後の正常状態」で運用継続

## トラブルシューティング

### hub の再起動がタイムアウトして旧版のまま継続する場合

- hub のプロセスが何か重い処理をしている可能性があります
- hub.log の最後の数行を確認し、エラーやハング状態がないか確認してください
- 手動で `monomi hub stop` を実行し、hub が正常に停止するか確認してください
- 次回 `monomi` 起動時に再試行されます

### reporter の更新が行われない場合

- `~/.monomi/monomi-report.sh` が存在していることを確認してください（フック未登録の場合は更新されません）
- ファイルの読み取り権限を確認してください：`ls -l ~/.monomi/monomi-report.sh`
- マーカー行が正しい形式であることを確認してください：`grep "MONOMI_REPORTER_VERSION" ~/.monomi/monomi-report.sh`

### notice が表示されない場合

- stdout/stderr が正常にターミナルに接続されていることを確認してください（パイプ経由の実行でないか）
- ロケール設定が正しく認識されていることを確認してください：`cat ~/.monomi/config.yml | grep locale`
- CLI ログを確認してください：`tail ~/.monomi/cli.log`

## 完了チェック

- [x] すべてのテストシナリオが Pass
- [x] hub・reporter が新版に揃っている（hub pid 16052 / reporter マーカー 0.2.0）
- [x] ダッシュボードが正常に起動・動作する（ユーザー目視確認済み、2026-07-17）
- [x] notice の日本語表記（`locale: ja` の場合）が正しい（OS ロケール自動判定で日本語表示を確認）
- [x] ドキュメント（本チェックリスト）が実装と齟齬がないことを確認

---

**このチェックリストは手動検証必須の項目です。PR マージ前に本マシンで実機確認を行ってください。**
