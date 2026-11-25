/**
 * Setup check (ADR-0029): what a unit with plants in it is missing. Pods
 * planted with no light or pump schedule on, and a tank sensor that's absent
 * or reading `suspect`. Each problem is its own alert kind, so the app, MCP
 * `status` and Home Assistant see it, and it clears when the setup is fixed.
 */
import type { HalSnapshot } from '../hardware/types'
import type { AlertRow, LightSpec, Schedule, Store } from '../store/types'

export type SetupIssueId = 'no_light_schedule' | 'no_pump_schedule' | 'water_sensor_absent' | 'water_sensor_suspect'

/** Alert kinds the check raises; the two water-sensor problems share one. */
export const TANK_SENSOR_ALERT = 'setup_water_sensor'
export const SETUP_ALERTS = ['setup_light_schedule', 'setup_pump_schedule', TANK_SENSOR_ALERT] as const
export type SetupAlert = typeof SETUP_ALERTS[number]

export interface SetupIssue {
  id: SetupIssueId
  alert: SetupAlert
  /** A few words for the Status page. */
  title: string
  detail: string
  /** Where in the app it is fixed. */
  fix: string
}

export interface SetupReport {
  /** Pods with something in them (any status but empty). */
  planted: number
  issues: SetupIssue[]
  /** One line for the Status page. */
  summary: string
}

/** On, on at least one day, and, for a light, bright at some point of the day. */
function runs(s: Schedule): boolean {
  if (!s.enabled || (s.days & 127) === 0) return false
  return s.kind === 'pump' || (s.spec as LightSpec).setpoints.some(p => p.level > 0)
}

const pods = (n: number) => `${n} pod${n === 1 ? '' : 's'}`

export function setupReport(store: Store, snap: HalSnapshot, now = new Date(), activeTank?: AlertRow | null): SetupReport {
  return assessSetup(store, snap, now, activeTank).report
}

/** Reading the setup is independent of deciding whether to close an existing tank notice. */
export function assessSetup(store: Store, snap: HalSnapshot, now: Date, activeTank?: AlertRow | null): { report: SetupReport, tankKnown: boolean } {
  const planted = store.pods.list().filter(p => p.status !== 'empty').length
  const schedules = store.schedules.list().filter(runs)
  const issues: SetupIssue[] = []
  if (planted > 0 && !schedules.some(s => s.kind === 'light')) {
    issues.push({ id: 'no_light_schedule', alert: 'setup_light_schedule', title: 'No light schedule', detail: `${pods(planted)} planted but no light schedule is on, so the light stays wherever it was last set.`, fix: 'Add or turn on a light schedule on Light.' })
  }
  if (planted > 0 && !schedules.some(s => s.kind === 'pump')) {
    issues.push({ id: 'no_pump_schedule', alert: 'setup_pump_schedule', title: 'No pump schedule', detail: `${pods(planted)} planted but no pump schedule is on, so the roots get water only when someone runs the pump.`, fix: 'Add or turn on a pump cycle on Water.' })
  }
  const tank = tankSensorIssue(store, snap, now, activeTank)
  if (tank) issues.push(tank)
  const summary = issues.length
    ? issues.map(i => i.title).join(' · ')
    : planted ? `${pods(planted)} planted · light and pump schedules on` : 'Nothing planted yet'
  return { report: { planted, issues, summary }, tankKnown: tank !== undefined }
}

export const SUSPECT_WINDOW_MS = 10 * 60_000
const RAISE_AT = 0.5
const CLEAR_BELOW = 0.3
const MIN_SAMPLES = 3
const SUSPECT_ISSUE: SetupIssue = {
  id: 'water_sensor_suspect', alert: TANK_SENSOR_ALERT, title: 'Tank level suspect',
  detail: 'The tank level reads suspect: its pings disagreed or too few came back, so top-offs aren\'t advised from it.',
  fix: 'Check nothing blocks the level sensor and its cable is seated; Sensors shows the reading.',
}

/** Undefined is no verdict. An outage, startup or an expired sample cannot prove recovery. */
function tankSensorIssue(store: Store, snap: HalSnapshot, now: Date, activeTank: AlertRow | null | undefined): SetupIssue | null | undefined {
  if (!snap.online || !snap.system) return undefined
  const device = snap.devices?.sensors.find(d => d.ids.includes('water_level_pct'))
  if (!snap.system.caps.sensors.includes('water_level_pct') || device?.status === 'absent') {
    return { id: 'water_sensor_absent', alert: TANK_SENSOR_ALERT, title: 'Tank sensor not answering', detail: `No tank level sensor is answering${device?.detail ? ` (${device.detail})` : ''}, so the unit can't tell when the tank runs low.`, fix: 'Check the level sensor\'s cable; Sensors lists it.' }
  }

  const reading = snap.sensors.water_level_pct
  const sampleTime = reading && Date.parse(reading.ts)
  const end = now.getTime()
  if (!reading || reading.quality === 'stale' || sampleTime === undefined || !Number.isFinite(sampleTime) || sampleTime > end || sampleTime < end - SUSPECT_WINDOW_MS) return undefined
  const active = activeTank === undefined ? store.alerts.list({ kind: TANK_SENSOR_ALERT, activeOnly: true, limit: 1 })[0] : activeTank
  const wasSuspect = active?.detail === SUSPECT_ISSUE.detail
  if (!wasSuspect && reading.quality === 'good') return null

  const from = new Date(end - SUSPECT_WINDOW_MS).toISOString()
  const { good, suspect } = store.sensorQuality.counts('water_level_pct', from, now.toISOString())
  // Stale samples don't vote for or against recovery.
  if (good + suspect < MIN_SAMPLES) return wasSuspect ? SUSPECT_ISSUE : undefined
  const share = suspect / (good + suspect)
  if (wasSuspect) return reading.quality === 'good' && share <= CLEAR_BELOW ? null : SUSPECT_ISSUE
  return share >= RAISE_AT ? SUSPECT_ISSUE : undefined
}
