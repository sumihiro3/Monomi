import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceStatusRow } from '../../hub/dto.js'
import { setActiveLocale } from '../../i18n/index.js'
import { InstanceCard } from './instance-card.js'

/** ANSI シアン（前景色）のエスケープ。ink がボーダー色 `cyan` に対して出力する。 */
const CYAN = '[36m'

/** テスト用 instance 行を作る（表示に効く最小フィールドのみ指定）。 */
function makeRow(over: {
  projectName?: string
  deviceName?: string
  branch?: string | null
  path?: string
  display?: string
  elapsedSeconds?: number
  runningWork?: InstanceStatusRow['running_work']
  terminal?: InstanceStatusRow['session']['terminal']
}): InstanceStatusRow {
  const display = over.display ?? 'approval_wait'
  return {
    instance_id: 'inst-1',
    project: { id: 'proj-1', name: over.projectName ?? 'ProjectLens' },
    device: { id: 'macmini', name: over.deviceName ?? 'Mac mini' },
    path: over.path ?? '/Users/sumihiro/dev/ProjectLens',
    branch: over.branch === undefined ? 'feature/ai-sidecar' : over.branch,
    status: {
      display,
      raw_state: display === 'stale' ? 'active' : display,
      elapsed_seconds: over.elapsedSeconds ?? 720,
      is_stale: display === 'stale',
      priority: 4,
    },
    pr: { state: 'none', number: null, url: null, is_draft: false },
    session: {
      id: 'sess-1',
      last_heartbeat_at: null,
      terminal: over.terminal === undefined ? null : over.terminal,
    },
    running_work: over.runningWork === undefined ? null : over.runningWork,
  }
}

/** テスト用 `session.terminal` を作る（表示に効く最小フィールドのみ指定）。 */
function makeTerminal(
  over: Partial<NonNullable<InstanceStatusRow['session']['terminal']>>
): NonNullable<InstanceStatusRow['session']['terminal']> {
  return {
    tty: over.tty ?? '/dev/ttys003',
    term_program: over.term_program ?? null,
    tmux_pane: over.tmux_pane ?? null,
    tmux_socket: over.tmux_socket ?? null,
    wsl_distro: over.wsl_distro ?? null,
    wt_session: over.wt_session ?? null,
    wezterm_pane: over.wezterm_pane ?? null,
  }
}

afterEach(() => {
  setActiveLocale('en')
})

describe('InstanceCard（FR-01）', () => {
  it('AC-1: 既定ロケール（en）で project/device/branch/状態ラベル/age を描画する（release-9-i18n FR-01 AC-2）', () => {
    const { lastFrame } = render(<InstanceCard row={makeRow({})} selected={false} width={36} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('ProjectLens')
    expect(frame).toContain('Mac mini')
    expect(frame).toContain('feature/ai-sidecar')
    expect(frame).toContain('Awaiting approval') // approval_wait の en ラベル（status-display 再利用、AC-3）
    expect(frame).toContain('○') // approval_wait のグリフ
    expect(frame).toContain('12m') // 720 秒 → 12m（formatAge 再利用）
  })

  it('AC-1: locale: ja で状態ラベルが日本語で描画される（release-9-i18n FR-02 AC-2・AC-5）', () => {
    setActiveLocale('ja')
    const { lastFrame } = render(<InstanceCard row={makeRow({})} selected={false} width={36} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('権限待ち') // approval_wait のラベル（status-display 再利用、AC-3）
    expect(frame).toContain('○') // approval_wait のグリフ
    expect(frame).toContain('12m') // 720 秒 → 12m（formatAge 再利用）
  })

  it('AC-1: branch が null のとき "-" を描画する', () => {
    const { lastFrame } = render(
      <InstanceCard row={makeRow({ branch: null })} selected={false} width={36} />
    )
    expect(lastFrame() ?? '').toContain('-')
  })

  it('AC-2: selected=true でボーダー色が cyan になる（未選択では付かない）', () => {
    // 状態色が cyan でない approval_wait を使い、cyan の出所をボーダーに限定する。
    const unselected =
      render(<InstanceCard row={makeRow({})} selected={false} width={36} />).lastFrame() ?? ''
    const selected =
      render(<InstanceCard row={makeRow({})} selected width={36} />).lastFrame() ?? ''

    expect(unselected).not.toContain(CYAN)
    expect(selected).toContain(CYAN)
  })

  it('AC-1/AC-2: selected=true で borderStyle が double 罫線になり cyan が付く（release-10-dashboard-polish FR-04）', () => {
    const { lastFrame } = render(<InstanceCard row={makeRow({})} selected width={36} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('╔') // double 罫線（cli-boxes: double.topLeft）
    expect(frame).toContain(CYAN)
  })

  it('AC-2: selected=false では borderStyle が round 罫線のままで cyan は付かない（release-10-dashboard-polish FR-04）', () => {
    const { lastFrame } = render(<InstanceCard row={makeRow({})} selected={false} width={36} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('╭') // round 罫線（cli-boxes: round.topLeft）
    expect(frame).not.toContain(CYAN)
  })

  it('device.name / branch に含まれる ANSI エスケープを除染して描画する（release-10-dashboard-polish レビュー修正: CWE-150）', () => {
    const ESC = String.fromCharCode(27)
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({
          deviceName: `Mac mini${ESC}[2J`,
          branch: `feature/x${ESC}]0;PWNED${String.fromCharCode(7)}`,
        })}
        selected={false}
        width={40}
      />
    )
    const frame = lastFrame() ?? ''
    // ESC 自体は Ink の正当な SGR カラーコードにも出現するため、注入した具体的な
    // シーケンス（画面消去・OSC タイトル書換）のみが除去されていることを確認する。
    expect(frame).not.toContain(`${ESC}[2J`)
    expect(frame).not.toContain('PWNED')
    expect(frame).toContain('Mac mini')
    expect(frame).toContain('feature/x')
  })

  it('project.name に含まれる ANSI エスケープ・制御文字を除染して描画する（release-21-known-issues-cleanup FR-02: CWE-150）', () => {
    const ESC = String.fromCharCode(27)
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({
          projectName: `ProjectLens${ESC}]0;PWNED${String.fromCharCode(7)}`,
        })}
        selected={false}
        width={40}
      />
    )
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('PWNED')
    expect(frame).toContain('ProjectLens')
  })
})

describe('InstanceCard — device 行のターミナル併記（release-24-dashboard-display-polish FR-03、既知課題 U16）', () => {
  it('AC-1: session.terminal.term_program が既知値のとき device 行に "device (<terminal>)" を描画する', () => {
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({
          deviceName: 'Mac mini',
          terminal: makeTerminal({ term_program: 'ghostty' }),
        })}
        selected={false}
        width={40}
      />
    )
    expect(lastFrame() ?? '').toContain('Mac mini (Ghostty)')
  })

  it('AC-4: wsl_distro のみ非 null のとき device 行に distro 名を併記する', () => {
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({
          deviceName: 'win-laptop',
          terminal: makeTerminal({ term_program: null, wsl_distro: 'Ubuntu' }),
        })}
        selected={false}
        width={40}
      />
    )
    expect(lastFrame() ?? '').toContain('win-laptop (Ubuntu)')
  })

  it('AC-3: session.terminal が null のとき device 行は device 名のみで括弧を付けない', () => {
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({ deviceName: 'Mac mini', terminal: null })}
        selected={false}
        width={40}
      />
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Mac mini')
    expect(frame).not.toContain('(')
  })

  it('AC-3: term_program/wsl_distro がともに null のとき device 行は device 名のみで括弧を付けない', () => {
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({ deviceName: 'Mac mini', terminal: makeTerminal({}) })}
        selected={false}
        width={40}
      />
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Mac mini')
    expect(frame).not.toContain('(')
  })

  it('AC-2: ターミナル名に含まれる ANSI エスケープ・制御文字を除染して描画する（CWE-150）', () => {
    const ESC = String.fromCharCode(27)
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({
          deviceName: 'Mac mini',
          terminal: makeTerminal({
            term_program: null,
            wsl_distro: `Ubuntu${ESC}]0;PWNED${String.fromCharCode(7)}`,
          }),
        })}
        selected={false}
        width={50}
      />
    )
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('PWNED')
    expect(frame).toContain('Mac mini (Ubuntu)')
  })
})

describe('InstanceCard — path 行（release-24-dashboard-display-polish FR-05、既知課題 U18）', () => {
  it('AC: 長い path はホーム短縮なしのまま 先頭…末尾 形式で中間省略される（幅=width-罫線・paddingX分 に一致）', () => {
    // width=19 → 罫線2桁+paddingX左右2桁(計4桁)を引いた maxWidth=15
    // （truncate-path.test.ts の同一入力と同じ結果）。
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({ path: '/opt/dev/Monomi/release-23/src' })}
        selected={false}
        width={19}
      />
    )
    expect(lastFrame() ?? '').toContain('/opt/de…-23/src')
  })

  it('AC: カード幅に収まる短い path はホーム短縮のみ適用され省略記号を含まず表示される', () => {
    const { lastFrame } = render(
      <InstanceCard row={makeRow({ path: '/Users/sumihiro/proj' })} selected={false} width={40} />
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('~/proj')
    expect(frame).not.toContain('…')
  })

  it('AC: 全角混じりの path でも displayWidth ベースで正しく中間省略される', () => {
    // width=14 → 罫線2桁+paddingX左右2桁(計4桁)を引いた maxWidth=10
    // （truncate-path.test.ts の同一入力と同じ結果）。
    const { lastFrame } = render(
      <InstanceCard row={makeRow({ path: 'あいうえお/1234567890' })} selected={false} width={14} />
    )
    expect(lastFrame() ?? '').toContain('あい…67890')
  })

  it('path に含まれる ANSI エスケープ・制御文字を除染してから幅計算・表示する（CWE-150）', () => {
    const ESC = String.fromCharCode(27)
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({ path: `/opt/proj${ESC}]0;PWNED${String.fromCharCode(7)}` })}
        selected={false}
        width={60}
      />
    )
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('PWNED')
    expect(frame).toContain('/opt/proj')
  })

  it('width 未指定時は FALLBACK_BOX_WIDTH(80) 相当を基準にホーム短縮・省略を行う', () => {
    const { lastFrame } = render(
      <InstanceCard row={makeRow({ path: '/Users/sumihiro/proj' })} selected={false} />
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('~/proj')
  })
})

describe('InstanceCard — running_work（release-16-running-work-display FR-03 AC-1/2/4/5）', () => {
  it('AC-1: running_work があるとき "▶ <name>" 行を描画する', () => {
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({ runningWork: { kind: 'workflow', name: 'run-release', started_at: null } })}
        selected={false}
        width={36}
      />
    )
    expect(lastFrame() ?? '').toContain('▶ run-release')
  })

  it('AC-2: running_work が null のとき "-" を描画し、行数（カード高さ）は running_work あり/なしで変わらない', () => {
    const withWork = render(
      <InstanceCard
        row={makeRow({ runningWork: { kind: 'skill', name: 'code-review', started_at: null } })}
        selected={false}
        width={36}
      />
    ).lastFrame()
    const withoutWork = render(
      <InstanceCard row={makeRow({ runningWork: null })} selected={false} width={36} />
    ).lastFrame()

    expect(withoutWork ?? '').not.toContain('▶')
    expect((withoutWork ?? '').split('\n')).toHaveLength((withWork ?? '').split('\n').length)
  })

  it('AC-4: running_work.name に含まれる ANSI エスケープ・制御文字を除染して描画する（CWE-150）', () => {
    const ESC = String.fromCharCode(27)
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({
          runningWork: {
            kind: 'agent',
            name: `explorer${ESC}]0;PWNED${String.fromCharCode(7)}`,
            started_at: null,
          },
        })}
        selected={false}
        width={40}
      />
    )
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('PWNED')
    expect(frame).toContain('▶ explorer')
  })

  it('AC-5: カード幅に収まらない長い名前は切り詰められ、レイアウトが崩れない', () => {
    const longName = `run-release-with-a-very-long-workflow-name-that-overflows-the-card-width-${'x'.repeat(60)}`
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({ runningWork: { kind: 'workflow', name: longName, started_at: null } })}
        selected={false}
        width={24}
      />
    )
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')
    expect(frame).not.toContain(longName)
    // 罫線を含む全行が同じ表示幅（=カード width）に収まっている（崩れなし）。
    for (const line of lines) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR コードのみ除去して幅を測る
      const visible = line.replace(/\u001b\[[0-9;]*m/g, '')
      expect(visible.length).toBeLessThanOrEqual(24)
    }
  })
})

describe('InstanceCard — running_work の経過時間表示（release-18 FR-05 AC-1）', () => {
  it('running_work.started_at があるとき "▶ <name> (<経過時間>)" 行を描画する', () => {
    // 12分5秒前（60秒バケットの境界から離した安全マージン）。
    const startedAt = new Date(Date.now() - (12 * 60 + 5) * 1000).toISOString()
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({
          runningWork: { kind: 'workflow', name: 'run-release', started_at: startedAt },
        })}
        selected={false}
        width={40}
      />
    )
    expect(lastFrame() ?? '').toContain('▶ run-release (12m)')
  })

  it('running_work.started_at が null（旧 hub との混在）のときは経過時間を省き従来表示にフォールバックする', () => {
    const { lastFrame } = render(
      <InstanceCard
        row={makeRow({ runningWork: { kind: 'workflow', name: 'run-release', started_at: null } })}
        selected={false}
        width={40}
      />
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▶ run-release')
    expect(frame).not.toMatch(/▶ run-release \(/)
  })
})
