import { afterEach, describe, expect, it } from 'vitest'
import { setActiveLocale } from '../i18n/index.js'
import { formatAge, statusColor, statusGlyph, statusLabel } from './status-display.js'

afterEach(() => {
  setActiveLocale('en')
})

describe('statusLabel（release-9-i18n FR-02 AC-2: t() 経由のラベル解決）', () => {
  it('既定ロケール（en）では英語ラベルを返す', () => {
    expect(statusLabel('active')).toBe('Active')
    expect(statusLabel('approval_wait')).toBe('Awaiting approval')
    expect(statusLabel('next_wait')).toBe('Awaiting next instruction')
    expect(statusLabel('pr_wait')).toBe('Awaiting PR review')
    expect(statusLabel('stale')).toBe('Stale')
    expect(statusLabel('closed')).toBe('Closed')
  })

  it('locale: ja では日本語ラベルを返す', () => {
    setActiveLocale('ja')
    expect(statusLabel('active')).toBe('稼働中')
    expect(statusLabel('approval_wait')).toBe('権限待ち')
    expect(statusLabel('next_wait')).toBe('次の指示待ち')
    expect(statusLabel('pr_wait')).toBe('PRレビュー待ち')
    expect(statusLabel('stale')).toBe('放置')
    expect(statusLabel('closed')).toBe('終了')
  })

  it('未知の display はロケールに関わらず入力をそのまま返す（t() を経由しない）', () => {
    expect(statusLabel('unknown_state')).toBe('unknown_state')
    setActiveLocale('ja')
    expect(statusLabel('unknown_state')).toBe('unknown_state')
  })
})

describe('statusColor/statusGlyph/formatAge（ロケール非依存、既存挙動の回帰確認）', () => {
  it('statusColor は既知の display に既定色を返す', () => {
    expect(statusColor('active')).toBe('green')
    expect(statusColor('approval_wait')).toBe('yellow')
    expect(statusColor('unknown_state')).toBe('white')
  })

  it('statusGlyph は active/closed/その他で異なるグリフを返す', () => {
    expect(statusGlyph('active')).toBe('●')
    expect(statusGlyph('closed')).toBe('·')
    expect(statusGlyph('approval_wait')).toBe('○')
  })

  it('formatAge は秒数を短い相対表記へ整形する', () => {
    expect(formatAge(45)).toBe('45s')
    expect(formatAge(720)).toBe('12m')
    expect(formatAge(7200)).toBe('2h')
    expect(formatAge(172800)).toBe('2d')
  })
})
