/**
 * Apple Push Notification service, straight from the unit (no relay): HTTP/2 to
 * api.push.apple.com with token-based auth (an ES256 JWT signed by the owner's
 * .p8 key). Sends alert pushes to the Thryve iPhone app and `liveactivity`
 * pushes to its watering Live Activity.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import type { ApnsEnvironment, ApnsKey, ApnsRequest, ApnsResult, ApnsSender } from '../ios/types'

export type { ApnsEnvironment, ApnsKey, ApnsRequest, ApnsResult } from '../ios/types'
export { isDeadToken } from '../ios/types'

/** One HTTP/2 POST; swapped out in tests. */
export type ApnsTransport = (req: { origin: string, path: string, headers: Record<string, string>, body: string }) => Promise<{ status: number, body: string, headers: Record<string, string | undefined> }>

export const APNS_ORIGIN: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64url')
}

/** Throws with a readable message when the key isn't an EC P-256 private key. */
export function parseP8(p8: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey({ key: p8.trim(), format: 'pem' })
  }
  catch {
    throw new Error('That isn\'t a .p8 key. Paste the whole AuthKey file, including the BEGIN and END lines.')
  }
  if (key.asymmetricKeyType !== 'ec') throw new Error('An APNs key is an EC (P-256) key; this one isn\'t.')
  return key
}

/** The provider token APNs wants: `{alg: ES256, kid}` `{iss: team, iat}`, signed with the .p8. */
export function providerToken(key: ApnsKey, nowS: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: key.keyId }))
  const claims = b64url(JSON.stringify({ iss: key.teamId, iat: nowS }))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: parseP8(key.p8), dsaEncoding: 'ieee-p1363' })
  return `${header}.${claims}.${b64url(signature)}`
}

export class ApnsClient implements ApnsSender {
  private jwt: { token: string, iat: number, keyId: string, teamId: string } | null = null

  constructor(
    private readonly transport: ApnsTransport = http2Transport(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Apple wants the token refreshed between 20 and 60 minutes; reuse it for 40. */
  private authorization(key: ApnsKey): string {
    const nowS = Math.floor(this.now() / 1000)
    if (!this.jwt || this.jwt.keyId !== key.keyId || this.jwt.teamId !== key.teamId || nowS - this.jwt.iat > 40 * 60) {
      this.jwt = { token: providerToken(key, nowS), iat: nowS, keyId: key.keyId, teamId: key.teamId }
    }
    return `bearer ${this.jwt.token}`
  }

  async send(key: ApnsKey, req: ApnsRequest): Promise<ApnsResult> {
    let authorization: string
    try {
      authorization = this.authorization(key)
    }
    catch (err) {
      return { ok: false, status: 0, reason: err instanceof Error ? err.message : String(err) }
    }
    const headers: Record<string, string> = {
      'authorization': authorization,
      'apns-topic': req.topic,
      'apns-push-type': req.pushType,
      'apns-priority': String(req.priority ?? 10),
      'content-type': 'application/json',
    }
    if (req.collapseId) headers['apns-collapse-id'] = req.collapseId.slice(0, 64)
    if (req.expiration !== undefined) headers['apns-expiration'] = String(req.expiration)
    let res
    try {
      res = await this.transport({ origin: APNS_ORIGIN[req.environment], path: `/3/device/${req.token}`, headers, body: JSON.stringify(req.payload) })
    }
    catch (err) {
      return { ok: false, status: 0, reason: err instanceof Error ? err.message : String(err) }
    }
    if (res.status === 403) this.jwt = null
    let reason: string | undefined
    if (res.status !== 200) {
      try {
        reason = (JSON.parse(res.body) as { reason?: string }).reason
      }
      catch {
        reason = undefined
      }
    }
    return { ok: res.status === 200, status: res.status, reason, apnsId: res.headers['apns-id'] }
  }
}

/** node:http2, one session per origin, reopened when Apple or the network closes it. */
export function http2Transport(timeoutMs = 10_000): ApnsTransport & { close(): void } {
  const sessions = new Map<string, ClientHttp2Session>()
  const session = (origin: string) => {
    const open = sessions.get(origin)
    if (open && !open.closed && !open.destroyed) return open
    const s = connect(origin)
    s.on('error', () => sessions.delete(origin))
    s.on('close', () => sessions.delete(origin))
    // Don't hold core's event loop open for an idle push connection.
    s.unref()
    sessions.set(origin, s)
    return s
  }
  const send: ApnsTransport = ({ origin, path, headers, body }) => new Promise((resolve, reject) => {
    const s = session(origin)
    const stream = s.request({ [constants.HTTP2_HEADER_METHOD]: 'POST', [constants.HTTP2_HEADER_PATH]: path, ...headers })
    let settled = false
    const timer = setTimeout(() => stream.close(constants.NGHTTP2_CANCEL), timeoutMs)
    const fail = (err: Error) => {
      clearTimeout(timer)
      if (!settled) reject(err)
      settled = true
    }
    let status = 0
    let out: Record<string, string | undefined> = {}
    const chunks: Buffer[] = []
    stream.on('response', (h) => {
      status = Number(h[constants.HTTP2_HEADER_STATUS])
      out = { 'apns-id': typeof h['apns-id'] === 'string' ? h['apns-id'] : undefined }
    })
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => {
      clearTimeout(timer)
      if (!settled) resolve({ status, body: Buffer.concat(chunks).toString('utf8'), headers: out })
      settled = true
    })
    stream.on('error', fail)
    stream.on('close', () => fail(new Error('APNs did not answer')))
    stream.end(body)
  })
  /** Close the pooled connections (shutdown, tests). */
  const close = () => {
    for (const s of sessions.values()) s.close()
    sessions.clear()
  }
  return Object.assign(send, { close })
}
