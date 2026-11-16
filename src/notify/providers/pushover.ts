
import { PUSHOVER_PRIORITY } from '../types'
import type { NotificationChannel, PushoverConfig, PushoverSecrets } from '../types'
import { httpError, type HttpFetch, type SendRequest, type SendResult } from './http'

const ENDPOINT = 'https://api.pushover.net/1/messages.json'

export async function sendPushover(channel: NotificationChannel, req: SendRequest, fetchImpl: HttpFetch): Promise<SendResult> {
  const secrets = channel.secrets as PushoverSecrets
  const cfg = channel.config as PushoverConfig
  if (!secrets.userKey || !secrets.appToken) return { ok: false, error: 'Pushover user key and app token are required' }
  const priority = PUSHOVER_PRIORITY[req.priority]
  const body = new URLSearchParams()
  body.set('token', secrets.appToken)
  body.set('user', secrets.userKey)
  body.set('title', req.title)
  body.set('message', req.message)
  body.set('priority', String(priority))
  if (cfg.device) body.set('device', cfg.device)
  if (cfg.sound) body.set('sound', cfg.sound)
  if (priority === 2) {
    body.set('retry', String(cfg.retry ?? 60))
    body.set('expire', String(cfg.expire ?? 600))
  }
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: httpError(res.status, text) }
    let id: string | undefined
    try {
      id = (JSON.parse(text) as { request?: string }).request
    }
    catch { /* ignore */ }
    return { ok: true, id }
  }
  catch (e) {
    return { ok: false, error: (e as Error).message || 'Pushover request failed' }
  }
}
