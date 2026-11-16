
import type { AppriseConfig, AppriseSecrets, NotificationChannel } from '../types'
import { httpError, type HttpFetch, type SendRequest, type SendResult } from './http'

const TYPE: Record<SendRequest['priority'], 'info' | 'success' | 'warning' | 'failure'> = {
  lowest: 'info',
  low: 'info',
  normal: 'info',
  high: 'warning',
  emergency: 'failure',
}

export function appriseNotifyUrl(serverUrl: string, configKey?: string): string {
  const base = serverUrl.replace(/\/+$/, '')
  return configKey ? `${base}/notify/${encodeURIComponent(configKey)}` : `${base}/notify/`
}

export async function sendApprise(channel: NotificationChannel, req: SendRequest, fetchImpl: HttpFetch): Promise<SendResult> {
  const cfg = channel.config as AppriseConfig
  const secrets = channel.secrets as AppriseSecrets
  if (!cfg.serverUrl) return { ok: false, error: 'Apprise API server URL is required' }
  if (!cfg.configKey && !(secrets.urls && secrets.urls.length > 0)) {
    return { ok: false, error: 'Set an Apprise config key or at least one notification URL' }
  }
  const payload: Record<string, unknown> = {
    title: req.title,
    body: req.message,
    type: TYPE[req.priority],
  }
  if (cfg.tag) payload.tag = cfg.tag
  if (secrets.urls?.length) payload.urls = secrets.urls.join(',')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secrets.apiKey) headers['X-Api-Key'] = secrets.apiKey
  try {
    const res = await fetchImpl(appriseNotifyUrl(cfg.serverUrl, cfg.configKey), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: httpError(res.status, text) }
    return { ok: true }
  }
  catch (e) {
    return { ok: false, error: (e as Error).message || 'Apprise request failed' }
  }
}
