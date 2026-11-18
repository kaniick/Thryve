import type { MiddlewareHandler } from 'hono'
import type { Store } from '../src/store/types'

/**
 * Optional MCP access key (Phase 8.2, ADR-0012). LAN-only trust is the
 * default: the web UI, tRPC, the REST facade, WebSocket and stills have no
 * authentication. When settings.apiKey is set, non-loopback requests to
 * `/api/mcp` (and any path under it) must carry it as `X-API-Key` or
 * `Authorization: Bearer`. Loopback (SSH, cron, local scripts) is exempt.
 * X-Forwarded-For is only read when the socket peer is already loopback
 * (a local reverse proxy); a LAN client cannot spoof it.
 */

interface GuardRequest {
  env: unknown
  req: { path: string, header: (name: string) => string | undefined }
}

export function isMcpPath(path: string): boolean {
  const p = pathOf(path)
  return p === '/api/mcp' || p.startsWith('/api/mcp/')
}

export function apiKeyGuard(store: Store): MiddlewareHandler {
  return async (c, next) => {
    if (!isMcpPath(c.req.path)) return next()
    const key = store.settings.get().apiKey
    if (!key) return next()
    const peer = requestPeer(c)
    const given = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (authorize(key, peer, given)) return next()
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
 * presented key must match. A missing peer is not loopback: fail closed when
 * a key is set.
 */
export function authorize(configuredKey: string, remoteAddr: string | null, presented: string | undefined): boolean {
  if (!configuredKey) return true
  if (remoteAddr && isLoopback(remoteAddr)) return true
  return !!presented && timingSafeEqual(presented, configuredKey)
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

function pathOf(path: string): string {
  const cut = path.split('?')[0] ?? path
  return cut.endsWith('/') && cut.length > 1 ? cut.slice(0, -1) : cut
}
