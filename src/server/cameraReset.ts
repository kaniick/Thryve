/**
 * Restart one timelapse camera by cycling its USB device. The Gardyn's upper
 * and lower cameras are UVC modules on a USB hub, not a second Pi. Core runs a
 * scoped root helper (`thryve-camera-reset`) that tries a USB reset, then
 * authorized 0/1, then hub-port power, then a uvcvideo rebind — never dwc_otg
 * and never a reboot (docs/hardware/pin-map.md).
 */
import { spawn } from 'node:child_process'
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { envValue } from '../lib/legacyEnv'

export const INSTALLED_CAMERA_RESET = '/usr/local/sbin/thryve-camera-reset'
export type CameraName = 'upper' | 'lower'

export interface CameraRestartResult {
  ok: boolean
  camera: CameraName
  detail: string
  method?: string
  code?: string
  present?: boolean
  simulated?: boolean
  ts: string
}

/** `THRYVE_CAMERA_RESET_CMD` (a JSON array) overrides; otherwise sudo and the installed helper. */
export function cameraResetCommand(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const cmd = envValue(env, 'THRYVE_CAMERA_RESET_CMD')
  if (cmd) return JSON.parse(cmd) as string[]
  return existsSync(INSTALLED_CAMERA_RESET) ? ['sudo', '-n', INSTALLED_CAMERA_RESET] : null
}

function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR ?? './data'
}

function logPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'camera-reset.log')
}

export function appendRestartLog(entry: CameraRestartResult, env: NodeJS.ProcessEnv = process.env): void {
  try {
    mkdirSync(dataDir(env), { recursive: true })
    appendFileSync(logPath(env), `${JSON.stringify(entry)}\n`)
  }
  catch {
    // The tRPC result is the record the UI shows; the file is the audit trail on the unit.
  }
}

export function listRestartLog(env: NodeJS.ProcessEnv = process.env, limit = 20): CameraRestartResult[] {
  try {
    const lines = readFileSync(logPath(env), 'utf8').trim().split('\n').filter(Boolean)
    const rows: CameraRestartResult[] = []
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line) as CameraRestartResult)
      }
      catch {
        // skip a torn last line
      }
    }
    return rows.slice(-limit).reverse()
  }
  catch {
    return []
  }
}

function runHelper(cmd: string[], camera: CameraName, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0] as string, [...cmd.slice(1), camera], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('the camera-reset helper timed out'))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

export function helperUnavailableDetail(): string {
  return 'Restarting a camera needs a one-time install of the helper: over SSH run sudo /opt/thryve/scripts/install, then try again.'
}

/**
 * Cycle one camera's USB device. On the simulator (no helper, no HAL_MQTT_URL)
 * this is a no-op success so the UI can be exercised. On a unit without the
 * helper it tells the owner to run scripts/install.
 */
export async function restartCamera(camera: CameraName, env: NodeJS.ProcessEnv = process.env, now = () => new Date(), timeoutMs = 45_000): Promise<CameraRestartResult> {
  const ts = now().toISOString()
  const cmd = cameraResetCommand(env)
  if (!cmd) {
    const simulated = !env.HAL_MQTT_URL && !process.env.HAL_MQTT_URL
    const result: CameraRestartResult = simulated
      ? { ok: true, camera, ts, method: 'simulated', simulated: true, present: true, detail: `Simulated a restart of the ${camera} camera. On the unit this power-cycles its USB port; it does not reboot the Pi.` }
      : { ok: false, camera, ts, code: 'unavailable', detail: helperUnavailableDetail() }
    appendRestartLog(result, env)
    return result
  }
  try {
    const { code, stdout, stderr } = await runHelper(cmd, camera, env, timeoutMs)
    const last = stdout.trim().split('\n').at(-1) ?? ''
    try {
      const parsed = JSON.parse(last) as { ok?: boolean, method?: string, error?: string, code?: string, present?: boolean, camera?: string }
      const ok = !!parsed.ok
      const detail = ok
        ? `Restarted the ${camera} camera (${parsed.method ?? 'usb reset'}). Give it a few seconds, then capture again.`
        : (parsed.error ?? (stderr.trim() || 'The camera-reset helper failed.'))
      const result: CameraRestartResult = { ok, camera, ts, detail, method: parsed.method, code: parsed.code, present: parsed.present }
      appendRestartLog(result, env)
      return result
    }
    catch {
      const result: CameraRestartResult = { ok: false, camera, ts, code: 'failed', detail: code === 0 ? 'The camera-reset helper returned an unexpected response.' : (stderr.trim() || 'The camera-reset helper failed.') }
      appendRestartLog(result, env)
      return result
    }
  }
  catch (err) {
    const result: CameraRestartResult = { ok: false, camera, ts, code: 'failed', detail: err instanceof Error ? err.message : 'The camera-reset helper failed.' }
    appendRestartLog(result, env)
    return result
  }
}
