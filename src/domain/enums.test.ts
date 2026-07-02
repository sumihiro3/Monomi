import { describe, expect, it } from 'vitest'
import {
  DEVICE_ROLES,
  DISPLAY_STATUSES,
  EVENT_TYPES,
  PROJECT_KEY_KINDS,
  RAW_STATES,
} from './enums.js'

describe('EVENT_TYPES', () => {
  it('covers the 7 Claude Code hooks used by release-1 plus the worktree/session_lost extensions', () => {
    expect(EVENT_TYPES).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'Stop',
      'SessionEnd',
      'WorktreeCreate',
      'WorktreeRemove',
      'session_lost',
    ])
  })

  it('does not include PermissionRequest (§0.5: superseded by Notification(permission_prompt))', () => {
    expect(EVENT_TYPES).not.toContain('PermissionRequest')
  })
})

describe('DEVICE_ROLES', () => {
  it('is HUB/CHILD', () => {
    expect(DEVICE_ROLES).toEqual(['HUB', 'CHILD'])
  })
})

describe('RAW_STATES', () => {
  it('is ACTIVE/APPROVAL_WAIT/NEXT_WAIT/CLOSED (no PR_WAIT/STALE, those are display-only)', () => {
    expect(RAW_STATES).toEqual(['ACTIVE', 'APPROVAL_WAIT', 'NEXT_WAIT', 'CLOSED'])
  })
})

describe('DISPLAY_STATUSES', () => {
  it('adds PR_WAIT/STALE on top of the raw states and drops CLOSED (§5.1: closed is hidden)', () => {
    expect(DISPLAY_STATUSES).toEqual(['ACTIVE', 'APPROVAL_WAIT', 'NEXT_WAIT', 'PR_WAIT', 'STALE'])
    expect(DISPLAY_STATUSES).not.toContain('CLOSED')
  })
})

describe('PROJECT_KEY_KINDS', () => {
  it('is GIT_REMOTE/LOCAL_NO_REMOTE/NO_GIT', () => {
    expect(PROJECT_KEY_KINDS).toEqual(['GIT_REMOTE', 'LOCAL_NO_REMOTE', 'NO_GIT'])
  })
})
