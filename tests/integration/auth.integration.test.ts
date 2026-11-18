import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app'
import { authorize, isLoopback } from '../../server/auth'
import { SimHal } from '../../src/hardware/sim'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'

let base = ''
let close: () => void = () => undefined
const store = new MemoryStore()

const mcpInit = {
  method: 'POST' as const,
  headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
}

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
    expect((await fetch(`${base}/api/mcp`, mcpInit)).status).toBe(200)
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

describe('MCP access key from the LAN', () => {
  const appOf = () => {
    const { app } = createApp({ ctx: createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test' }).ctx })
    return app
  }

  it('leaves the web UI and the rest of /api/* open on the LAN when a key is set', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    expect((await app.request('/api/healthcheck', {}, lan)).status).toBe(200)
    expect((await app.request('/api/settings', {}, lan)).status).toBe(200)
    expect((await app.request('/api/ws', {}, lan)).status).not.toBe(401)
  })

  it('rejects a LAN MCP client without the key, even if it spoofs X-Forwarded-For as loopback', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    const denied = await app.request('/api/mcp', mcpInit, lan)
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ code: 'api_key_required' })
    const spoof = await app.request('/api/mcp', { ...mcpInit, headers: { ...mcpInit.headers, 'x-forwarded-for': '127.0.0.1' } }, lan)
    expect(spoof.status).toBe(401)
  })

  it('lets a LAN MCP client through with X-API-Key or Bearer', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    const keyed = await app.request('/api/mcp', { ...mcpInit, headers: { ...mcpInit.headers, 'x-api-key': 'sekret' } }, lan)
    expect(keyed.status).toBe(200)
    expect((await keyed.json()).result.serverInfo.name).toBe('Thryve')
    const bearer = await app.request('/api/mcp', { ...mcpInit, headers: { ...mcpInit.headers, authorization: 'Bearer sekret' } }, lan)
    expect(bearer.status).toBe(200)
  })

  it('does not trust an empty or missing peer as loopback on /api/mcp', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    expect((await app.request('/api/mcp', mcpInit)).status).toBe(401)
    expect((await app.request('/api/healthcheck')).status).toBe(200)
  })

  it('treats X-Forwarded-For as the client when the socket peer is loopback (a local proxy)', async () => {
    store.settings.update({ apiKey: 'sekret' })
    const app = appOf()
    const proxied = await app.request('/api/mcp', { ...mcpInit, headers: { ...mcpInit.headers, 'x-forwarded-for': '192.168.1.20' } }, loop)
    expect(proxied.status).toBe(401)
    expect((await app.request('/api/mcp', mcpInit, loop)).status).toBe(200)
  })
})

describe('clearing the MCP access key from loopback', () => {
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
