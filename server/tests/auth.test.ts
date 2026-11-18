import { describe, expect, it } from 'vitest'
import { authorize, cookieValue, isLoopback, requestPeer, sessionClearCookie, sessionSetCookie, SESSION_COOKIE, signSession, verifySession } from '../auth'

describe('isLoopback', () => {
  it('treats the 127.0.0.0/8 block and ::1 as loopback, and nothing else', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('127.0.0.2')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('')).toBe(false)
    expect(isLoopback('192.168.1.20')).toBe(false)
    expect(isLoopback('10.10.60.72')).toBe(false)
    expect(isLoopback('::ffff:192.168.1.20')).toBe(false)
  })
})

describe('authorize', () => {
  it('allows everyone when no key is set, and loopback even when one is', () => {
    expect(authorize('', '192.168.1.20', undefined)).toBe(true)
    expect(authorize('sekret', '127.0.0.1', undefined)).toBe(true)
    expect(authorize('sekret', '::ffff:127.0.0.1', undefined)).toBe(true)
  })

  it('rejects a missing peer or a LAN client without the key or a session', () => {
    expect(authorize('sekret', null, undefined)).toBe(false)
    expect(authorize('sekret', '192.168.1.20', undefined)).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'wrong!')).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'sekret')).toBe(true)
  })

  it('accepts a valid session cookie for a LAN client', () => {
    const token = signSession('sekret')
    expect(authorize('sekret', '192.168.1.20', undefined, token)).toBe(true)
    expect(authorize('sekret', '192.168.1.20', undefined, '0.x.y')).toBe(false)
    expect(authorize('other', '192.168.1.20', undefined, token)).toBe(false)
  })
})

describe('requestPeer', () => {
  const req = (addr: string | undefined, xff?: string) => requestPeer({
    env: addr ? { incoming: { socket: { remoteAddress: addr } } } : {},
    req: { path: '/api/healthcheck', header: (name: string) => name === 'x-forwarded-for' ? xff : undefined },
  })

  it('uses the socket peer and ignores X-Forwarded-For from a non-loopback client', () => {
    expect(req('192.168.1.20', '127.0.0.1')).toBe('192.168.1.20')
    expect(req('10.10.60.72', '::1')).toBe('10.10.60.72')
    expect(req(undefined, '127.0.0.1')).toBeNull()
  })

  it('reads X-Forwarded-For only when the socket peer is loopback (a local proxy)', () => {
    expect(req('127.0.0.1')).toBe('127.0.0.1')
    expect(req('127.0.0.1', '192.168.1.20')).toBe('192.168.1.20')
    expect(req('127.0.0.1', '192.168.1.20, 10.0.0.1')).toBe('192.168.1.20')
  })
})

describe('session tokens', () => {
  it('round-trips, expires, and does not leak a different key', () => {
    const token = signSession('sekret', 1_000_000, 60)
    expect(verifySession('sekret', token, 1_000_000)).toBe(true)
    expect(verifySession('sekret', token, 1_000_000 + 61_000)).toBe(false)
    expect(verifySession('nope', token, 1_000_000)).toBe(false)
    expect(sessionSetCookie('sekret')).toContain(`${SESSION_COOKIE}=`)
    expect(sessionSetCookie('sekret', { secure: true })).toContain('Secure')
    expect(sessionSetCookie('sekret')).toContain('HttpOnly')
    expect(sessionSetCookie('sekret')).toContain('SameSite=Strict')
    expect(sessionClearCookie()).toContain('Max-Age=0')
    expect(cookieValue(`${SESSION_COOKIE}=abc; other=1`, SESSION_COOKIE)).toBe('abc')
  })
})
