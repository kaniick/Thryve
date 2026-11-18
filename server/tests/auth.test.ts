import { describe, expect, it } from 'vitest'
import { authorize, isLoopback, isMcpPath, requestPeer } from '../auth'

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

describe('isMcpPath', () => {
  it('matches /api/mcp and transport subpaths only', () => {
    expect(isMcpPath('/api/mcp')).toBe(true)
    expect(isMcpPath('/api/mcp/')).toBe(true)
    expect(isMcpPath('/api/mcp/sse')).toBe(true)
    expect(isMcpPath('/api/healthcheck')).toBe(false)
    expect(isMcpPath('/api/trpc/settings.get')).toBe(false)
    expect(isMcpPath('/api/ws')).toBe(false)
    expect(isMcpPath('/api/captures/x.jpg')).toBe(false)
  })
})

describe('authorize', () => {
  it('allows everyone when no key is set, and loopback even when one is', () => {
    expect(authorize('', '192.168.1.20', undefined)).toBe(true)
    expect(authorize('sekret', '127.0.0.1', undefined)).toBe(true)
    expect(authorize('sekret', '::ffff:127.0.0.1', undefined)).toBe(true)
  })

  it('rejects a missing peer or a LAN client without the exact key', () => {
    expect(authorize('sekret', null, undefined)).toBe(false)
    expect(authorize('sekret', '192.168.1.20', undefined)).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'wrong!')).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'sekret')).toBe(true)
  })
})

describe('requestPeer', () => {
  const req = (addr: string | undefined, xff?: string) => requestPeer({
    env: addr ? { incoming: { socket: { remoteAddress: addr } } } : {},
    req: { path: '/api/mcp', header: (name: string) => name === 'x-forwarded-for' ? xff : undefined },
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
