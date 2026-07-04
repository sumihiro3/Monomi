import { describe, expect, it } from 'vitest'
import { MONOMI_VERSION } from './index.js'
import packageJson from '../package.json' with { type: 'json' }

describe('smoke', () => {
  it('exposes a version string', () => {
    expect(MONOMI_VERSION).toBe(packageJson.version)
  })
})
