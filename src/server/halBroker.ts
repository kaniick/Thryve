import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { envValue } from '../lib/legacyEnv'
import { halBrokerStatus, mqttConnectedFromHealth, tomlBrokerFromText, type HalBrokerStatus } from '../mqtt/halBroker'

export function halTomlPath(): string {
  return join(process.env.THRYVE_ETC_DIR ?? '/etc/thryve', 'hal.toml')
}

export function halHttpBase(): string {
  return (process.env.HAL_HTTP_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '')
}

async function readHalToml(path: string): Promise<{ text: string, path: string } | null> {
  try {
    return { text: await readFile(path, 'utf8'), path }
  }
  catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return null
    throw err
  }
}

async function haldMqttConnected(httpBase = halHttpBase(), fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 1500)
  try {
    const res = await fetchImpl(`${httpBase}/health`, { signal: ac.signal })
    if (!res.ok) return null
    return mqttConnectedFromHealth(await res.json())
  }
  catch {
    return null
  }
  finally {
    clearTimeout(timer)
  }
}

/** Node-side status for Settings: reads hal.toml and hald /health, never returns secrets. */
export async function loadHalBrokerStatus(sim: boolean, fetchImpl?: typeof fetch): Promise<HalBrokerStatus> {
  if (sim) return halBrokerStatus({ sim: true })
  const path = halTomlPath()
  const raw = await readHalToml(path)
  const file = raw ? tomlBrokerFromText(raw.text) : null
  const connected = await haldMqttConnected(halHttpBase(), fetchImpl ?? fetch)
  return halBrokerStatus({ sim: false, file, configPath: raw?.path ?? null, connected })
}

export const INSTALLED_HAL_MQTT = '/usr/local/sbin/thryve-hal-mqtt'

/** `THRYVE_HAL_MQTT_CMD` (a JSON array) overrides; otherwise sudo and the installed helper, when it's there. */
export function halMqttCommand(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const cmd = envValue(env, 'THRYVE_HAL_MQTT_CMD')
  if (cmd) return JSON.parse(cmd) as string[]
  return existsSync(INSTALLED_HAL_MQTT) ? ['sudo', '-n', INSTALLED_HAL_MQTT] : null
}

export interface ApplyHalBrokerInput { url: string, username?: string | null, password?: string | null }

export interface ApplyHalBrokerResult { ok: boolean, detail: string, code?: string }

function runHelper(cmd: string[], payload: ApplyHalBrokerInput, env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0] as string, cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('the hardware-broker helper timed out'))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

/**
 * Point hald and core at the same broker. Secrets go to the helper on stdin.
 * Returns a user-facing detail and never includes the password.
 */
export async function applyHalBroker(mqtt: ApplyHalBrokerInput, env: NodeJS.ProcessEnv = process.env): Promise<ApplyHalBrokerResult> {
  const cmd = halMqttCommand(env)
  if (!cmd) {
    return { ok: false, code: 'unavailable', detail: 'This isn\'t installed on the unit yet. Run scripts/install (or scripts/install-hal) over SSH, then use the button here, or follow docs/INSTALLATION.md §4 to edit hal.toml and HAL_MQTT_URL by hand.' }
  }
  try {
    const { code, stdout, stderr } = await runHelper(cmd, mqtt, env)
    const last = stdout.trim().split('\n').at(-1) ?? ''
    try {
      const result = JSON.parse(last) as { ok?: boolean, detail?: string, error?: string, code?: string }
      const detail = result.detail ?? result.error ?? (code === 0 ? 'The hardware daemon is now using this broker.' : 'The hardware-broker helper failed.')
      return { ok: !!result.ok, detail, ...(result.code ? { code: result.code } : {}) }
    }
    catch {
      return { ok: false, code: 'failed', detail: code === 0 ? 'The hardware-broker helper returned an unexpected response.' : (stderr.trim() || 'The hardware-broker helper failed.') }
    }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : 'The hardware-broker helper failed.'
    return { ok: false, code: 'failed', detail: message }
  }
}
