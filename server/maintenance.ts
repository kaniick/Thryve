import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { uptime } from 'node:os'
import type { Hono } from 'hono'
import type { Context } from '../src/server/context'
import { isLoopback } from './auth'
import type { CorePerformanceWindow } from './performance'

type Action = 'restart-core' | 'reboot'
type Result = { ok: true } | { ok: false, code: string }
type Execute = (action: Action, key: string) => Promise<Result>

const HELPER = '/usr/local/sbin/thryve-maintenance'
const BUSY = '/run/thryve-busy'
const KEY_PATH = '/etc/thryve-maintenance.key'
const KEY = /^[0-9a-f]{64}$/
const messages = {
  'unauthorized': [401, 'The maintenance key was not accepted.'],
  'not-configured': [503, 'Owner maintenance is not enabled on this unit.'],
  'busy': [409, 'An installation, update or restore is in progress.'],
  'actuator-active': [409, 'Wait until the pump and all dosers are off.'],
  'hald-unavailable': [503, 'Could not confirm a recent pump state from HALD. No action was queued.'],
  'command-failed': [503, 'Could not queue maintenance. Check whether an action is already pending or the maintenance helper needs reinstalling.'],
} as const

function execute(action: Action, key: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile('/usr/bin/sudo', ['-n', '--', HELPER, action], { timeout: 12_000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' } }, (err, stdout) => {
      if (!err) return resolve({ ok: true })
      try {
        const got = JSON.parse(stdout) as { code?: string }
        resolve({ ok: false, code: typeof got.code === 'string' ? got.code : 'command-failed' })
      }
      catch {
        resolve({ ok: false, code: 'command-failed' })
      }
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(`${key}\n`)
  })
}

async function busy(): Promise<boolean> {
  try {
    return (await readdir(BUSY)).length > 0
  }
  catch (err) {
    // Unknown status is not permission to interrupt a unit.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/** Browser origin must match the public Host. No forwarded headers grant loopback trust. */
export function maintenanceOrigin(origin: string | undefined, host: string | undefined, peer: string | undefined): boolean {
  if (!origin || !host) return false
  try {
    const url = new URL(origin)
    if (url.origin !== origin || url.host !== host.toLowerCase()) return false
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !!peer && isLoopback(peer))
  }
  catch {
    return false
  }
}

export interface MaintenanceOptions {
  available?: () => boolean
  execute?: Execute
  busy?: () => Promise<boolean>
  now?: () => number
}

export function mountMaintenance(app: Hono, ctx: Context, performanceWindow?: () => CorePerformanceWindow | null, o: MaintenanceOptions = {}) {
  const configured = o.available ?? (() => existsSync(HELPER) && existsSync(KEY_PATH))
  const now = o.now ?? (() => performance.now())
  let pending = false
  let lastAttempt = -Infinity
  // Register before the general API CORS middleware. Keys are never accepted
  // through tRPC, OpenAPI, MCP, or a cross-origin browser request.
  app.get('/api/maintenance/status', async (c) => {
    c.header('Cache-Control', 'no-store')
    const snap = ctx.hal.snapshot()
    const pump = snap.online ? snap.actuators.pump?.on : undefined
    return c.json({
      configured: configured(),
      busy: pending || await (o.busy ?? busy)(),
      version: ctx.version,
      hostUptimeS: Math.floor(uptime()),
      coreUptimeS: Math.floor(process.uptime()),
      halOnline: snap.online,
      pump: pump === undefined ? 'unknown' : pump ? 'running' : 'off',
      dosing: snap.online && Object.entries(snap.actuators).some(([id, state]) => id.startsWith('dose_') && state.on),
      maxLagMs: performanceWindow?.()?.maxLagMs ?? null,
      bootLog: !!ctx.bootLog,
    })
  })

  app.post('/api/maintenance/:action', async (c) => {
    c.header('Cache-Control', 'no-store')
    const action = c.req.param('action')
    if (action !== 'restart-core' && action !== 'reboot') return c.json({ error: 'Unknown maintenance action.' }, 404)
    const peer = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
    if (!maintenanceOrigin(c.req.header('origin'), c.req.header('host'), peer)) return c.json({ error: 'Open Thryve over HTTPS or a localhost SSH tunnel.' }, 403)
    const header = c.req.header('authorization') ?? ''
    const key = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!KEY.test(key)) return c.json({ error: messages.unauthorized[1] }, 401)
    if (!configured()) return c.json({ error: messages['not-configured'][1] }, 503)
    if (pending || now() - lastAttempt < 2000) return c.json({ error: 'A maintenance request just ran. Wait a moment before trying again.' }, 429)
    pending = true
    lastAttempt = now()
    try {
      const result = await (o.execute ?? execute)(action, key)
      if (result.ok) return c.json({ queued: true }, 202)
      const [status, error] = Object.hasOwn(messages, result.code) ? messages[result.code as keyof typeof messages] : messages['command-failed']
      return c.json({ error }, status)
    }
    catch {
      return c.json({ error: messages['command-failed'][1] }, 503)
    }
    finally {
      pending = false
    }
  })

  app.all('/api/maintenance/*', c => c.json({ error: 'Not found.' }, 404))
}
