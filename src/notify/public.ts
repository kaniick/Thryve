
import { hasSecret, maskSecret } from './mask'
import type { AppriseSecrets, NotificationChannel, NotificationRule, PushoverSecrets, PushbulletSecrets } from './types'

export function publicSecrets(ch: NotificationChannel) {
  if (ch.kind === 'pushover') {
    const s = ch.secrets as PushoverSecrets
    return blank({ userKey: maskSecret(s.userKey), hasUserKey: hasSecret(s.userKey), appToken: maskSecret(s.appToken), hasAppToken: hasSecret(s.appToken) })
  }
  if (ch.kind === 'pushbullet') {
    const s = ch.secrets as PushbulletSecrets
    return blank({ accessToken: maskSecret(s.accessToken), hasAccessToken: hasSecret(s.accessToken) })
  }
  if (ch.kind === 'apprise') {
    const s = ch.secrets as AppriseSecrets
    return blank({ apiKey: maskSecret(s.apiKey), hasApiKey: hasSecret(s.apiKey), urls: s.urls?.length ?? 0, hasUrls: (s.urls?.length ?? 0) > 0 })
  }
  // Additional kinds: mask any string fields under the known keys; never return raw values.
  const s = (ch.secrets ?? {}) as Record<string, unknown>
  const str = (k: string) => typeof s[k] === 'string' ? s[k] as string : undefined
  return blank({
    userKey: maskSecret(str('userKey')), hasUserKey: hasSecret(str('userKey')),
    appToken: maskSecret(str('appToken')), hasAppToken: hasSecret(str('appToken')),
    accessToken: maskSecret(str('accessToken')), hasAccessToken: hasSecret(str('accessToken')),
    apiKey: maskSecret(str('apiKey')), hasApiKey: hasSecret(str('apiKey')),
    urls: Array.isArray(s.urls) ? s.urls.length : 0,
    hasUrls: Array.isArray(s.urls) && s.urls.length > 0,
  })
}

function blank(partial: Record<string, unknown>) {
  return {
    userKey: null as string | null,
    hasUserKey: false,
    appToken: null as string | null,
    hasAppToken: false,
    accessToken: null as string | null,
    hasAccessToken: false,
    apiKey: null as string | null,
    hasApiKey: false,
    urls: 0,
    hasUrls: false,
    ...partial,
  }
}

export function publicChannel(ch: NotificationChannel) {
  return {
    id: ch.id,
    name: ch.name,
    kind: ch.kind,
    enabled: ch.enabled,
    config: ch.config as Record<string, unknown>,
    secrets: publicSecrets(ch),
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
  }
}

export function publicRule(r: NotificationRule) {
  return r
}

export function mergeSecrets(
  kind: NotificationChannel['kind'],
  prev: NotificationChannel['secrets'] | undefined,
  patch: {
    userKey?: string
    appToken?: string
    accessToken?: string
    apiKey?: string
    urls?: string[]
  } | undefined,
): NotificationChannel['secrets'] {
  const keep = <T extends string>(key: T, incoming: string | undefined, existing: string | undefined): string | undefined => {
    if (incoming === undefined) return existing
    if (incoming === '') return undefined
    return incoming
  }
  if (kind === 'pushover') {
    const p = (prev ?? {}) as PushoverSecrets
    return { userKey: keep('userKey', patch?.userKey, p.userKey), appToken: keep('appToken', patch?.appToken, p.appToken) }
  }
  if (kind === 'pushbullet') {
    const p = (prev ?? {}) as PushbulletSecrets
    return { accessToken: keep('accessToken', patch?.accessToken, p.accessToken) }
  }
  if (kind === 'apprise') {
    const p = (prev ?? {}) as AppriseSecrets
    const urls = patch?.urls === undefined ? p.urls : (patch.urls.length === 0 ? undefined : patch.urls)
    return { apiKey: keep('apiKey', patch?.apiKey, p.apiKey), urls }
  }
  const prevRec = (prev as Record<string, unknown> | undefined) ?? {}
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(prevRec)) {
    const incoming = patch ? (patch as Record<string, unknown>)[k] : undefined
    if (incoming === '' || (Array.isArray(incoming) && incoming.length === 0)) continue
    next[k] = incoming === undefined ? v : incoming
  }
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue
      if (!(k in next)) next[k] = v
    }
  }
  return next
}

export function parseConfig(kind: NotificationChannel['kind'], raw: Record<string, unknown> | undefined) {
  const r = raw ?? {}
  if (kind === 'pushover') {
    return {
      device: typeof r.device === 'string' ? r.device : undefined,
      sound: typeof r.sound === 'string' ? r.sound : undefined,
      retry: typeof r.retry === 'number' ? r.retry : undefined,
      expire: typeof r.expire === 'number' ? r.expire : undefined,
    }
  }
  if (kind === 'pushbullet') {
    return {
      deviceIden: typeof r.deviceIden === 'string' ? r.deviceIden : undefined,
      channelTag: typeof r.channelTag === 'string' ? r.channelTag : undefined,
    }
  }
  if (kind === 'apprise') {
    return {
      serverUrl: typeof r.serverUrl === 'string' ? r.serverUrl : '',
      configKey: typeof r.configKey === 'string' ? r.configKey : undefined,
      tag: typeof r.tag === 'string' ? r.tag : undefined,
    }
  }
  // Unknown kinds (e.g. APNs) keep their config as a plain object.
  return { ...r }
}
