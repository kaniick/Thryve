import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/** Load the daemon's MQTT settings from a hal.toml path; null if the file isn't there. */
export async function readHalTomlBroker(path: string): Promise<HalTomlBroker | null> {
  try {
    const parsed = parseHalTomlBroker(await readFile(path, 'utf8'))
    return {
      url: parsed.url ?? DEFAULT_HAL_MQTT_URL,
      explicit: parsed.explicit,
      hasUsername: parsed.hasUsername,
      hasPassword: parsed.hasPassword,
    }
  }
  catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return null
    throw err
  }
}

export function halTomlPath(): string {
  return join(process.env.THRYVE_ETC_DIR ?? '/etc/thryve', 'hal.toml')
}

export function halHttpBase(): string {
  return (process.env.HAL_HTTP_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '')
}

/** Whether hald's HTTP /health reports an MQTT session. null if it couldn't be reached. */
export async function haldMqttConnected(httpBase = halHttpBase(), fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 1500)
  try {
    const res = await fetchImpl(`${httpBase}/health`, { signal: ac.signal })
    if (!res.ok) return null
    const body = await res.json() as { mqtt_connected?: unknown }
    return typeof body.mqtt_connected === 'boolean' ? body.mqtt_connected : null
  }
  catch {
    return null
  }
  finally {
    clearTimeout(timer)
  }
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
 */
export async function halBrokerStatus(opts: { sim?: boolean, tomlPath?: string, httpBase?: string, fetchImpl?: typeof fetch } = {}): Promise<HalBrokerStatus> {
  if (opts.sim) {
    return { broker: null, url: null, connected: null, sim: true, configPath: null, usingDefault: false }
  }
  const path = opts.tomlPath ?? halTomlPath()
  const file = await readHalTomlBroker(path)
  const url = file?.url ?? DEFAULT_HAL_MQTT_URL
  const connected = await haldMqttConnected(opts.httpBase ?? halHttpBase(), opts.fetchImpl ?? fetch)
  const safe = stripUserinfo(url)
  return {
    broker: brokerHost(safe),
    url: safe,
    connected,
    sim: false,
    configPath: file ? path : null,
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
