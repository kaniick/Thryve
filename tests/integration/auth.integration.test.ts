import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app'
import { authorize, cookieValue, isLoopback, SESSION_COOKIE } from '../../server/auth'
import { SimHal } from '../../src/hardware/sim'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'

let base = ''
let close: () => void = () => undefined
const store = new MemoryStore()

beforeAll(async () => {
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test' })
  const { app } = createApp({ ctx: core.ctx })
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>(r => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})
afterAll(() => close())

describe('API key guard', () => {
  it('loopback is always exempt; classification helper', async () => {
    store.settings.update({ apiKey: 'sekret' })
    expect((await fetch(`${base}/api/healthcheck`)).status).toBe(200)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('192.168.1.20')).toBe(false)
  })

  it('non-loopback requests need the exact key when one is configured', () => {
    expect(authorize('', '192.168.1.20', undefined)).toBe(true)
    expect(authorize('sekret', '192.168.1.20', undefined)).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'wrong!')).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'sekret')).toBe(true)
    expect(authorize('sekret', '127.0.0.1', undefined)).toBe(true)
  })
})

const lan = { incoming: { socket: { remoteAddress: '192.168.1.20' } } }
const loop = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

describe('API key guard from the LAN', () => {
  const appOf = () => {
    const { app } = createApp({ ctx: createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test' }).ctx })
    return app
  }

  it('rejects a LAN client without the key, even if it spoofs X-Forwarded-For as loopback', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    const denied = await app.request('/api/healthcheck', {}, lan)
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ code: 'api_key_required' })
    const spoof = await app.request('/api/healthcheck', { headers: { 'x-forwarded-for': '127.0.0.1' } }, lan)
    expect(spoof.status).toBe(401)
  })

  it('lets a LAN client through with X-API-Key, Bearer, or a session cookie from login', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    expect((await app.request('/api/healthcheck', { headers: { 'x-api-key': 'sekret' } }, lan)).status).toBe(200)
    expect((await app.request('/api/healthcheck', { headers: { authorization: 'Bearer sekret' } }, lan)).status).toBe(200)
    const login = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'sekret' }) }, lan)
    expect(login.status).toBe(200)
    const raw = login.headers.get('set-cookie') ?? ''
    expect(raw).toContain(SESSION_COOKIE)
    expect(raw).toContain('HttpOnly')
    const token = cookieValue(raw.split(';')[0], SESSION_COOKIE)
    const authed = await app.request('/api/healthcheck', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }, lan)
    expect(authed.status).toBe(200)
  })

  it('sets a session cookie when the key is saved over REST, so the current browser is not locked out', async () => {
    store.settings.update({ apiKey: '' })
    const app = appOf()
    const saved = await app.request('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'new-key' }) }, lan)
    expect(saved.status).toBe(200)
    expect((await saved.json()).hasApiKey).toBe(true)
    const token = cookieValue((saved.headers.get('set-cookie') ?? '').split(';')[0], SESSION_COOKIE)
    expect(token).toBeTruthy()
    expect((await app.request('/api/healthcheck', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }, lan)).status).toBe(200)
  })

  it('does not trust an empty or missing peer as loopback', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    expect((await app.request('/api/healthcheck')).status).toBe(401)
  })

  it('treats X-Forwarded-For as the client when the socket peer is loopback (a local proxy)', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    const proxied = await app.request('/api/healthcheck', { headers: { 'x-forwarded-for': '192.168.1.20' } }, loop)
    expect(proxied.status).toBe(401)
    expect((await app.request('/api/healthcheck', {}, loop)).status).toBe(200)
  })
})

describe('clearing the API key from loopback', () => {
  it('rejects curl -d without a JSON content-type, and clears the key with Content-Type: application/json', async () => {
    store.settings.update({ apiKey: 'sekret-lockout' })
    const form = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '{"apiKey":""}' })
    expect(form.status).toBe(415)
    expect(store.settings.get().apiKey).toBe('sekret-lockout')
    const ok = await fetch(`${base}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: '' }) })
    expect(ok.status).toBe(200)
    expect((await ok.json()).hasApiKey).toBe(false)
    expect(store.settings.get().apiKey).toBe('')
  })
})
