import { describe, expect, it } from 'vitest'
import { extractChangelogNotes } from './extract-changelog-notes.mjs'

// 決定性のため、実 CHANGELOG.md ではなくインライン文字列のフィクスチャを使う。
const CHANGELOG_FIXTURE = `# Changelog

## [Unreleased]

## [0.1.2] - 2026-07-14

### Added

- something for 0.1.2

## [0.1.1] - 2026-07-10

### Changed

- something for 0.1.1

### Fixed

- fix for 0.1.1

## [0.0.1] - 2026-07-07

Initial release notes.

### Added

- initial feature
`

const EMPTY_BODY_FIXTURE = `# Changelog

## [1.0.1] - 2026-01-01
## [1.0.0] - 2025-12-31

### Added

- x
`

describe('extractChangelogNotes', () => {
  it('extracts the body of a middle version (bounded by headings above and below)', () => {
    expect(extractChangelogNotes(CHANGELOG_FIXTURE, '0.1.1')).toBe(
      '### Changed\n\n- something for 0.1.1\n\n### Fixed\n\n- fix for 0.1.1'
    )
  })

  it('extracts the body of the oldest version (no following heading, terminated by EOF)', () => {
    expect(extractChangelogNotes(CHANGELOG_FIXTURE, '0.0.1')).toBe(
      'Initial release notes.\n\n### Added\n\n- initial feature'
    )
  })

  it('throws when the requested version heading does not exist', () => {
    expect(() => extractChangelogNotes(CHANGELOG_FIXTURE, '9.9.9')).toThrow(/"9\.9\.9"/)
  })

  it('throws when the matched section body is empty', () => {
    expect(() => extractChangelogNotes(EMPTY_BODY_FIXTURE, '1.0.1')).toThrow(/本文が空/)
  })
})
