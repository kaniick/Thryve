/**
 * Scheduler — evaluates light curves and pump cycles once a minute.
 *
 * Deliberately not cron: a light *curve* is a continuous function of local
 * time (interpolated setpoints, so sunrise/sunset ramps are free), and pump
 * runs are bounded events that must fire at most once per (schedule, day,
 * minute) even if the process restarts — the Store's run log is the
 * idempotency key. A run the HAL refuses (one lost tank reading leaves the
 * level unknown, which refuses a start) is tried again a minute apart, through
 * the same guarded HAL call, and raises an alert if none is accepted. All
 * inputs are injected so it is testable to the minute.
 */
import type { LightArbiter } from '../control/light'
import type { ActuatorState } from '../hardware/contract'
import type { HalClient, HalSnapshot } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import type { LightSpec, PumpSpec, Schedule, Store } from '../store/types'
import type { SunHours } from './lightPlan'
import { readLightReceipt, type LightReceipt } from './receipts'
import { followSun } from './sun'
import { dayEnabled, localTime, minuteToHHMM } from './time'

/** How many times a refused scheduled pump run is tried again, a minute apart, after its first try. */
export const PUMP_RETRIES = 15

/** Raised when a scheduled pump run was refused on every try; cleared when a scheduled run next fires. Core-only. */
export const MISSED_ALERT = 'pump_schedule_missed'

/** A refused scheduled run still being tried. */
interface Retry {
  key: string
  /** Its tries so far, the first included. */
  tries: number
  /** The minute (since the epoch) of its last try: the next waits for a later one. */
  lastMinute: number
}

/**
 * Why hald didn't start the pump. A refusal with a latched fault rejects with
 * it; a start refused on the tank level comes back as the pump's state, off and
 * with no fault, so the reason is read from what core last heard.
 */
export function refusalReason(snap: HalSnapshot, e?: unknown, state?: ActuatorState): string {
  if (e) return (e as Error).message.replace(/^refused:\s*/i, '')
  if (state?.fault) return state.fault
  if (snap.alerts.water_low?.active) return 'water low'
  if (snap.alerts.over_temp?.active) return 'board over temperature'
  const level = snap.sensors.water_distance
  if (!level || level.quality === 'suspect') return 'tank level unavailable'
  return 'the unit refused the start'
}

export interface SchedulerDeps {
  store: Store
  hal: HalClient
  events: EventBus
  /** When present, the curve is handed to the light arbiter (ADR-0020) instead of written directly. */
  light?: LightArbiter
  now?: () => Date
  /** False while the clock can't be believed yet; pump slots wait. */
  clockTrusted?: () => boolean
  log?: (msg: string) => void
  /** Auto curves' hours of full light now, from the grow protocol. */
  autoHours?: () => SunHours
}

/** Desired light level at `minute` for a curve, or null if the curve is empty. */
export function lightLevelAt(spec: LightSpec, minute: number): number | null {
  const pts = [...spec.setpoints].sort((a, b) => a.minute - b.minute)
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!first || !last) return null
  if (pts.length === 1) return clamp(first.level)
  const m = ((minute % 1440) + 1440) % 1440
  // Wrap the curve around midnight: last point → first point of the next day.
  if (m < first.minute || m >= last.minute) {
    const span = first.minute + 1440 - last.minute
    const into = m >= last.minute ? m - last.minute : m + 1440 - last.minute
    return clamp(lerp(last.level, first.level, span === 0 ? 0 : into / span))
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (a && b && m >= a.minute && m < b.minute) {
      return clamp(lerp(a.level, b.level, (m - a.minute) / (b.minute - a.minute)))
    }
  }
  return clamp(last.level)
}

/** The light the running curves ask for at `minute`: the highest wins (lets a "boost" schedule overlay a base curve); null with none. */
export function curveTarget(running: Schedule[], minute: number): number | null {
  let target: number | null = null
  for (const s of running.filter((s): s is Schedule & { spec: LightSpec } => s.kind === 'light')) {
    const lvl = lightLevelAt(s.spec, minute)
    if (lvl !== null) target = target === null ? lvl : Math.max(target, lvl)
  }
  return target
}

/** Rewrite each sun-following curve's setpoints for the day of `now`, where they've moved; returns the ids rewritten. */
export function refollowSun(store: Store, now: Date, autoHours?: SunHours): string[] {
  const settings = store.settings.get()
  const changed: string[] = []
  for (const s of store.schedules.list()) {
    if (s.kind !== 'light' || !('setpoints' in s.spec) || !s.spec.sun) continue
    const spec = followSun(s.spec, settings, now, autoHours)
    if (JSON.stringify(spec.setpoints) === JSON.stringify(s.spec.setpoints)) continue
    store.schedules.upsert({ id: s.id, kind: s.kind, name: s.name, enabled: s.enabled, days: s.days, spec })
    changed.push(s.id)
  }
  return changed
}

export interface TickResult {
  lightTarget: number | null
  pumpFired: string[]
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastLightApplied: number | null = null
  private readonly now: () => Date
  private readonly log: (msg: string) => void
  /** Refused scheduled pump runs being tried again, by schedule id. */
  private readonly retries = new Map<string, Retry>()
  private lastLightReceipt: LightReceipt | null | undefined

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date())
    this.log = deps.log ?? (() => undefined)
  }

  start(intervalMs = 60_000): void {
    this.stop()
    this.timer = setInterval(() => this.timerTick(), intervalMs)
    this.timerTick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Read-only diagnostics. */
  receiptState(): { lights: LightReceipt[], retrying: string[] } {
    return { lights: this.deps.store.diagnostics.lights(12), retrying: [...this.retries.values()].map(r => r.key) }
  }

  private observeLight(at: Date, target: number | null): void {
    const { hal, light } = this.deps
    const receipt = readLightReceipt(at.toISOString(), target, light?.status().source ?? null, hal.snapshot())
    const previous = this.lastLightReceipt === undefined ? this.deps.store.diagnostics.lights(1)[0] : this.lastLightReceipt
    this.lastLightReceipt = previous ?? null
    if (previous && receipt.target === previous.target && receipt.reported === previous.reported
      && receipt.source === previous.source && receipt.outcome === previous.outcome && receipt.fault === previous.fault) return
    this.deps.store.diagnostics.recordLight(receipt)
    this.lastLightReceipt = receipt
  }

  private timerTick(): void {
    // A failed read/write must leave this tick failed, not exit the whole
    // service. In particular, never run a pump start we could not record.
    void this.tick().catch((e: Error) => console.warn(`scheduler tick failed: ${e.message}`))
  }

  /** Evaluate every enabled schedule for "now". Safe to call repeatedly. */
  async tick(): Promise<TickResult> {
    const { store, hal } = this.deps
    const settings = store.settings.get()
    const now = this.now()
    const lt = localTime(now, settings.timezone)
    // Sunrise and sunset move a minute or two a day; a curve following them moves with them.
    for (const id of refollowSun(store, now, this.deps.autoHours?.())) this.deps.events.emit({ kind: 'schedule', action: 'changed', id })
    const schedules = store.schedules.list().filter(s => s.enabled && dayEnabled(s.days, lt.weekday))

    const lightTarget = curveTarget(schedules, lt.minute)
    if (this.deps.light) {
      // The arbiter decides whether the curve or a higher source (manual, Autopilot) owns the light.
      if (lightTarget !== this.lastLightApplied) this.deps.events.emit({ kind: 'schedule', action: 'fired', id: 'light-curve' })
      this.lastLightApplied = lightTarget
      await this.deps.light.setSchedule(lightTarget)
    }
    else if (lightTarget !== null && lightTarget !== this.lastLightApplied) {
      try {
        await hal.setActuator('light', lightTarget === 0 ? { on: false, level: 0 } : { on: true, level: lightTarget })
        this.lastLightApplied = lightTarget
        this.deps.events.emit({ kind: 'schedule', action: 'fired', id: 'light-curve' })
      }
      catch (e) {
        this.log(`light curve apply failed: ${(e as Error).message}`)
      }
    }

    // Pump: fire once per schedule/day/minute.
    try {
      this.observeLight(now, lightTarget)
    }
    catch (e) {
      // Diagnostics must not get in the way of evaluating due watering.
      this.log(`light observation failed: ${(e as Error).message}`)
    }
    const pumpFired: string[] = []
    for (const s of schedules.filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')) {
      if (s.spec.minute !== lt.minute) continue
      // Unrecorded, so a slot the wrong clock lands on is free to fire at the right time.
      if (this.deps.clockTrusted?.() === false) {
        this.log(`pump schedule ${s.name} skipped: the clock isn't set yet`)
        continue
      }
      const key = `${s.id}:${lt.date}:${lt.minute}`
      if (!store.schedules.recordRun({ scheduleId: s.id, key, firedAt: now.toISOString(), result: 'pending' })) continue
      // Its next run is due: an earlier one still being retried gives way to it.
      this.retries.delete(s.id)
      if (await this.runPump(s, key, 1, now)) pumpFired.push(s.id)
    }
    // A refused run is tried again once a minute, through the same HAL call: hald's guard still decides.
    for (const [id, r] of [...this.retries]) {
      if (Math.floor(now.getTime() / 60_000) <= r.lastMinute || this.deps.clockTrusted?.() === false) continue
      const s = store.schedules.get(id)
      if (s?.kind !== 'pump' || !s.enabled) {
        this.retries.delete(id)
        continue
      }
      if (await this.runPump(s as Schedule & { spec: PumpSpec }, r.key, r.tries + 1, now)) pumpFired.push(id)
    }
    return { lightTarget, pumpFired }
  }

  /** One try of a scheduled run; true when hald started the pump. */
  private async runPump(s: Schedule & { spec: PumpSpec }, key: string, tries: number, now: Date): Promise<boolean> {
    const { store, hal, events } = this.deps
    let reason: string | null = null
    let reportedStart: string | null = null
    // An ACK that simply reflects an already-running pump is not a new start.
    let wasOff = false
    try {
      const snapshot = hal.snapshot()
      wasOff = snapshot.online && snapshot.actuators.pump?.on === false
    }
    catch {
      // Missing diagnostics must not change the existing guard/command path.
    }
    try {
      const state = await hal.setActuator('pump', { on: true, level: s.spec.level, durationS: s.spec.durationS })
      if (!state.on) reason = refusalReason(hal.snapshot(), undefined, state)
      else if (wasOff && Date.parse(state.since) >= now.getTime() - 1000) reportedStart = state.since
    }
    catch (e) {
      reason = refusalReason(hal.snapshot(), e)
    }
    try {
      store.diagnostics.recordAttempt({ runKey: key, attempt: tries, at: now.toISOString(), result: reason === null ? 'accepted' : 'refused', reason, reportedStart, requestedS: s.spec.durationS })
    }
    catch (e) {
      this.log(`pump receipt could not be saved: ${(e as Error).message}`)
    }
    const at = minuteToHHMM(s.spec.minute)
    if (reason === null) {
      this.retries.delete(s.id)
      store.schedules.setRunResult(key, 'fired')
      events.emit({ kind: 'schedule', action: 'fired', id: s.id })
      this.log(`pump schedule ${s.name} fired for ${s.spec.durationS}s${tries > 1 ? ` on try ${tries}` : ''}`)
      if (store.alerts.list({ activeOnly: true }).some(a => a.kind === MISSED_ALERT)) {
        store.alerts.clear(MISSED_ALERT, now.toISOString())
        events.emit({ kind: 'mutation', path: `alerts.${MISSED_ALERT}` })
      }
      return true
    }
    store.schedules.setRunResult(key, `refused: ${reason}`)
    // console.warn reaches the unit's journal; the routine log doesn't.
    const left = PUMP_RETRIES + 1 - tries
    console.warn(`pump schedule ${s.name} (${at}) refused on try ${tries}: ${reason}${left > 0 ? `; trying again in a minute (${left} left)` : '; giving up'}`)
    if (left > 0) {
      this.retries.set(s.id, { key, tries, lastMinute: Math.floor(now.getTime() / 60_000) })
      return false
    }
    this.retries.delete(s.id)
    const last = minuteToHHMM(localTime(now, store.settings.get().timezone).minute)
    store.alerts.raise(MISSED_ALERT, `Scheduled watering at ${at} didn't run: the pump was refused ${tries} times, through ${last}. Last reason: ${reason}.`, now.toISOString())
    events.emit({ kind: 'mutation', path: `alerts.${MISSED_ALERT}` })
    return false
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function clamp(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)))
}
