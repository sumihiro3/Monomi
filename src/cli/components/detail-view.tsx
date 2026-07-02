import { Box, Text } from 'ink'
import { type ReactElement, type ReactNode, useEffect, useState } from 'react'
import type { InstanceDetail, InstanceStatusRow } from '../../hub/dto.js'
import type { HubApiClient } from '../hub-api-client.js'
import { PollingLoop } from '../polling-loop.js'
import { formatAge, statusColor, statusLabel } from '../status-display.js'

/** {@link DetailView} の props（container: 自身で詳細を取得する）。 */
export interface DetailViewProps {
  /** 詳細取得に使う hub クライアント。 */
  client: HubApiClient
  /** 一覧で選択された行（詳細取得前のヘッダ表示・フォールバックに使う）。 */
  row: InstanceStatusRow
  /** 自動更新のポーリング間隔（一覧と同じ値を配線する。FR-05 AC-1）。 */
  pollIntervalMs: number
}

/**
 * 詳細ビュー（Agent View Lv.1、§10.4 / FR-05）。container。
 *
 * 一覧と同じ {@link PollingLoop} を再利用し、`pollIntervalMs` 間隔で
 * {@link HubApiClient.getInstanceDetail} を呼び直して status / device / branch /
 * session_id / path / pr と直近イベントのタイムライン（生の活動ログ）を自動更新する
 * （AC-1）。`start()` が内部で即時取得するため初回表示は打鍵不要で出る（AC-2）。
 * アンマウント時に確実に `stop()` してポーリングを止める（AC-3）。取得失敗しても
 * 直前に取得済みの detail は消さず、初回ロード失敗時のみエラーを前面に出す（AC-4）。
 * status 導出は hub 側の結果をそのまま描くだけで、CLI では持たない。
 * esc での「戻る」は AppView 側が握る（本コンポーネントはキー入力を持たない）。
 *
 * @param props {@link DetailViewProps}。
 * @returns 詳細ビューの要素。
 */
export function DetailView({ client, row, pollIntervalMs }: DetailViewProps): ReactElement {
  const [detail, setDetail] = useState<InstanceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // 対象 instance / client / 間隔が変わったら直前 detail を捨ててから張り直す。
    setDetail(null)
    setError(null)
    // 一覧側と同じ機構を再利用（AC-5）。詳細は固定 client でよいので reresolve は渡さない。
    const loop = new PollingLoop<InstanceDetail>(
      (c) => c.getInstanceDetail(row.instance_id),
      client,
      pollIntervalMs
    )
    loop.onUpdate((fetched) => {
      if (cancelled) return
      setDetail(fetched)
      setError(null)
    })
    loop.onError((err) => {
      // AC-4: 直前の detail は消さない。error は初回ロード失敗時のみ描画で前面に出す。
      if (cancelled) return
      setError(String(err))
    })
    // start() は内部で即時 refresh するため初回表示は維持される（AC-2）。
    loop.start()
    return () => {
      // アンマウントで確実にポーリングを止める（AC-3）。
      cancelled = true
      loop.stop()
    }
  }, [client, row.instance_id, pollIntervalMs])

  // 取得済みの detail があればそれを、なければ選択行をヘッダ・メタ表示のソースにする。
  // ポーリングで detail が更新されると status/branch/pr 等も追従する（AC-1）。
  const source = detail ?? row
  const events = detail?.recent_events ?? []

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{source.project.name}</Text>
        {source.branch !== null ? <Text dimColor> / {source.branch}</Text> : null}
        <Text dimColor>{'   '}[esc] back</Text>
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Field label="status">
          <Text color={statusColor(source.status.display)}>
            {statusLabel(source.status.display)} ({formatAge(source.status.elapsed_seconds)}経過)
          </Text>
        </Field>
        <Field label="device">
          <Text>{source.device.name}</Text>
        </Field>
        <Field label="branch">
          <Text>{source.branch ?? '-'}</Text>
        </Field>
        <Field label="session_id">
          <Text>{source.session.id}</Text>
        </Field>
        <Field label="path">
          <Text>{source.path}</Text>
        </Field>
        <Field label="pr">
          <Text>{source.pr.state}</Text>
        </Field>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>recent events</Text>
        {/* AC-4: detail 取得後はバックグラウンド失敗で error が立っても events を出し続け、
            error を前面に出すのは detail が null のまま（初回ロード失敗）のときだけにする。 */}
        {detail !== null ? (
          events.length === 0 ? (
            <Text dimColor>(イベントがありません)</Text>
          ) : (
            events.map((event) => (
              <Text key={event.id} wrap="truncate-end">
                <Text dimColor>{event.occurred_at} </Text>
                {event.event_type}
                {event.event_subtype !== null ? (
                  <Text dimColor> ({event.event_subtype})</Text>
                ) : null}
                {event.tool_name !== null ? <Text color="cyan"> {event.tool_name}</Text> : null}
                {event.tool_summary !== null ? <Text dimColor>: {event.tool_summary}</Text> : null}
              </Text>
            ))
          )
        ) : error !== null ? (
          <Text color="red">詳細の取得に失敗しました: {error}</Text>
        ) : (
          <Text dimColor>読み込み中…</Text>
        )}
      </Box>
    </Box>
  )
}

/**
 * ラベル + 値の 1 行（詳細のメタ情報表示に使う内部 presentational）。
 *
 * @param props ラベルと子要素。
 * @returns 整形済みの 1 行。
 */
function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <Text>
      <Text dimColor>{label.padEnd(12)}</Text>
      {children}
    </Text>
  )
}
