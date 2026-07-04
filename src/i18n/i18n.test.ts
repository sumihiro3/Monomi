import { afterEach, describe, expect, it } from 'vitest'
import { EN } from './en.js'
import { getActiveLocale, resolveLocale, setActiveLocale, t, translate } from './index.js'
import { JA } from './ja.js'

// テスト間で active ロケールを既定 en へリセットする規約（このファイル内の全 describe が対象）。
afterEach(() => {
  setActiveLocale('en')
})

describe('resolveLocale (FR-01 AC-2)', () => {
  it('undefined は en に解決する', () => {
    expect(resolveLocale(undefined)).toBe('en')
  })

  it('ja はそのまま ja に解決する', () => {
    expect(resolveLocale('ja')).toBe('ja')
  })

  it('en はそのまま en に解決する', () => {
    expect(resolveLocale('en')).toBe('en')
  })
})

describe('setActiveLocale / getActiveLocale', () => {
  it('既定は en', () => {
    expect(getActiveLocale()).toBe('en')
  })

  it('設定した値を反映する', () => {
    setActiveLocale('ja')
    expect(getActiveLocale()).toBe('ja')
  })
})

describe('t (アクティブロケールに応じた解決)', () => {
  it('既定(en)では EN の値を返す', () => {
    expect(t('status.active')).toBe(EN['status.active'])
    expect(t('status.active')).toBe('Active')
  })

  it('setActiveLocale("ja") 後は JA の値を返す', () => {
    setActiveLocale('ja')
    expect(t('status.active')).toBe(JA['status.active'])
    expect(t('status.active')).toBe('稼働中')
  })

  it('en へ戻すと再び EN の値を返す', () => {
    setActiveLocale('ja')
    setActiveLocale('en')
    expect(t('status.stale')).toBe('Stale')
  })
})

describe('t の {var} 置換', () => {
  it('vars の同名キーで置換する', () => {
    expect(t('detail.elapsedSuffix', { age: '3m' })).toBe('3m elapsed')
  })

  it('ja でも置換される', () => {
    setActiveLocale('ja')
    expect(t('detail.elapsedSuffix', { age: '3m' })).toBe('3m経過')
  })

  it('複数の {var} を置換する', () => {
    expect(t('cli.hubDevices.revokeSuccess', { revoked: 2, deviceId: 'dev-1' })).toBe(
      'Revoked 2 token(s) for device "dev-1". That device must pair again to reconnect.'
    )
  })

  it('vars を渡さなければプレースホルダーを含む文字列をそのまま返す', () => {
    expect(t('detail.elapsedSuffix')).toBe('{age} elapsed')
  })

  it('vars に対応するキーが無いプレースホルダーはそのまま残す', () => {
    expect(t('detail.elapsedSuffix', {})).toBe('{age} elapsed')
  })
})

describe('translate (FR-01 AC-5 のテストシーム: 不完全テーブルは en へフォールバック)', () => {
  it('キーが存在すればそのテーブルの値を返す', () => {
    expect(translate({ 'status.active': 'カスタム' }, 'status.active')).toBe('カスタム')
  })

  it('キーが無ければ EN の値へフォールバックする', () => {
    expect(translate({}, 'status.active')).toBe(EN['status.active'])
  })

  it('一部キーだけを持つ不完全なテーブルでも、無いキーは en フォールバックする', () => {
    const partial = { 'status.active': JA['status.active'] }
    expect(translate(partial, 'status.active')).toBe('稼働中')
    expect(translate(partial, 'status.closed')).toBe(EN['status.closed'])
  })
})

describe('EN/JA テーブルの整合性（型チェック外の実行時サニティ）', () => {
  it('EN の全キーが空文字列でない（AC-3: プレースホルダー無し）', () => {
    for (const key of Object.keys(EN)) {
      expect(EN[key as keyof typeof EN].length).toBeGreaterThan(0)
    }
  })

  it('JA の全キーが空文字列でない（AC-3: プレースホルダー無し）', () => {
    for (const key of Object.keys(JA)) {
      expect(JA[key as keyof typeof JA].length).toBeGreaterThan(0)
    }
  })
})
