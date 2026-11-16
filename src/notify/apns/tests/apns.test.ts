import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ApnsClient, isDeadToken, parseP8, providerToken, type ApnsTransport } from '../client'
import { alertPayload, liveActivityPayload, liveActivityTopic } from '../../ios/payloads'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const p8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const key = { p8, keyId: 'ABC123DEFG', teamId: 'TEAM123456' }

function okTransport(status = 200, body = '') {
  return vi.fn<ApnsTransport>(async () => ({ status, body, headers: { 'apns-id': 'id-1' } }))
}

describe('provider token', () => {
  it('is an ES256 JWT Apple can verify with the key', () => {
    const jwt = providerToken(key, 1_800_000_000)
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' })
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ iss: 'TEAM123456', iat: 1_800_000_000 })
    const sig = Buffer.from(s, 'base64url')
    expect(sig).toHaveLength(64)
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true)
  })

  it('rejects what isn\'t a .p8 key', () => {
    expect(() => parseP8('hello')).toThrow(/isn't a .p8 key/)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(() => parseP8(rsa)).toThrow(/EC/)
  })
})

describe('ApnsClient', () => {
  it('posts to the right host, path and headers', async () => {
    const transport = okTransport()
    const client = new ApnsClient(transport, () => 1_800_000_000_000)
    const r = await client.send(key, { token: 'abcd', environment: 'sandbox', topic: 'com.thryve.app', pushType: 'alert', payload: { aps: {} }, collapseId: 'thryve-7' })
    expect(r).toEqual({ ok: true, status: 200, reason: undefined, apnsId: 'id-1' })
    const req = transport.mock.calls[0][0]
    expect(req.origin).toBe('https://api.sandbox.push.apple.com')
    expect(req.path).toBe('/3/device/abcd')
    expect(req.headers['apns-topic']).toBe('com.thryve.app')
    expect(req.headers['apns-push-type']).toBe('alert')
    expect(req.headers['apns-priority']).toBe('10')
    expect(req.headers['apns-collapse-id']).toBe('thryve-7')
    expect(req.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('reuses the provider token for 40 minutes, then makes a new one', async () => {
    const transport = okTransport()
    let now = 1_800_000_000_000
    const client = new ApnsClient(transport, () => now)
    const send = () => client.send(key, { token: 't', environment: 'production', topic: 'x', pushType: 'alert', payload: {} })
    await send()
    now += 10 * 60_000
    await send()
    now += 31 * 60_000
    await send()
    const auth = transport.mock.calls.map(c => c[0].headers.authorization)
    expect(auth[0]).toBe(auth[1])
    expect(auth[2]).not.toBe(auth[1])
    expect(transport.mock.calls[0][0].origin).toBe('https://api.push.apple.com')
  })

  it('reports Apple\'s reason and spots dead tokens', async () => {
    const client = new ApnsClient(okTransport(410, '{"reason":"Unregistered"}'))
    const r = await client.send(key, { token: 't', environment: 'production', topic: 'x', pushType: 'alert', payload: {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('Unregistered')
    expect(isDeadToken(r)).toBe(true)
    expect(isDeadToken({ ok: false, status: 400, reason: 'BadDeviceToken' })).toBe(true)
    expect(isDeadToken({ ok: false, status: 429, reason: 'TooManyRequests' })).toBe(false)
  })

  it('reports a bad key and a network error instead of throwing', async () => {
    const transport = okTransport()
    const r = await new ApnsClient(transport).send({ ...key, p8: 'nope' }, { token: 't', environment: 'production', topic: 'x', pushType: 'alert', payload: {} })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/isn't a .p8 key/)
    expect(transport).not.toHaveBeenCalled()
    const broken = new ApnsClient(async () => {
      throw new Error('ENOTFOUND api.push.apple.com')
    })
    expect((await broken.send(key, { token: 't', environment: 'production', topic: 'x', pushType: 'alert', payload: {} })).reason).toMatch(/ENOTFOUND/)
  })
})

describe('payloads', () => {
  it('alert pushes match the app\'s categories', () => {
    expect(alertPayload({ id: 7, title: 'Tank low', body: '12%', level: 'warning', alertId: 3, createdAt: '' })).toEqual({
      aps: { 'alert': { title: 'Tank low', body: '12%' }, 'sound': 'default', 'thread-id': 'thryve', 'category': 'THRYVE_ALERT' },
      feedId: 7,
      alertId: 3,
    })
    expect((alertPayload({ id: 8, title: 'Ready', body: '', level: 'info', alertId: null, createdAt: '' }).aps as { category: string }).category).toBe('THRYVE_EVENT')
  })

  it('live activity pushes', () => {
    const state = { startedAt: 100, endsAt: 220, powerPct: 100, softStartS: 1.5, running: true, fault: null }
    const start = liveActivityPayload('start', state, { nowS: 100, unitName: 'Kitchen' }).aps as Record<string, unknown>
    expect(start['attributes-type']).toBe('WateringAttributes')
    expect(start.attributes).toEqual({ unitName: 'Kitchen' })
    expect(start['content-state']).toEqual(state)
    expect(start['stale-date']).toBe(280)
    expect(start.alert).toBeDefined()
    const end = liveActivityPayload('end', { ...state, running: false }, { nowS: 150, unitName: 'Kitchen' }).aps as Record<string, unknown>
    expect(end['dismissal-date']).toBe(210)
    expect(end['attributes-type']).toBeUndefined()
    expect(liveActivityTopic('com.thryve.app')).toBe('com.thryve.app.push-type.liveactivity')
  })
})

describe('http2Transport', () => {
  it('speaks HTTP/2 to an APNs-like server', async () => {
    const { createServer } = await import('node:http2')
    const { http2Transport } = await import('../client')
    const seen: Array<Record<string, unknown>> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => body += c.toString())
      req.on('end', () => {
        seen.push({ path: req.headers[':path'], method: req.headers[':method'], topic: req.headers['apns-topic'], body })
        res.writeHead(req.headers['apns-topic'] === 'bad' ? 400 : 200, { 'apns-id': 'abc' })
        res.end(req.headers['apns-topic'] === 'bad' ? '{"reason":"BadDeviceToken"}' : '')
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as { port: number }
    const transport = http2Transport(2000)
    const origin = `http://127.0.0.1:${port}`
    const ok = await transport({ origin, path: '/3/device/aa', headers: { 'apns-topic': 'com.thryve.app' }, body: '{"aps":{}}' })
    expect(ok).toEqual({ status: 200, body: '', headers: { 'apns-id': 'abc' } })
    const bad = await transport({ origin, path: '/3/device/bb', headers: { 'apns-topic': 'bad' }, body: '{}' })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body)).toEqual({ reason: 'BadDeviceToken' })
    expect(seen[0]).toEqual({ path: '/3/device/aa', method: 'POST', topic: 'com.thryve.app', body: '{"aps":{}}' })
    // Node 22's server.close waits for open sessions, so drop the client's pooled one first.
    transport.close()
    await new Promise(r => server.close(r))
  })
})
