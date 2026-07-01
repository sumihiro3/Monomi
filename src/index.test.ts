import { describe, expect, it } from 'vitest'
import { MONOMI_VERSION } from './index.js'

describe('smoke', () => {
  it('exposes a version string', () => {
    expect(MONOMI_VERSION).toBe('0.0.1')
  })
})
