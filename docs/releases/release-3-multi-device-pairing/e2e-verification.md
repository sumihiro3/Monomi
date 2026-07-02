# release-3 実2台 E2E 検証手順（MacBook → Mac mini）

release-3 の受け入れ基準のうち、実2台でしか検証できない項目のチェックリスト。
成功基準: **MacBook で権限待ちになったセッションが、Mac mini の `monomi` 一覧に「権限待ち」として表示され、LAN 経路を塞いでも Tailscale 経由で届き続ける**こと。

単機シミュレーションで検証済みの項目（ペアリングフロー・loopback ガード・乗っ取り 409・`--hub` 複数指定・outbox 隔離）は再確認不要。ここではネットワーク実経路とマシン境界だけを見る。

## 前提

- Mac mini（hub 役）と MacBook（child 役）が同一 LAN、かつ両方 Tailscale 接続済み
- 両マシンに Node.js / pnpm / git / curl がある
- MacBook 側にもリポジトリ一式が必要（remote 未設定のため rsync で複製する）:

```sh
# Mac mini から MacBook へ（MacBook のホスト名は適宜）
rsync -a --exclude node_modules --exclude dist /opt/dev/Monomi/ <macbook>:/opt/dev/Monomi/
# MacBook 側で
cd /opt/dev/Monomi && pnpm install && pnpm build
```

## 1. Mac mini（hub）側のセットアップ

```sh
cd /opt/dev/Monomi
pnpm build

# hub 起動（フォアグラウンドで様子見。常用は pm2 化）
node dist/cli.js hub
# → "Monomi hub listening on http://0.0.0.0:47632" を確認

# 別ターミナルで自マシンのフックを登録（Mac mini 自身も監視対象にする場合）
mkdir -p ~/.monomi && cp reporter/monomi-report.sh ~/.monomi/monomi-report.sh
node dist/cli.js install-hooks
```

チェック:

- [ ] `~/.monomi/{config.yml,monomi.db,token}` が生成され、hub が `0.0.0.0:47632` で待受
- [ ] `netstat -an | grep 47632` に `*.47632 LISTEN`

## 2. ペアリング（Mac mini → MacBook）

Mac mini 側:

```sh
node dist/cli.js hub pair
# 表示例:
#   Pairing code: 123456
#   monomi pair --code 123456 --hub http://100.x.x.x:47632   ← Tailscale
#   monomi pair --code 123456 --hub http://192.168.x.x:47632 ← LAN
```

MacBook 側（**LAN を先・Tailscale を後に両方指定**する。順序がフォールバック優先順になる）:

```sh
cd /opt/dev/Monomi
node dist/cli.js pair --code 123456 \
  --hub http://192.168.x.x:47632 \
  --hub http://100.x.x.x:47632
```

チェック:

- [ ] `Paired as device "<macbookのhostname>"` が表示される
- [ ] MacBook の `~/.monomi/config.yml` に `role: child` と 2 つの `hub_endpoints` が入り、権限が 600
- [ ] Mac mini 側で `node dist/cli.js hub devices list` に MacBook が `active` で並ぶ

## 3. イベント疎通（本番経路: 実フック）

MacBook 側:

```sh
mkdir -p ~/.monomi && cp reporter/monomi-report.sh ~/.monomi/monomi-report.sh
node dist/cli.js install-hooks
# 任意のプロジェクトで Claude Code セッションを1本開始し、
# 権限プロンプトが出る操作を1回行う（または放置して idle を待つ）
```

Mac mini 側:

```sh
node dist/cli.js        # ダッシュボード起動（w で watch）
```

チェック:

- [ ] MacBook のプロジェクトが Mac mini のダッシュボードに DEVICE=MacBook で表示される
- [ ] 権限プロンプト発生時に「権限待ち」へ変わる（watch 中なら3秒以内に反映）

## 4. LAN 断 → Tailscale フォールバック

LAN 経路だけを確実に塞ぐため、hub のバインドを Tailscale IP に絞る（Wi-Fi を切ると Tailscale ごと落ちる環境が多いため、この方法が確実）:

Mac mini 側:

```sh
# ~/.monomi/config.yml に追記
#   bind: 100.x.x.x        ← Mac mini の Tailscale IP
# hub を再起動
node dist/cli.js hub
```

MacBook 側で再びフックを発火（セッションで1操作）し、Mac mini のダッシュボードで確認。

チェック:

- [ ] LAN エンドポイント（192.168.x.x）は接続拒否になるが、イベントは Tailscale 経由で届く
- [ ] `MONOMI_DEBUG=1 echo '{"session_id":"t","hook_event_name":"Stop","cwd":"'$PWD'"}' | bash ~/.monomi/monomi-report.sh` の stderr で「1つ目失敗→2つ目成功」の順試行が見える
- [ ] 検証後、`bind:` 行を削除して hub を再起動（0.0.0.0 に戻す）

## 5. 片付け（検証のみで終える場合）

```sh
# MacBook 側
node dist/cli.js uninstall-hooks
# Mac mini 側
node dist/cli.js hub devices revoke <macbookのdevice_id>   # 必要なら
node dist/cli.js uninstall-hooks                            # 自マシン分も外すなら
```

そのまま実運用に入る場合は、Mac mini で hub を pm2 常駐化する:

```sh
pm2 start /opt/dev/Monomi/dist/hub/serve.js --name monomi-hub
pm2 startup && pm2 save
```

## 結果記録

| 日付 | 実施者 | 結果 | メモ |
| ---- | ------ | ---- | ---- |
|      |        |      |      |
