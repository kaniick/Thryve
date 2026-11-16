import { describe, expect, it, vi } from 'vitest'
import { sendApprise, appriseNotifyUrl } from '../providers/apprise'
import { sendPushbullet } from '../providers/pushbullet'
import { sendPushover } from '../providers/pushover'
import type { NotificationChannel } from '../types'

const base = { id: 1, name: 'Phone', enabled: true, createdAt: '', updatedAt: '' }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('notification providers', () => {
  it('posts to Pushover with user, token, priority and emergency retry', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.pushover.net/1/messages.json')
      const body = new URLSearchParams(init?.body as string)
      expect(body.get('token')).toBe('app-token-secret')
      expect(body.get('user')).toBe('user-key-secret')
      expect(body.get('title')).toBe('Hello')
      expect(body.get('priority')).toBe('2')
      expect(body.get('retry')).toBe('60')
      expect(body.get('expire')).toBe('600')
      expect(body.get('sound')).toBe('siren')
      return json(200, { status: 1, request: 'abc' })
    })
    const ch: NotificationChannel = { ...base, kind: 'pushover', config: { sound: 'siren' }, secrets: { userKey: 'user-key-secret', appToken: 'app-token-secret' } }
    const r = await sendPushover(ch, { title: 'Hello', message: 'Tank low', priority: 'emergency' }, fetchImpl)
    expect(r).toEqual({ ok: true, id: 'abc' })
  })

  it('posts to Pushbullet with the access token header and never requires leaking it in the error', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['Access-Token']).toBe('pushbullet-token-secret-value')
      const body = JSON.parse(String(init?.body)) as { title: string, type: string }
      expect(body).toMatchObject({ type: 'note', title: 'Hi' })
      return json(401, { error: { message: 'invalid token pushbullet-token-secret-value' } })
    })
    const ch: NotificationChannel = { ...base, kind: 'pushbullet', config: {}, secrets: { accessToken: 'pushbullet-token-secret-value' } }
    const r = await sendPushbullet(ch, { title: 'Hi', message: 'Body', priority: 'normal' }, fetchImpl)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 401')
    expect(r.error).not.toContain('pushbullet-token-secret-value')
  })

  it('posts to an external Apprise API, not a local Python install', async () => {
    expect(appriseNotifyUrl('http://apprise.local:8000/', 'home')).toBe('http://apprise.local:8000/notify/home')
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://apprise.local:8000/notify/')
      const headers = init?.headers as Record<string, string>
      expect(headers['X-Api-Key']).toBe('apprise-api-key')
      const body = JSON.parse(String(init?.body)) as { urls: string, type: string }
      expect(body.urls).toBe('pushover://token@user')
      expect(body.type).toBe('warning')
      return new Response('OK', { status: 200 })
    })
    const ch: NotificationChannel = { ...base, kind: 'apprise', config: { serverUrl: 'http://apprise.local:8000' }, secrets: { apiKey: 'apprise-api-key', urls: ['pushover://token@user'] } }
    const r = await sendApprise(ch, { title: 'Hi', message: 'Body', priority: 'high' }, fetchImpl)
    expect(r).toEqual({ ok: true })
  })

  it('refuses to send when required secrets are missing', async () => {
    const fetchImpl = vi.fn()
    expect((await sendPushover({ ...base, kind: 'pushover', config: {}, secrets: {} }, { title: 't', message: 'm', priority: 'normal' }, fetchImpl)).ok).toBe(false)
    expect((await sendPushbullet({ ...base, kind: 'pushbullet', config: {}, secrets: {} }, { title: 't', message: 'm', priority: 'normal' }, fetchImpl)).ok).toBe(false)
    expect((await sendApprise({ ...base, kind: 'apprise', config: { serverUrl: '' }, secrets: {} }, { title: 't', message: 'm', priority: 'normal' }, fetchImpl)).ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
