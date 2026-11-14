import { describe, expect, it } from 'vitest'
import { envValue } from '../legacyEnv'

describe('envValue', () => {
  it('prefers THRYVE_* over a seedypod name', () => {
    expect(envValue({ THRYVE_REPO: 'kaniick/Thryve', SEEDYPOD_REPO: 'seedypod/core' }, 'THRYVE_REPO')).toBe('kaniick/Thryve')
  })

  it('falls back to SEEDYPOD_* when the Thryve name is unset', () => {
    expect(envValue({ SEEDYPOD_REPO: 'seedypod/core' }, 'THRYVE_REPO')).toBe('seedypod/core')
    expect(envValue({ THRYVE_REPO: '', SEEDYPOD_REPO: 'seedypod/core' }, 'THRYVE_REPO')).toBe('seedypod/core')
  })
})
