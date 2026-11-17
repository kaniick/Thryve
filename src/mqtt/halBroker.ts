import { brokerHost } from './bridge'

/** hald's default when `mqtt_url` is unset in hal.toml. */
export const DEFAULT_HAL_MQTT_URL = 'mqtt://127.0.0.1:1883'

export interface HalTomlBroker {
  /** The configured URL, or the daemon default when the key is absent. */
  url: string
  /** True when mqtt_url was explicitly set in the file. */
  explicit: boolean
  hasUsername: boolean
  hasPassword: boolean
}

/** Read uncommented mqtt_url / username / password keys from a hal.toml body. */
export function parseHalTomlBroker(text: string): Omit<HalTomlBroker, 'url'> & { url: string | null } {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const m = /^(mqtt_url|mqtt_username|mqtt_password)\s*=\s*(.*?)\s*$/.exec(s)
    if (!m || !m[1] || m[2] === undefined) continue
    values[m[1]] = unquoteToml(m[2])
  }
  const url = values.mqtt_url && values.mqtt_url.length > 0 ? values.mqtt_url : null
  return {
    url,
    explicit: url !== null,
    hasUsername: !!values.mqtt_username,
    hasPassword: !!values.mqtt_password,
  }
}

function unquoteToml(raw: string): string {
  const t = raw.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\'') && t.endsWith('\''))) {
    return t.slice(1, -1).replace(/\\"/g, '"')
  }
  return t
}

export function tomlBrokerFromText(text: string): HalTomlBroker {
  const parsed = parseHalTomlBroker(text)
  return {
    url: parsed.url ?? DEFAULT_HAL_MQTT_URL,
    explicit: parsed.explicit,
    hasUsername: parsed.hasUsername,
    hasPassword: parsed.hasPassword,
  }
}

export interface HardwareBrokerApplyInput {
  url: string
  username?: string | null
  password?: string | null
}

export interface HardwareBrokerApplyResult {
  ok: boolean
  detail: string
  code?: string
}

/** Node hosts only: read and optionally re-point hald's broker. The browser demo omits this. */
export interface HardwareBrokerControl {
  status: (sim: boolean) => Promise<HalBrokerStatus>
  canApply: (sim: boolean) => boolean
  apply: (mqtt: HardwareBrokerApplyInput) => Promise<HardwareBrokerApplyResult>
}

export interface HalBrokerStatus {
  /** Broker host:port (no credentials), or null when we can't tell. */
  broker: string | null
  /** Configured URL with userinfo stripped. */
  url: string | null
  connected: boolean | null
  /** The hardware backend is the in-process simulator, which has no broker. */
  sim: boolean
  /** Path we read, when a config file was present. */
  configPath: string | null
  usingDefault: boolean
}

/**
 * The hardware daemon's MQTT broker and whether it is connected, for the
 * Settings Home Assistant card. Never includes a username or password.
 * Callers on Node supply the parsed toml and /health result.
 */
export function halBrokerStatus(opts: {
  sim?: boolean
  file?: HalTomlBroker | null
  configPath?: string | null
  connected?: boolean | null
} = {}): HalBrokerStatus {
  if (opts.sim) {
    return { broker: null, url: null, connected: null, sim: true, configPath: null, usingDefault: false }
  }
  const file = opts.file ?? null
  const url = file?.url ?? DEFAULT_HAL_MQTT_URL
  const safe = stripUserinfo(url)
  return {
    broker: brokerHost(safe),
    url: safe,
    connected: opts.connected ?? null,
    sim: false,
    configPath: file ? (opts.configPath ?? null) : null,
    usingDefault: !file || !file.explicit,
  }
}

function stripUserinfo(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return u.toString().replace(/\/$/, '')
  }
  catch {
    return url
  }
}

/** Whether a hald /health body reports an MQTT session. */
export function mqttConnectedFromHealth(body: unknown): boolean | null {
  if (!body || typeof body !== 'object' || !('mqtt_connected' in body)) return null
  return typeof (body as { mqtt_connected: unknown }).mqtt_connected === 'boolean'
    ? (body as { mqtt_connected: boolean }).mqtt_connected
    : null
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Set or remove mqtt_url / mqtt_username / mqtt_password in a hal.toml body,
 * leaving every other line (including comments) as it is.
 */
export function upsertHalTomlMqtt(text: string, mqtt: { url: string, username?: string | null, password?: string | null }): string {
  const values: Record<string, string | null> = {
    mqtt_url: mqtt.url,
    mqtt_username: mqtt.username ?? null,
    mqtt_password: mqtt.password ?? null,
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    const m = !s.startsWith('#') ? /^(mqtt_url|mqtt_username|mqtt_password)\s*=/.exec(s) : null
    if (m && m[1]) {
      const key = m[1]
      seen.add(key)
      const v = values[key]
      if (v) out.push(`${key} = ${tomlQuote(v)}`)
      continue
    }
    out.push(line)
  }
  for (const key of ['mqtt_url', 'mqtt_username', 'mqtt_password'] as const) {
    if (seen.has(key) || !values[key]) continue
    if (out.length && out[out.length - 1] !== '') out.push('')
    out.push(`${key} = ${tomlQuote(values[key] as string)}`)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}
