# release-7-session-status-reliability — 要件定義

- リリース識別子: `release-7-session-status-reliability`
- ステータス: 確定
- 作成日: 2026-07-03
- 対応する設計: `ARCHITECTURE.md` §5.3（instance ステータスの rollup）・§6（ライブネス検知は本リリースでも未実装のまま）、`reporter/README.md`、`docs/known-issues.md`（B7）

## 背景と目的

運用中に、実際には稼働中（`PreToolUse`/`PostToolUse` が直近に届いている）の instance が、ダッシュボード上では「次の指示待ち」のまま表示され続ける事象が2件、関連する形で見つかった。

1. **B7（`docs/known-issues.md` 記載済み）**: `InstanceStatusRollup` は instance 配下の**全 session**（終了判定を問わない）から優先度最大のものを代表に選ぶ。`SessionEnd`/`session_lost` を一度も受け取れず `ended_at` が NULL のまま残った孤立 session がある場合、その孤立 session の古い raw_state（例: `next_wait`）が、現在まさに稼働中の別 session の `active` より優先度が高いため代表に選ばれてしまい、instance 全体の表示が誤ったまま固定される。
   - 実例: 2026-07-03、OSSRadar（`/opt/dev/OSSRadar`）で確認。前日の `idle_prompt` を最後に `SessionEnd` を受け取れなかった孤立 session（`raw_state=next_wait`）が、直近 `PostToolUse` のある現在の session（`raw_state=active`）をマスキングしていた。
2. **新規**: Claude Code を通常の操作で終了しても、Monomi 上のステータスが「次の指示待ち」のまま「終了」に遷移しないことがある。上記 OSSRadar の事例で `SessionEnd` イベントが hub に一度も届いておらず、reporter の `outbox`/`rejected` にも送信を試みた痕跡が無いことを確認済み。claude-code-guide への照会により、Claude Code の Graceful shutdown は SIGTERM→SIGKILL の猶予が既定5秒（v2.1.160+）である一方、reporter は `outbox flush`→`当該イベント POST`（候補 URL を順に最大8秒タイムアウト）を同期実行しており、強制終了系の終了経路ではこの5秒枠を超えて SIGKILL される可能性が高いという仮説を得た（確証はない。`async: true` フックの実行モデル・SIGKILL 耐性は公式ドキュメントに記載がなく未確認）。

本リリースは、**ライブネス検知（heartbeat／`session_lost` の本実装、ARCHITECTURE.md §6 に設計のみ記載済みで現状スコープ外）には踏み込まず**、上記2件を対症療法として解消することを目的とする。

## スコープの確定（壁打ちでの決定事項）

| 論点                            | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対応の深さ                      | ライブネス検知の本実装（PID 監視ハートビート＋`session_lost`）は行わない。rollup 修正と reporter の SessionEnd 送信高速化の**対症療法2点**に限定する（ユーザー選定）                                                                                                                                                                                                                                                                                                            |
| rollup 修正方針                 | 「優先度最大の session を代表に選ぶ」既存設計（同一 instance で本当に並行稼働中の複数 session がある場合に、権限待ち側を優先表示する意図的な設計）は維持する。その上で、**instance 内の最新イベント時刻より一定時間以上古い session を rollup 対象から除外**する極め付けを追加する                                                                                                                                                                                              |
| 除外閾値 N                      | **15分**。同一 instance 内で、直近イベント（`received_at`）が「その instance 内の最新イベント時刻より N 分以上古い」session を rollup 対象から除外する。基準は絶対時刻（`now`）ではなく instance 内の最新イベント時刻からの相対距離とし、他に新しい session が存在しない限り除外対象は発生しない（唯一の session が長時間 next_wait のままでも誤って隠されない）                                                                                                                |
| 閾値 N の config 化             | しない（ハードコード定数）。対症療法としてのスコープを小さく保つ                                                                                                                                                                                                                                                                                                                                                                                                                |
| reporter 高速化方針             | `SessionEnd` イベント送信時のみ専用の高速経路を設ける。①`outbox` flush をスキップ（先に既存滞留分を流し切ろうとして時間を消費しない）、②候補 hub URL の**先頭1件のみ**を `connect-timeout=1秒`・`max-time=2秒` で試行。失敗時（タイムアウト・接続不可・5xx）は既存の `outbox` 退避に落とす（次回いずれかのイベント発火時に通常の `flush_outbox` で再送される）。4xx は既存どおり `rejected/` へ隔離。ワースト時間を概ね3秒に収め、Graceful shutdown の5秒枠にマージンを持たせる |
| `async: true` フックオプション  | 採用しない。SIGKILL 耐性が公式ドキュメントで未確認のため、確実性のある同期・短タイムアウト化を優先する。将来的な信頼性向上策として「未解決事項」に記録する                                                                                                                                                                                                                                                                                                                      |
| `SessionEnd` 以外のイベント種別 | 送信フロー（outbox flush → 複数候補順次試行 → 最大8秒）は変更しない（回帰なし）                                                                                                                                                                                                                                                                                                                                                                                                 |

## 機能要件

### FR-01: InstanceStatusRollup の stale session 除外（優先度: 必須）

- 場所: `src/status/instance-status-rollup.ts`、`src/hub/instance-status-service.ts`（`buildRow`）
- AC-1: 同一 instance 内に、他の session より直近イベント（`received_at`）が15分以上古い session が存在し、かつ instance 内に別の session が存在する場合、その古い session は rollup の代表選定から除外される
- AC-2: instance 内の全 session が互いに15分以内に収まっている場合（通常の並行稼働ケース）は、従来どおり優先度最大の session が代表に選ばれる（既存の release-1 FR-04 AC-5 の回帰テストを維持）
- AC-3: instance 内に session が1件しかない場合、除外ロジックの影響を受けず、その session が常に代表になる
- AC-4: 回帰テスト: 「孤立 session（`raw_state=next_wait`、直近イベントが20分前）」＋「現在 session（`raw_state=active`、直近イベントが数秒前）」の組み合わせで、instance の代表ステータスが `active` になることを確認する（OSSRadar 実例を模したケース）

### FR-02: reporter の SessionEnd 送信高速化（優先度: 必須）

- 場所: `reporter/monomi-report.sh`
- AC-1: `event_type=SessionEnd` のとき、reporter は `outbox` flush を行わずに直ちに当該イベントの送信を試みる
- AC-2: `event_type=SessionEnd` のとき、候補 hub URL の先頭1件のみへ `connect-timeout=1秒`・`max-time=2秒` で POST する（複数候補への順次試行はしない）
- AC-3: 送信成功（2xx）時、イベントが hub の `events` テーブルへ記録される
- AC-4: 送信失敗（タイムアウト・接続不可・5xx）時、イベントは `outbox` へ退避され、次回いずれかのイベント発火時（同一 device の別 session でもよい）に既存の `flush_outbox` 経路で再送される
- AC-5: 送信結果が 4xx（スキーマ不正・認証失敗等）の場合、既存どおり `rejected/` へ隔離される
- AC-6: `SessionEnd` 以外のイベント種別の送信フロー（`outbox` flush 先行 → 複数候補順次試行 → 最大8秒タイムアウト）は変更されない
- AC-7: 実測（`time` コマンド等）で `SessionEnd` 経路のワースト実行時間（hub 不達時）が概ね3秒以内に収まることを確認する

## 非機能要件

- 既存のマルチエンドポイントフォールバック（FR-04 §0.2）は `SessionEnd` 以外のイベント種別で維持する
- ライブネス検知（heartbeat 常駐／`session_lost` 自動送出）は本リリースでも実装しない（ARCHITECTURE.md §6 の既知ギャップのまま）

## スコープ外（release-7 では実装しない）

- ライブネス検知（PID 監視ハートビート・`session_lost` の自動送出）の本実装
- rollup 除外閾値 N の config 化
- `SessionEnd` 以外のイベント種別への短タイムアウト・単一候補化の適用
- `async: true` フックオプションの採用
- Claude Code の各終了経路（`/exit`／Ctrl+D／Ctrl+C／ターミナルクローズ／`kill`／OS スリープ）ごとに `SessionEnd` フック自体が発火するかどうかの網羅的な仕様確認（公式ドキュメント未記載のため、実装時の実機検証に委ねる。§「未解決事項」参照）

## 未解決事項

- Claude Code の各終了経路で `SessionEnd` フックが実際に発火するかどうかは未確証（公式ドキュメントに記載なし）。実装時に PTY 等で終了パターン別の実機検証を行い、「フック自体が発火しない」経路が見つかった場合は reporter 側の高速化だけでは解決できないため、対応方針を再検討する
- `async: true` フックが SIGKILL からプロセスを保護できるかは未確認。将来的にライブネス検知を実装しない前提で信頼性をさらに上げたい場合の調査候補として記録する
- FR-02 の高速化後も、Graceful shutdown の猶予秒数（既定5秒）自体が環境・Claude Code バージョンにより変動する可能性がある。3秒のワースト見積もりに対するマージンが実運用で十分か、リリース後の実地観測で確認する

## 次のステップ

要件確定後、以下で実装フェーズへ進む:

```
Workflow({name: "implement-feature", args: {release: "release-7-session-status-reliability"}})
```
