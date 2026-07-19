import { describe, expect, it } from 'vitest'
import type { PrStatus, SessionTerminal } from '../domain/entities.js'
import { toEpochMs } from '../domain/time.js'
import { toPrDto, toTerminalDto } from './dto.js'

describe('toTerminalDto (release-23 FR-03)', () => {
  it('maps a full SessionTerminal to the snake_case wire shape, dropping seenAt', () => {
    const terminal: SessionTerminal = {
      tty: '/dev/ttys003',
      termProgram: 'Apple_Terminal',
      tmuxPane: '%3',
      tmuxSocket: 'default',
      wslDistro: null,
      wtSession: null,
      weztermPane: null,
      seenAt: toEpochMs(1_000),
    }

    expect(toTerminalDto(terminal)).toEqual({
      tty: '/dev/ttys003',
      term_program: 'Apple_Terminal',
      tmux_pane: '%3',
      tmux_socket: 'default',
      wsl_distro: null,
      wt_session: null,
      wezterm_pane: null,
    })
  })

  it('returns null when the session has never reported terminal info', () => {
    expect(toTerminalDto(null)).toBeNull()
  })

  it('passes through individual null fields the reporter could not resolve', () => {
    const terminal: SessionTerminal = {
      tty: null,
      termProgram: null,
      tmuxPane: null,
      tmuxSocket: null,
      wslDistro: null,
      wtSession: null,
      weztermPane: null,
      seenAt: toEpochMs(1_000),
    }

    expect(toTerminalDto(terminal)).toEqual({
      tty: null,
      term_program: null,
      tmux_pane: null,
      tmux_socket: null,
      wsl_distro: null,
      wt_session: null,
      wezterm_pane: null,
    })
  })
})

describe('toPrDto (release-27 FR-05a)', () => {
  it('returns the none default when there is no PR status row', () => {
    expect(toPrDto(null)).toEqual({
      state: 'none',
      number: null,
      url: null,
      is_draft: false,
    })
  })

  it('maps a non-null PrStatus, carrying number/url/is_draft through', () => {
    const pr: PrStatus = {
      id: 1,
      projectId: 'proj-1',
      branch: 'feature/ai-sidecar',
      prNumber: 42,
      state: 'awaiting_review',
      isDraft: true,
      url: 'https://github.com/sumihiro/monomi/pull/42',
      checkedAt: toEpochMs(1_000),
    }

    expect(toPrDto(pr)).toEqual({
      state: 'awaiting_review',
      number: 42,
      url: 'https://github.com/sumihiro/monomi/pull/42',
      is_draft: true,
    })
  })

  it('maps a merged non-draft PrStatus with no url', () => {
    const pr: PrStatus = {
      id: 2,
      projectId: 'proj-1',
      branch: 'main',
      prNumber: 7,
      state: 'merged',
      isDraft: false,
      url: null,
      checkedAt: toEpochMs(2_000),
    }

    expect(toPrDto(pr)).toEqual({
      state: 'merged',
      number: 7,
      url: null,
      is_draft: false,
    })
  })
})
