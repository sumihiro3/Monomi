import { describe, expect, it } from 'vitest'
import { detectLocaleFromEnv } from './os-locale.js'

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
