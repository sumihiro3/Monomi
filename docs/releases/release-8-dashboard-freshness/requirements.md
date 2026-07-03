# release-8-dashboard-freshness — 要件定義

- リリース識別子: `release-8-dashboard-freshness`
- ステータス: 確定
- 作成日: 2026-07-03
- 対応する設計: `ARCHITECTURE.md` §5.4（表示ステータスの優先順位）・§5.5（ロールアップ）、`docs/design/class-diagram.md`（`InstanceStatusRollup`・`InstanceListStore`）、`docs/known-issues.md`（B6・B8）

## 背景と目的

ダッシュボードが「実態と異なる古い状態」を表示し続ける不具合が2件見つかっている。どちらも「一覧・rollupが正しい/最新の情報を反映していない」という同一テーマであるため、まとめて1リリースで解消する。

1. **B6（`docs/known-issues.md`）**: `SessionEnd` フックが正常発火し hub 側で `status.display: 'closed'` になった instance が、`InstanceListStore.filtered()` の既定表示（フィルタ未選択時）で除外されず一覧に残り続ける。ユーザー報告:「セッションが終わっても（Claude Codeをexitしても）Monomiのプロジェクト一覧には残り続けている」。
2. **B8（`docs/known-issues.md`、本リリース検討時に新規発見）**: `InstanceStatusRollup.rollup()` は release-7 FR-01（B7対応）で「instance内の最新イベントから15分以上古いsessionを候補から除外」する対症療法を追加したが、15分以内にsessionが再開されるとこの除外が効かない。残った候補は `StatusPriority`（放置>権限待ち>PR待ち>次の指示待ち>稼働中）で無条件に順位付けされるため、再開して今まさに稼働中のsession（優先度最下位）が、15分以内に残る古いsession（次の指示待ち等、優先度上位）に覆い隠され、instanceの表示が「稼働中」にならない。ユーザー報告:「プライオリティで決めるのではなく、最新の状態を反映できるようにしなければユーザーを混乱させる」（2026-07-03）。

## スコープの確定（壁打ちでの決定事項）

| 論点                                                                                | 決定                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B6: closedを明示的に見たい場合のUI                                                  | 既存のフィルタ多重選択（`1`-`5`キー）を6番目の状態として拡張する。`StatusFilter`型に`'closed'`を追加し`FILTER_ORDER`に6番目のエントリとして加える。専用の別トグルは新設しない                                                                                                                                                                                           |
| B6: 件数表示（ヘッダーの「Xプロジェクト・Xデバイス」）への影響                      | 許容する。`projectCount`/`deviceCount`は既に`filteredRows`／`projectRows()`（フィルタ適用後）から算出されているため、既定表示でclosedのみのproject/deviceは自然に数から外れる。実装上の特別対応は不要（仕様として明記するのみ）                                                                                                                                         |
| B8: rollupアルゴリズムの方向性                                                      | 完全recency優先へ変更する。`rollup()`は候補の中で最も新しい`lastEventAt`を持つsessionを無条件で代表に選ぶ。`StatusPriority`は完全同時刻のタイブレークにのみ使う。release-7が意図的に維持を決めた「同一instance内で本当に並行稼働中の複数sessionがある場合に権限待ち側を優先表示する」設計は、本リリースにより撤回する（ユーザー選定。トレードオフを認識した上での判断） |
| B8: release-7 B7対応（`STALE_SESSION_THRESHOLD_MS`・孤立session除外ロジック）の扱い | 完全に削除する。完全recency優先の下では「最も新しいlastEventAtを持つsessionは常に候補に残り必ず選ばれる」ため、事前の候補フィルタリングは結果に一切影響しない（数学的に不要）。関連する release-7 FR-01 のテスト群（`instance-status-rollup.test.ts`の「stale session exclusion」describeブロック）も削除し、新しい回帰ケースへ置き換える                               |
| B8: 適用範囲                                                                        | `InstanceStatusRollup`（instance内の複数session比較）のみに限定する。CLI側の`ClientRollup`（project内の複数instance比較、project単位ロールアップ）は対象外とし、既存のpriority優先ロジックを変更しない。instanceは「git worktree」ではなく「ディレクトリ」単位であり、別instance間には「再開による重複」という概念自体が発生しないため                                  |

## 機能要件

### FR-01: closedインスタンスの既定非表示化とフィルタ拡張（B6、優先度: 必須）

- 場所: `src/cli/instance-list-store.ts`（`filtered()`）、`src/cli/status-display.ts`（`StatusFilter`型・`FILTER_ORDER`）、`src/cli/components/status-filter-bar.tsx`、`src/cli/components/app-view.tsx`（`footerHint()`）、ヘルプオーバーレイ
- AC-1: フィルタ未選択時（既定のファーストビュー）、`status.display === 'closed'` の行は `filtered()` の結果から除外される
- AC-2: `StatusFilter` 型に `'closed'` を追加し、`FILTER_ORDER` に6番目のエントリとして追加する。既存の `1`-`5` キーの意味・並び順は変更しない
- AC-3: ユーザーがキー `6` を押すと `'closed'` フィルタがトグルされる（他のフィルタと同様、複数選択可）。`'closed'` フィルタが選択されている間は closed の行が `filtered()` の結果に含まれる
- AC-4: `StatusFilterBar` は6番目の項目として `[6]終了 <件数>` を表示する。ラベル・色は既存の `STATUS_LABELS`/`STATUS_COLORS` の `'closed'` エントリ（`終了`/`gray`）をそのまま使う（追加実装不要）
- AC-5: フッターのキーヒント（`footerHint()`、一覧表示時）とヘルプオーバーレイの表記を `1-6 filter` に更新する
- AC-6: ヘッダーの「Xプロジェクト・Xデバイス」表示は、既存通り `filteredRows`/`projectRows()` に連動するため、既定表示では closed のみの project/device を除いた数になる（仕様として明記。実装変更は不要）
- AC-7: 回帰テスト: フィルタ未選択で closed の instance が一覧に出ないこと、`6` キーで closed を含む一覧に切り替わること、他のフィルタ（例: `1`）と `6` の同時選択で active と closed 両方が表示されることを確認する

### FR-02: `InstanceStatusRollup` の完全recency優先化（B8、優先度: 必須）

- 場所: `src/status/instance-status-rollup.ts`、`src/status/instance-status-rollup.test.ts`
- AC-1: `InstanceStatusRollup.rollup()` は、渡された全 `RollupEntry` の中から最も新しい `lastEventAt` を持つ session の `status` を無条件で代表として返す
- AC-2: 複数の session が完全に同一の `lastEventAt` を持つ場合のみ、`StatusPriority.higherOf()` による優先度比較（同点なら `elapsedMs` が大きい方）でタイブレークする
- AC-3: release-7 FR-01 で導入した `STALE_SESSION_THRESHOLD_MS` による孤立 session 除外ロジック（候補の事前フィルタリング）は削除する
- AC-4: 回帰テスト: 「次の指示待ち session（古い `lastEventAt`）」＋「稼働中 session（新しい `lastEventAt`）」の組み合わせで、両者の時間差が15分以内・以遠のどちらであっても instance の代表ステータスが常に `ACTIVE` になることを確認する（旧 B7 の境界値ケースを recency ベースの表現に置き換える）
- AC-5: 回帰テスト: 完全に同一の `lastEventAt` を持つ複数 session では、従来通り優先度最大（放置 > 権限待ち > PR待ち > 次の指示待ち > 稼働中）が代表に選ばれることを確認する（タイブレークとしての `StatusPriority` の妥当性確認）
- AC-6: 既存の `instance-status-rollup.test.ts` のうち「stale session exclusion（release-7 FR-01）」describe ブロックは削除し、AC-4/AC-5 の回帰ケースへ置き換える
- AC-7: CLI側の `ClientRollup`（project単位、複数instanceのロールアップ）は本FRの対象外とし、既存のpriority優先ロジック・テストを変更しない

## 非機能要件

- 特になし（両FRとも既存アーキテクチャの範囲内の修正で、新規の性能・セキュリティ要件は発生しない）

## スコープ外（release-8では実装しない）

- ライブネス検知（PID監視ハートビート・`session_lost` の自動送出）の本実装（B8はrecency優先化による近似的な解決であり、根本解決である liveness 検知には踏み込まない。ARCHITECTURE.md §6 の既知ギャップのまま）
- `ClientRollup`（project単位ロールアップ）へのrecency優先化の適用
- `STATUS_LABELS`/`STATUS_COLORS`/`STATUS_PRIORITY` 等の `Record<string, string>` 型を網羅チェック可能な union 型へ変更すること（`docs/known-issues.md` A2、既知の別課題）
- U7（PRレビュー待ちpollerの実装）— 別リリース候補として `docs/known-issues.md` に記録済み（本リリースとは無関係）

## 未解決事項

- session再開時に実際に新しい `session_id` が払い出されるか（同一 `session_id` の継続なのか）は、`claude --continue` 等を実行してhook payloadを直接観測する形の実機検証は未実施のまま残っている（下記メモ参照）。
- 「完全同一の `lastEventAt`」は実運用では ms 精度のためほぼ発生しない。AC-2/AC-5 のタイブレークロジックはテスト網羅のための保険的実装であり、実運用での作用頻度は低い

### 実装時調査メモ（FR-02）: 実行確認は未実施 / コード検査で頑健性を確認

- 実施したこと: `claude --continue`/`--resume` を実行してhook payloadの `session_id` を直接観測する検証は行っていない（未実施）。代わりに、このマシン上の実 Claude Code セッション transcript（`~/.claude/projects/-opt-dev-Monomi/*.jsonl`）を調査し、同一プロジェクト配下に複数の独立した session UUID ファイルが存在する一方、個々のファイル内部には10分〜60分規模の時刻ギャップを挟みつつ同一 `sessionId` が一貫して記録されているケースがあることを確認した（例: あるファイルに約13分〜60分のギャップが4箇所）。ただしこれは「中断を挟んでも同一プロセスが生き続けていた」可能性とも区別できず、`--continue`/`--resume` が新規 `session_id` を払い出すか既存を継続するかを直接証明するものではない。よって session_id 払い出しの実際の挙動は依然として未検証のまま（上記「未解決事項」に残す）。
- 実施して分かったこと（コード検査）: `instance-status-service.ts` の `buildRow()` は呼び出しの都度 `sessions.listByInstance(instance.id)` の全件を `RollupEntry` に map してから `InstanceStatusRollup.rollup()` に渡す。したがって、session再開時に(a)新しい `session_id` が払い出され新しい行が増える場合も、(b)同一 `session_id` が継続し既存行の `lastEventAt` が更新される場合も、rollup が見る「候補一覧」には常に最新イベントを持つ session が含まれる。recency-first ロジック自体は session の同一性を一切見ないため、(a)(b)のどちらであっても分岐なく正しく最新を代表に選ぶ。つまりFR-02の設計は「新旧どちらの session_id 挙動であっても安全」であり、B8修正の効果は session_id 払い出し方式の実機確認結果に依存しない（実機確認が引き続き未実施でも、fixの正しさへの影響はない）。

## 次のステップ

要件確定後、以下で実装フェーズへ進む:

```
Workflow({name: "implement-feature", args: {release: "release-8-dashboard-freshness"}})
```
