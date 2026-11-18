import { createHmac, randomBytes } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Store } from '../src/store/types'

/**
 * Optional API key (Phase 8.2, ADR-0012). LAN-only trust is the default:
 * with no key configured every request passes. When settings.apiKey is set,
 * non-loopback requests to /api/* must carry it as `X-API-Key` or
 * `Authorization: Bearer`, or a session cookie issued by the unit's web UI
 * after a login (or when the key is saved). Loopback (SSH, cron, scripts) is
 * exempt. X-Forwarded-For is only read when the socket peer is already
 * loopback (a local reverse proxy); a LAN client cannot spoof it.
 */

export const SESSION_COOKIE = 'thryve_session'
export const SESSION_MAX_AGE_S = 180 * 24 * 60 * 60

const PUBLIC_API = new Set(['/api/login', '/api/logout', '/api/auth/status'])

interface GuardRequest {
  env: unknown
  req: { path: string, header: (name: string) => string | undefined }
}

export function apiKeyGuard(store: Store): MiddlewareHandler {
  return async (c, next) => {
    const key = store.settings.get().apiKey
    if (!key) return next()
    if (PUBLIC_API.has(pathOf(c.req.path))) return next()
    const peer = requestPeer(c)
    const given = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const session = cookieValue(c.req.header('cookie'), SESSION_COOKIE)
    if (authorize(key, peer, given, session)) return next()
    return c.json({ error: 'unauthorized', code: 'api_key_required' }, 401)
  }
}

/** Socket peer, or the first X-Forwarded-For hop when the peer is loopback. Null if unknown. */
export function requestPeer(c: GuardRequest): string | null {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  if (!socket) return null
  if (!isLoopback(socket)) return socket
  const xff = c.req.header('x-forwarded-for')
  if (!xff) return socket
  const first = xff.split(',')[0]?.trim()
  return first || socket
}

/**
 * Pure decision: no key configured ⇒ allow; loopback ⇒ allow; otherwise the
 * presented key or a valid session token must match. A missing peer is not
 * loopback: fail closed when a key is set.
 */
export function authorize(configuredKey: string, remoteAddr: string | null, presented: string | undefined, sessionToken?: string | undefined): boolean {
  if (!configuredKey) return true
  if (remoteAddr && isLoopback(remoteAddr)) return true
  if (presented && timingSafeEqual(presented, configuredKey)) return true
  return verifySession(configuredKey, sessionToken)
}

export function isLoopback(addr: string): boolean {
  const a = addr.trim().toLowerCase()
  if (!a) return false
  if (a === '::1') return true
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4)
  return !!m && Number(m[1]) === 127
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function signSession(apiKey: string, now = Date.now(), maxAgeS = SESSION_MAX_AGE_S): string {
  const exp = Math.floor(now / 1000) + maxAgeS
  const nonce = randomBytes(16).toString('base64url')
  const payload = `${exp}.${nonce}`
  const mac = createHmac('sha256', apiKey).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

export function verifySession(apiKey: string, token: string | undefined, now = Date.now()): boolean {
  if (!apiKey || !token) return false
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return false
  const [exp, nonce, mac] = parts
  if (!/^\d+$/.test(exp)) return false
  if (Number(exp) * 1000 < now) return false
  const expected = createHmac('sha256', apiKey).update(`${exp}.${nonce}`).digest('base64url')
  return timingSafeEqual(mac, expected)
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    if (part.slice(0, i).trim() !== name) continue
    return part.slice(i + 1).trim()
  }
  return undefined
}

export function sessionSetCookie(apiKey: string, opts: { secure?: boolean, now?: number } = {}): string {
  const token = signSession(apiKey, opts.now)
  const secure = opts.secure ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; SameSite=Strict${secure}`
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`
}

export function requestIsHttps(c: { req: { url: string } }): boolean {
  try {
    return new URL(c.req.url).protocol === 'https:'
  }
  catch {
    return false
  }
}

function pathOf(path: string): string {
  const cut = path.split('?')[0] ?? path
  return cut.endsWith('/') && cut.length > 1 ? cut.slice(0, -1) : cut
}
