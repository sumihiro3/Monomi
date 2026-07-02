import { describe, expect, it } from 'vitest'
import { deriveDeviceId, FALLBACK_DEVICE_ID } from './device-id.js'

describe('deriveDeviceId', () => {
  it('slugifies the first DNS label and lowercases it', () => {
    expect(deriveDeviceId('Sumihiros-MacBook-Pro.local')).toBe('sumihiros-macbook-pro')
  })

  it('drops everything after the first dot', () => {
    expect(deriveDeviceId('macmini.lan.example.com')).toBe('macmini')
  })

  it('collapses non-alphanumeric runs to single dashes and trims them', () => {
    expect(deriveDeviceId('__My  Host!!')).toBe('my-host')
  })

  it('falls back when the hostname has no usable characters', () => {
    expect(deriveDeviceId('...')).toBe(FALLBACK_DEVICE_ID)
    expect(deriveDeviceId('')).toBe(FALLBACK_DEVICE_ID)
  })
})
