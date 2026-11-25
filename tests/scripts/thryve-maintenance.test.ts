import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

interface Hardware {
  isBusy?: () => boolean
  halState?: () => Promise<unknown>
  now?: () => number
}
interface Operation {
  execute?: boolean
  key?: string
  lookup?: () => string
  check?: () => Promise<void>
  run?: (command: string, args: string[], opts: unknown) => Promise<unknown>
}

const requireHelper = createRequire(import.meta.url)
const { authenticate, checkHardware, operate, provision, readKey } = requireHelper('../../scripts/thryve-maintenance.cjs') as {
  authenticate: (key: string, lookup: () => string) => void
  checkHardware: (o: Hardware) => Promise<void>
  operate: (action: string, o: Operation) => Promise<void>
  provision: (path: string) => string
  readKey: (path: string) => string
}
const key = 'a'.repeat(64)
const now = Date.parse('2026-11-24T12:00:00Z')
const ts = new Date(now).toISOString()
const safe = { ts, actuators: { pump: { on: false }, dose_1: { on: false } } }
const hardware = { isBusy: () => false, now: () => now, halState: async () => safe }

it('provisions a private, random key separately from settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thryve-maintenance-'))
  try {
    const path = join(dir, 'key')
    const generated = provision(path)
    expect(generated).toMatch(/^[a-f0-9]{64}$/)
    expect(readKey(path)).toBe(generated)
    expect(provision(path)).toBe(generated)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => authenticate('b'.repeat(64), () => generated)).toThrow('unauthorized')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('fails closed when HALD is unavailable, stale, missing the pump, or running an actuator', async () => {
  await expect(checkHardware(hardware)).resolves.toBeUndefined()
  const state = (snapshot: unknown) => checkHardware({ ...hardware, halState: async () => snapshot })
  await expect(state({ ...safe, ts: '2026-11-24T11:55:00Z' })).rejects.toThrow('hald-unavailable')
  await expect(state({ ts, actuators: {} })).rejects.toThrow('hald-unavailable')
  await expect(state({ ts, actuators: { pump: { on: true } } })).rejects.toThrow('actuator-active')
  await expect(state({ ts, actuators: { pump: { on: false }, dose_1: { on: true } } })).rejects.toThrow('actuator-active')
  await expect(checkHardware({ ...hardware, halState: () => Promise.reject(new Error('timeout')) })).rejects.toThrow('hald-unavailable')
  await expect(checkHardware({ ...hardware, isBusy: () => true })).rejects.toThrow('busy')
  const becameBusy = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  await expect(checkHardware({ ...hardware, isBusy: becameBusy })).rejects.toThrow('busy')
})

it('queues a fixed delayed action without putting the key in argv, and checks safety again at execution', async () => {
  const run = vi.fn(async () => undefined)
  const check = vi.fn(async () => undefined)
  const queue = { key, lookup: () => key, check, run }
  await expect(operate('reboot', { ...queue, key: 'b'.repeat(64) })).rejects.toThrow('unauthorized')
  expect(run).not.toHaveBeenCalled()
  await operate('reboot', queue)
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/systemd-run', [
    '--quiet', '--collect', '--unit=thryve-manual-maintenance', '--on-active=3s', '--timer-property=AccuracySec=1s',
    '/usr/local/sbin/thryve-maintenance', '--execute', 'reboot',
  ], { timeout: 5000 })
  run.mockClear()
  check.mockRejectedValueOnce(new Error('actuator-active'))
  await expect(operate('reboot', { execute: true, check, run })).rejects.toThrow('actuator-active')
  expect(run).not.toHaveBeenCalled()
  await operate('restart-core', { execute: true, check, run })
  expect(run).toHaveBeenCalledWith('/usr/bin/systemctl', ['--no-block', 'restart', 'thryve-core.service'], { timeout: 5000 })
  await operate('reboot', { execute: true, check, run })
  expect(run).toHaveBeenCalledWith('/usr/bin/systemctl', ['--no-block', 'reboot'], { timeout: 5000 })
})
