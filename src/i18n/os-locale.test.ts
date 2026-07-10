import { describe, expect, it } from 'vitest'
import { detectLocaleFromEnv, detectMacOsLocale, detectOsLocale } from './os-locale.js'

describe('detectLocaleFromEnv (release-19 FR-02)', () => {
  it('ja_JP.UTF-8 は ja に解決する', () => {
    expect(detectLocaleFromEnv({ LANG: 'ja_JP.UTF-8' })).toBe('ja')
  })

  it('en_US.UTF-8 は en に解決する', () => {
    expect(detectLocaleFromEnv({ LANG: 'en_US.UTF-8' })).toBe('en')
  })

  it('ja はそのまま ja に解決する', () => {
    expect(detectLocaleFromEnv({ LANG: 'ja' })).toBe('ja')
  })

  it('en はそのまま en に解決する', () => {
    expect(detectLocaleFromEnv({ LANG: 'en' })).toBe('en')
  })

  it('C は undefined', () => {
    expect(detectLocaleFromEnv({ LANG: 'C' })).toBeUndefined()
  })

  it('POSIX は undefined', () => {
    expect(detectLocaleFromEnv({ LANG: 'POSIX' })).toBeUndefined()
  })

  it('de_DE.UTF-8 のようなサポート外言語は undefined', () => {
    expect(detectLocaleFromEnv({ LANG: 'de_DE.UTF-8' })).toBeUndefined()
  })

  it('ja@calendar=japanese のような @ 修飾子付きも ja に解決する（B10）', () => {
    expect(detectLocaleFromEnv({ LANG: 'ja@calendar=japanese' })).toBe('ja')
  })

  it('en@euro のような @ 修飾子付きも en に解決する（B10）', () => {
    expect(detectLocaleFromEnv({ LANG: 'en@euro' })).toBe('en')
  })

  it('空文字は undefined', () => {
    expect(detectLocaleFromEnv({ LANG: '' })).toBeUndefined()
  })

  it('LANG 未設定は undefined', () => {
    expect(detectLocaleFromEnv({})).toBeUndefined()
  })

  it('引数省略時は process.env を参照する', () => {
    const original = process.env.LANG
    process.env.LANG = 'ja_JP.UTF-8'
    try {
      expect(detectLocaleFromEnv()).toBe('ja')
    } finally {
      if (original === undefined) {
        delete process.env.LANG
      } else {
        process.env.LANG = original
      }
    }
  })
})

describe('detectMacOsLocale（release-19 FR-02 修正: LANG が macOS のシステム言語設定と連動しない実機事例への対応）', () => {
  it('darwin かつ AppleLocale=ja_JP なら ja に解決する', () => {
    expect(detectMacOsLocale('darwin', () => 'ja_JP')).toBe('ja')
  })

  it('darwin かつ AppleLocale=en_US なら en に解決する', () => {
    expect(detectMacOsLocale('darwin', () => 'en_US')).toBe('en')
  })

  it('darwin かつ AppleLocale がサポート外言語（例: fr_FR）なら undefined', () => {
    expect(detectMacOsLocale('darwin', () => 'fr_FR')).toBeUndefined()
  })

  it('darwin かつ AppleLocale を取得できない（defaults 失敗等）なら undefined', () => {
    expect(detectMacOsLocale('darwin', () => undefined)).toBeUndefined()
  })

  it('非 darwin（linux）では readLocale を呼ばず undefined を返す', () => {
    let called = false
    const readLocale = () => {
      called = true
      return 'ja_JP'
    }
    expect(detectMacOsLocale('linux', readLocale)).toBeUndefined()
    expect(called).toBe(false)
  })
})

describe('detectOsLocale（macOS では AppleLocale を LANG より優先する）', () => {
  it('darwin で AppleLocale=ja_JP・LANG=en_US.UTF-8 でも AppleLocale 優先で ja になる', () => {
    expect(detectOsLocale({ LANG: 'en_US.UTF-8' }, 'darwin', () => 'ja_JP')).toBe('ja')
  })

  it('darwin で AppleLocale が取得できない場合は LANG へフォールバックする', () => {
    expect(detectOsLocale({ LANG: 'ja_JP.UTF-8' }, 'darwin', () => undefined)).toBe('ja')
  })

  it('darwin で AppleLocale・LANG のいずれも判定できなければ undefined', () => {
    expect(detectOsLocale({ LANG: 'fr_FR.UTF-8' }, 'darwin', () => 'fr_FR')).toBeUndefined()
  })

  it('非 darwin（linux）では AppleLocale を無視し LANG のみで判定する', () => {
    expect(detectOsLocale({ LANG: 'ja_JP.UTF-8' }, 'linux', () => 'en_US')).toBe('ja')
  })
})
