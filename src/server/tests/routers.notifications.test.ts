import { describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function unit() {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 1, request: 'r' }), { status: 200 }))
  const hal = new SimHal({ tickMs: 0 })
  const store = new MemoryStore()
  const core = createCore({ hal, store, version: 'test', now: () => new Date('2026-11-16T12:00:00Z') })
  // Swap the engine's fetch by sending through a channel test after we stub global fetch.
  const orig = globalThis.fetch
  globalThis.fetch = fetchImpl as unknown as typeof fetch
  const c = createCallerFactory(appRouter)(core.ctx)
  return {
    c, store, core, fetchImpl,
    restore: () => {
      globalThis.fetch = orig
    },
  }
}

describe('notifications router', () => {
  it('stores secrets write-only and returns them masked', async () => {
    const { c, store, restore } = unit()
    try {
      const created = await c.notifications.createChannel({
        name: 'Phone',
        kind: 'pushover',
        config: { sound: 'siren' },
        secrets: { userKey: 'userkeyABCDEFGH', appToken: 'apptokenXYZ1234' },
      })
      expect(created.secrets).toMatchObject({ hasUserKey: true, hasAppToken: true, userKey: '••••EFGH', appToken: '••••1234' })
      expect(JSON.stringify(created)).not.toContain('userkeyABCDEFGH')
      expect(store.notifications.channels.get(created.id)?.secrets).toEqual({ userKey: 'userkeyABCDEFGH', appToken: 'apptokenXYZ1234' })

      const listed = await c.notifications.channels()
      expect(listed[0]?.secrets.userKey).toBe('••••EFGH')
      expect(JSON.stringify(listed)).not.toContain('apptokenXYZ1234')

      await c.notifications.updateChannel({ id: created.id, name: 'Phone' })
      expect(store.notifications.channels.get(created.id)?.secrets).toEqual({ userKey: 'userkeyABCDEFGH', appToken: 'apptokenXYZ1234' })

      await c.notifications.updateChannel({ id: created.id, secrets: { userKey: '' } })
      expect(store.notifications.channels.get(created.id)?.secrets).toEqual({ userKey: undefined, appToken: 'apptokenXYZ1234' })
    }
    finally { restore() }
  })

  it('creates a disabled starter-style rule, lists history, and respects the kill switch', async () => {
    const { c, store, restore } = unit()
    try {
      await c.notifications.createChannel({ name: 'Phone', kind: 'pushover', secrets: { userKey: 'u', appToken: 't' } })
      const r = await c.notifications.createRule({
        name: 'Tank low',
        trigger: { kind: 'threshold', signal: 'sensor.water_level_pct', op: '<', value: 25 },
        conditions: { kind: 'and', conditions: [] },
        channelIds: [],
        titleTemplate: 'Thryve: tank low',
        messageTemplate: 'Tank is at {{sensor.water_level_pct}}%.',
        priority: 'high',
      })
      expect(r).toMatchObject({ enabled: false, cooldownMin: 60, priority: 'high' })
      const starters = await c.notifications.starters()
      expect(starters.some(s => s.name === 'Pump fault' && !s.alreadyAdded)).toBe(true)
      expect((await c.notifications.status()).enabled).toBe(true)
      await c.notifications.setGlobal({ enabled: false })
      expect(store.settings.get().notificationsEnabled).toBe(false)
      expect(await c.notifications.removeRule({ id: 99 })).toEqual({ removed: false })
      await expect(c.notifications.getRule({ id: 99 })).rejects.toThrow(/no notification rule 99/)
    }
    finally { restore() }
  })

  it('sends a test on a channel through the mocked provider', async () => {
    const { c, fetchImpl, restore } = unit()
    try {
      const ch = await c.notifications.createChannel({ name: 'Phone', kind: 'pushover', secrets: { userKey: 'user-secret-aaaa', appToken: 'app-secret-bbbb' } })
      const r = await c.notifications.testChannel({ id: ch.id })
      expect(r.ok).toBe(true)
      const call = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit?]>)[0]
      expect(call?.[0]).toBe('https://api.pushover.net/1/messages.json')
      const listed = await c.notifications.channels()
      expect(JSON.stringify(listed)).not.toContain('user-secret-aaaa')
    }
    finally { restore() }
  })
})

describe('notifications router: the iPhone app', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----'

  it('registers phones, keeps the APNs key write-only, and serves the feed', async () => {
    const { c, store, restore } = unit()
    try {
      expect(await c.notifications.devices.register({ deviceId: 'phone-0001', name: 'iPhone', platform: 'ios', environment: 'production', bundleId: 'com.thryve.app' }))
        .toEqual({ apnsConfigured: false })
      await expect(c.notifications.devices.register({ deviceId: 'phone-0001', name: 'iPhone', token: 'not-hex', environment: 'production' })).rejects.toThrow()
      await c.notifications.devices.register({ deviceId: 'phone-0001', name: 'iPhone', token: 'AB'.repeat(32), environment: 'production' })
      expect(store.notifications.ios.devices.get('phone-0001')?.token).toBe('ab'.repeat(32))
      expect(await c.notifications.devices.list()).toMatchObject([{ deviceId: 'phone-0001', hasToken: true }])
      expect(JSON.stringify(await c.notifications.devices.list())).not.toContain('abab')

      const ch = await c.notifications.createChannel({ name: 'iPhone', kind: 'ios', config: { keyId: 'KEY1234567', teamId: 'TEAM123456' }, secrets: { apnsKey: key } })
      expect(ch.secrets).toMatchObject({ hasApnsKey: true, apnsKey: '••••' })
      expect(JSON.stringify(ch)).not.toContain('MIGT')
      expect(ch.config).toEqual({ keyId: 'KEY1234567', teamId: 'TEAM123456' })
      await expect(c.notifications.createChannel({ name: 'Bad', kind: 'ios', secrets: { apnsKey: 'hello' } })).rejects.toThrow(/BEGIN and END/)

      // This host has no APNs client, so a send lands in the feed only.
      const sent = await c.notifications.testChannel({ id: ch.id })
      expect(sent.ok).toBe(true)
      expect(await c.notifications.feed({})).toEqual({ items: [], latestId: 1 })
      const feed = await c.notifications.feed({ afterId: 0 })
      expect(feed.items[0]).toMatchObject({ id: 1, title: 'Thryve: test (iPhone)', level: 'info', alertId: null })

      expect(await c.notifications.devices.test({ deviceId: 'phone-0001' })).toEqual({ sent: false, via: 'feed' })
      expect(await c.notifications.activities.register({ deviceId: 'phone-0001', kind: 'start', token: 'cd'.repeat(40), environment: 'production' })).toEqual({ ok: true })
      await expect(c.notifications.activities.register({ deviceId: 'phone-0001', kind: 'update', token: 'cd'.repeat(40), environment: 'production' })).rejects.toThrow(/activityId/)
      expect(store.notifications.ios.activityTokens.list()).toHaveLength(1)

      expect(await c.notifications.devices.unregister({ deviceId: 'phone-0001' })).toEqual({ ok: true })
      expect(store.notifications.ios.activityTokens.list()).toHaveLength(0)
    }
    finally {
      restore()
    }
  })
})
