import { Box, Text } from 'ink'
import { type ReactElement, type ReactNode, useEffect, useState } from 'react'
import type { InstanceDetail, InstanceStatusRow } from '../../hub/dto.js'
import type { HubApiClient } from '../hub-api-client.js'
import { formatAge, statusColor, statusLabel } from '../status-display.js'

/** {@link DetailView} の props（container: 自身で詳細を取得する）。 */
export interface DetailViewProps {
  /** 詳細取得に使う hub クライアント。 */
  client: HubApiClient
  /** 一覧で選択された行（詳細取得前のヘッダ表示・フォールバックに使う）。 */
  row: InstanceStatusRow
}

/**
 * 詳細ビュー（Agent View Lv.1、§10.4）。container。
 *
 * マウント時に {@link HubApiClient.getInstanceDetail} で直近イベントを取得し、
 * status / device / branch / session_id / path / pr と、直近イベントのタイムライン
 * （生の活動ログ）を表示する。status 導出は hub 側の結果（`row.status`）をそのまま描くだけ。
 * esc での「戻る」は AppView 側が握る（本コンポーネントはキー入力を持たない）。
 *
 * @param props {@link DetailViewProps}。
 * @returns 詳細ビューの要素。
 */
export function DetailView({ client, row }: DetailViewProps): ReactElement {
  const [detail, setDetail] = useState<InstanceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    client
      .getInstanceDetail(row.instance_id)
      .then((fetched) => {
        if (!cancelled) setDetail(fetched)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [client, row.instance_id])

  const events = detail?.recent_events ?? []

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{row.project.name}</Text>
        {row.branch !== null ? <Text dimColor> / {row.branch}</Text> : null}
        <Text dimColor>{'   '}[esc] back</Text>
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Field label="status">
          <Text color={statusColor(row.status.display)}>
            {statusLabel(row.status.display)} ({formatAge(row.status.elapsed_seconds)}経過)
          </Text>
        </Field>
        <Field label="device">
          <Text>{row.device.name}</Text>
        </Field>
        <Field label="branch">
          <Text>{row.branch ?? '-'}</Text>
        </Field>
        <Field label="session_id">
          <Text>{row.session.id}</Text>
        </Field>
        <Field label="path">
          <Text>{row.path}</Text>
        </Field>
        <Field label="pr">
          <Text>{row.pr.state}</Text>
        </Field>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>recent events</Text>
        {error !== null ? (
          <Text color="red">詳細の取得に失敗しました: {error}</Text>
        ) : detail === null ? (
          <Text dimColor>読み込み中…</Text>
        ) : events.length === 0 ? (
          <Text dimColor>(イベントがありません)</Text>
        ) : (
          events.map((event) => (
            <Text key={event.id} wrap="truncate-end">
              <Text dimColor>{event.occurred_at} </Text>
              {event.event_type}
              {event.event_subtype !== null ? <Text dimColor> ({event.event_subtype})</Text> : null}
              {event.tool_name !== null ? <Text color="cyan"> {event.tool_name}</Text> : null}
              {event.tool_summary !== null ? <Text dimColor>: {event.tool_summary}</Text> : null}
            </Text>
          ))
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
