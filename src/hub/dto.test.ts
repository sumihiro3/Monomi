import { describe, expect, it } from 'vitest'
import type { SessionTerminal } from '../domain/entities.js'
import { toEpochMs } from '../domain/time.js'
import { toTerminalDto } from './dto.js'

describe('toTerminalDto (release-23 FR-03)', () => {
  it('maps a full SessionTerminal to the snake_case wire shape, dropping seenAt', () => {
    const terminal: SessionTerminal = {
      tty: '/dev/ttys003',
      termProgram: 'Apple_Terminal',
      tmuxPane: '%3',
      tmuxSocket: 'default',
      wslDistro: null,
      wtSession: null,
      seenAt: toEpochMs(1_000),
    }

    expect(toTerminalDto(terminal)).toEqual({
      tty: '/dev/ttys003',
      term_program: 'Apple_Terminal',
      tmux_pane: '%3',
      tmux_socket: 'default',
      wsl_distro: null,
      wt_session: null,
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
      seenAt: toEpochMs(1_000),
    }

    expect(toTerminalDto(terminal)).toEqual({
      tty: null,
      term_program: null,
      tmux_pane: null,
      tmux_socket: null,
      wsl_distro: null,
      wt_session: null,
    })
  })
})
