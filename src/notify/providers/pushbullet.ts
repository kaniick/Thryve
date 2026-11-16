
import type { NotificationChannel, PushbulletConfig, PushbulletSecrets } from '../types'
import { httpError, type HttpFetch, type SendRequest, type SendResult } from './http'

const ENDPOINT = 'https://api.pushbullet.com/v2/pushes'

export async function sendPushbullet(channel: NotificationChannel, req: SendRequest, fetchImpl: HttpFetch): Promise<SendResult> {
  const secrets = channel.secrets as PushbulletSecrets
  const cfg = channel.config as PushbulletConfig
  if (!secrets.accessToken) return { ok: false, error: 'Pushbullet access token is required' }
  const payload: Record<string, string> = { type: 'note', title: req.title, body: req.message }
  if (cfg.deviceIden) payload.device_iden = cfg.deviceIden
  if (cfg.channelTag) payload.channel_tag = cfg.channelTag
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Access-Token': secrets.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: httpError(res.status, text) }
    let id: string | undefined
    try {
      id = (JSON.parse(text) as { iden?: string }).iden
    }
    catch { /* ignore */ }
    return { ok: true, id }
  }
  catch (e) {
    return { ok: false, error: (e as Error).message || 'Pushbullet request failed' }
  }
}
