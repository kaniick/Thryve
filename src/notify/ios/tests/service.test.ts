import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../../../store/memory'
import { ApnsClient, type ApnsTransport } from '../../apns/client'
import type { NotificationChannel } from '../../types'
import { changed, FEED_KEEP, IosService, PUSH_TO_START_DELAY_MS } from '../service'
import type { ApnsSender } from '../types'

const p8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const NOW = new Date('2026-11-16T12:00:00Z')
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

function setup(o: { key?: boolean, transport?: ApnsTransport } = {}) {
  const store = new MemoryStore()
  const transport = vi.fn<ApnsTransport>(o.transport ?? (async () => ({ status: 200, body: '', headers: {} })))
  const apns: ApnsSender = new ApnsClient(transport, () => NOW.getTime())
  let channel: NotificationChannel | null = null
  if (o.key !== false) {
    channel = store.notifications.channels.create({ name: 'iPhone', kind: 'ios', enabled: true, config: { keyId: 'KEY1234567', teamId: 'TEAM123456' }, secrets: { apnsKey: p8 } }, NOW.toISOString())
  }
  const ios = new IosService({ store, apns, now: () => NOW })
  return { store, ios, transport, channel }
}

function nthCall(t: { mock: { calls: Array<[Parameters<ApnsTransport>[0]]> } }, i: number) {
  const c = t.mock.calls[i]
  if (!c) throw new Error(`no call ${i}`)
  return c[0]
}

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing')
  return v
}

const req = { title: 'Tank low', message: 'Water at 12%', priority: 'high' as const }

describe('IosService feed and push', () => {
  it('keeps every send in the feed and pushes to phones with tokens', async () => {
    const { ios, transport, channel, store } = setup()
    expect(ios.register({ deviceId: 'phone-0001', name: 'iPhone', token: TOKEN_A, environment: 'production' })).toEqual({ apnsConfigured: true })
    ios.register({ deviceId: 'phone-0002', name: 'Old iPhone', token: null, environment: 'sandbox' })
    const alert = store.alerts.raise('tank_low', 'Tank low', NOW.toISOString())

    const r = await ios.send(must(channel), { ...req, alertKind: 'tank_low' })
    expect(r.ok).toBe(true)
    expect(transport).toHaveBeenCalledTimes(1)
    const call = nthCall(transport, 0)
    expect(call.path).toBe(`/3/device/${TOKEN_A}`)
    expect(call.headers['apns-topic']).toBe('com.thryve.app')
    expect(call.headers['apns-push-type']).toBe('alert')
    expect(call.headers['apns-collapse-id']).toBe('thryve-1')
    expect(JSON.parse(call.body)).toMatchObject({ aps: { category: 'THRYVE_ALERT' }, alertId: alert.id, feedId: 1 })

    expect(ios.feed(null)).toEqual({ items: [], latestId: 1 })
    expect(ios.feed(0).items).toEqual([{ id: 1, title: 'Tank low', body: 'Water at 12%', level: 'warning', alertId: alert.id, createdAt: NOW.toISOString() }])
  })

  it('works without a key: feed only, and the app is told push is off', async () => {
    const { ios, transport, store } = setup({ key: false })
    const ch = store.notifications.channels.create({ name: 'iPhone', kind: 'ios', enabled: true, config: {}, secrets: {} }, NOW.toISOString())
    expect(ios.register({ deviceId: 'phone-0001', name: 'iPhone', token: TOKEN_A, environment: 'production' }).apnsConfigured).toBe(false)
    expect((await ios.send(ch, req)).ok).toBe(true)
    expect(transport).not.toHaveBeenCalled()
    expect(ios.feed(0).items).toHaveLength(1)
    expect(await ios.test('phone-0001')).toEqual({ sent: false, via: 'feed' })
  })

  it('forgets a token Apple says is dead', async () => {
    const { ios, channel, store } = setup({ transport: async () => ({ status: 410, body: '{"reason":"Unregistered"}', headers: {} }) })
    ios.register({ deviceId: 'phone-0001', name: 'iPhone', token: TOKEN_A, environment: 'production' })
    const r = await ios.send(must(channel), req)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/feed/)
    expect(store.notifications.ios.devices.get('phone-0001')?.token).toBeNull()
  })

  it('trims the feed and tests one phone through APNs', async () => {
    const { ios, channel, transport } = setup()
    ios.register({ deviceId: 'phone-0001', name: 'iPhone', token: TOKEN_A, environment: 'sandbox' })
    for (let i = 0; i < FEED_KEEP + 5; i++) await ios.send(must(channel), req)
    expect(must(ios.feed(0, 100).items[0]).id).toBe(6)
    transport.mockClear()
    expect(await ios.test('phone-0001')).toEqual({ sent: true, via: 'apns' })
    expect(nthCall(transport, 0).origin).toBe('https://api.sandbox.push.apple.com')
  })
})

describe('IosService Live Activity', () => {
  const since = new Date(NOW.getTime() - 10_000).toISOString()
  const running = { on: true, level: 100, since, fault: null, remainingS: 110 }

  it('updates running activities, push-to-starts the rest after a pause, and ends them', async () => {
    vi.useFakeTimers()
    try {
      const { ios, transport, store } = setup()
      store.settings.update({ unitName: 'Kitchen', pumpSoftStart: true, pumpSoftStartMs: 1500 })
      ios.register({ deviceId: 'phone-0001', name: 'A', token: TOKEN_A, environment: 'production' })
      ios.register({ deviceId: 'phone-0002', name: 'B', token: TOKEN_B, environment: 'production' })
      ios.registerActivityToken({ deviceId: 'phone-0001', kind: 'update', activityId: 'act-1', token: 'c'.repeat(64), environment: 'production' })
      ios.registerActivityToken({ deviceId: 'phone-0001', kind: 'start', activityId: null, token: 'd'.repeat(64), environment: 'production' })
      ios.registerActivityToken({ deviceId: 'phone-0002', kind: 'start', activityId: null, token: 'e'.repeat(64), environment: 'production' })

      await ios.pumpChanged(running)
      expect(transport).toHaveBeenCalledTimes(1)
      const update = nthCall(transport, 0)
      expect(update.path).toBe(`/3/device/${'c'.repeat(64)}`)
      expect(update.headers['apns-topic']).toBe('com.thryve.app.push-type.liveactivity')
      expect(update.headers['apns-push-type']).toBe('liveactivity')
      const nowS = NOW.getTime() / 1000
      expect(JSON.parse(update.body).aps).toMatchObject({ 'event': 'update', 'content-state': { startedAt: nowS - 10, endsAt: nowS + 110, powerPct: 100, softStartS: 1.5, running: true, fault: null } })

      await vi.advanceTimersByTimeAsync(PUSH_TO_START_DELAY_MS + 10)
      // Phone A already has a running activity; only B is started by push.
      expect(transport).toHaveBeenCalledTimes(2)
      const start = nthCall(transport, 1)
      expect(start.path).toBe(`/3/device/${'e'.repeat(64)}`)
      expect(JSON.parse(start.body).aps).toMatchObject({ 'event': 'start', 'attributes-type': 'WateringAttributes', 'attributes': { unitName: 'Kitchen' } })

      // The same run again is not news.
      await ios.pumpChanged(running)
      expect(transport).toHaveBeenCalledTimes(2)

      await ios.pumpChanged({ ...running, on: false, level: 0, remainingS: null })
      const end = nthCall(transport, 2)
      expect(JSON.parse(end.body).aps).toMatchObject({ 'event': 'end', 'content-state': { running: false }, 'dismissal-date': nowS + 60 })
      expect(store.notifications.ios.activityTokens.list().map(t => t.kind)).toEqual(['start', 'start'])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does nothing over APNs without a key', async () => {
    const { ios, transport } = setup({ key: false })
    ios.register({ deviceId: 'phone-0001', name: 'A', token: TOKEN_A, environment: 'production' })
    ios.registerActivityToken({ deviceId: 'phone-0001', kind: 'update', activityId: 'act-1', token: 'c'.repeat(64), environment: 'production' })
    await ios.pumpChanged(running)
    await ios.pumpChanged({ ...running, on: false })
    expect(transport).not.toHaveBeenCalled()
  })

  it('ignores tokens from phones that never registered', () => {
    const { ios, store } = setup()
    ios.registerActivityToken({ deviceId: 'stranger-01', kind: 'start', activityId: null, token: 'c'.repeat(64), environment: 'production' })
    expect(store.notifications.ios.activityTokens.list()).toEqual([])
  })

  it('only a new end, power or fault counts as a change', () => {
    const a = { startedAt: 0, endsAt: 120, powerPct: 100, softStartS: 0, running: true, fault: null }
    expect(changed(a, { ...a, endsAt: 122 })).toBe(false)
    expect(changed(a, { ...a, endsAt: 180 })).toBe(true)
    expect(changed(a, { ...a, powerPct: 30 })).toBe(true)
    expect(changed(a, { ...a, fault: 'dry run' })).toBe(true)
  })
})
