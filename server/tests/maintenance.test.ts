import { afterEach, describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../src/hardware/sim'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'
import { createApp } from '../app'
import { maintenanceOrigin, type MaintenanceOptions } from '../maintenance'

const key = 'a'.repeat(64)
const auth = { host: 'garden.example', origin: 'https://garden.example', authorization: `Bearer ${key}` }
const cores: Array<ReturnType<typeof createCore>> = []
afterEach(async () => {
  await Promise.all(cores.splice(0).map(core => core.stop()))
})

function app(o: MaintenanceOptions = {}) {
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test' })
  cores.push(core)
  return createApp({ ctx: core.ctx, maintenance: { available: () => true, busy: async () => false, ...o } }).app
}

describe('maintenance API', () => {
  it('requires a same-origin HTTPS URL or a real loopback peer for the SSH tunnel', () => {
    expect(maintenanceOrigin('https://garden.example', 'garden.example', '10.0.0.5')).toBe(true)
    expect(maintenanceOrigin('https://elsewhere.example', 'garden.example', '127.0.0.1')).toBe(false)
    expect(maintenanceOrigin('http://10.0.0.2', '10.0.0.2', '10.0.0.5')).toBe(false)
    expect(maintenanceOrigin('http://localhost:13000', 'localhost:13000', '::ffff:127.0.0.1')).toBe(true)
    expect(maintenanceOrigin('http://localhost:13000', 'localhost:13000', '10.0.0.5')).toBe(false)
    expect(maintenanceOrigin(undefined, 'garden.example', '127.0.0.1')).toBe(false)
  })

  it('does not call the helper without a key, disables actions by default, and rejects an unrecognized verb', async () => {
    const execute = vi.fn<NonNullable<MaintenanceOptions['execute']>>()
    const a = app({ execute, available: () => false })
    const status = await a.request('/api/maintenance/status')
    const info = await status.json()
    expect(info).toMatchObject({ configured: false, halOnline: true, pump: 'off', version: 'test' })
    expect(info).not.toHaveProperty('key')
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect((await a.request('/api/maintenance/reboot', { method: 'POST', headers: { ...auth, authorization: '' } })).status).toBe(401)
    expect((await a.request('/api/maintenance/reboot', { method: 'POST', headers: auth })).status).toBe(503)
    expect((await a.request('/api/maintenance/run', { method: 'POST', headers: auth })).status).toBe(404)
    const preflight = await a.request('/api/maintenance/reboot', { method: 'OPTIONS', headers: { 'origin': 'https://outside.example', 'access-control-request-method': 'POST' } })
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })

  it('queues both actions only after the helper accepts them, with a rate bound', async () => {
    const execute = vi.fn<NonNullable<MaintenanceOptions['execute']>>().mockResolvedValue({ ok: true })
    let time = 0
    const a = app({ execute, now: () => time })
    const send = (action: string) => a.request(`/api/maintenance/${action}`, { method: 'POST', headers: auth })
    expect((await send('restart-core')).status).toBe(202)
    expect(execute).toHaveBeenCalledWith('restart-core', key)
    expect((await send('reboot')).status).toBe(429)
    time = 2100
    expect((await send('reboot')).status).toBe(202)
    expect(execute).toHaveBeenLastCalledWith('reboot', key)
  })

  it('returns a safe error on a hardware refusal instead of claiming recovery started', async () => {
    const a = app({ execute: async () => ({ ok: false, code: 'actuator-active' }) })
    const res = await a.request('/api/maintenance/reboot', { method: 'POST', headers: auth })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Wait until the pump and all dosers are off.' })
  })
})
