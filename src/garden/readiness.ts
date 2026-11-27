import { z } from 'zod'
import { chores, dropPerDay, SETTLE_MS, trusted } from '../care/chores'
import { TANK_MIN_PCT } from '../care/knowledge'
import type { HalSnapshot } from '../hardware/types'
import type { Store } from '../store/types'

const CameraReport = z.object({
  camera: z.enum(['upper', 'lower']),
  state: z.enum(['recent', 'quiet', 'missing', 'off', 'unknown']),
  lastPhotoAt: z.string().nullable(),
})
export const Readiness = z.object({
  checkedAt: z.string(), until: z.string(), state: z.enum(['ready', 'review', 'unknown']),
  tank: z.object({
    levelPct: z.number().nullable(), readingAt: z.string().nullable(), targetPct: z.number(),
    hoursToTarget: z.number().nullable(), dropPerDay: z.number().nullable(), reason: z.string(),
  }),
  watering: z.object({
    enabled: z.boolean(),
    lastCompleted: z.object({ at: z.string(), durationS: z.number(), source: z.enum(['scheduled', 'manual']) }).nullable(),
    lastProblem: z.string().nullable(),
  }),
  cameras: z.array(CameraReport),
  chores: z.array(z.object({ title: z.string(), dueAt: z.string().nullable(), state: z.enum(['due', 'soon', 'ok', 'unknown']), basis: z.enum(['reading', 'timeline']), reason: z.string() })),
  checks: z.array(z.string()),
})
export type Readiness = z.infer<typeof Readiness>
const DAY = 86_400_000
const HOUR = DAY / 24

/** Only points with a matching good-quality observation may contribute. */
function tankTrend(store: Store, now: Date, current: number): number | null {
  const since = new Date(now.getTime() - 3 * DAY).toISOString()
  const refill = ['top_off', 'refresh'] as const
  const recent = refill.map(kind => Date.parse(store.tankActions.list({ kind, limit: 1 })[0]?.ts ?? '')).filter(t => Number.isFinite(t) && t <= now.getTime())
  const lastRefill = Math.max(-Infinity, ...recent)
  if (now.getTime() - lastRefill < SETTLE_MS) return null
  const points = store.telemetry.range('water_level_pct', since, now.toISOString(), 500)
    .filter(p => Number.isFinite(p.value) && p.value >= 0 && p.value <= 100 && Date.parse(p.ts) > lastRefill)
  const samples = store.sensorQuality.at('water_level_pct', points.map(p => p.ts))
  const good = new Set(samples.filter(s => s.quality === 'good').map(s => s.ts))
  const bad = new Set(samples.filter(s => s.quality !== 'good').map(s => s.ts))
  const matched = points.filter(p => good.has(p.ts) && !bad.has(p.ts)).sort((a, b) => a.ts.localeCompare(b.ts))
  const last = matched.at(-1)
  if (!last || now.getTime() - Date.parse(last.ts) > 6 * HOUR || Math.abs(last.value - current) >= 8) return null
  return dropPerDay(matched)
}

export function readiness(store: Store, snap: HalSnapshot, now: Date, until: Date): Readiness {
  const settings = store.settings.get()
  const trustedTank = trusted(snap, 'water_level_pct', now)
  const reading = trustedTank.reading && Date.parse(trustedTank.reading.ts) <= now.getTime() ? trustedTank.reading : null
  const level = reading?.value ?? null
  const drop = level === null || level <= TANK_MIN_PCT ? null : tankTrend(store, now, level)
  const hoursToTarget = level === null ? null : level <= TANK_MIN_PCT ? 0 : drop && drop > 0 ? (level - TANK_MIN_PCT) / drop * 24 : null
  const reason = level === null
    ? trustedTank.why ?? 'Tank reading has a future timestamp.'
    : hoursToTarget === 0
      ? 'The tank is at or below the care threshold.'
      : hoursToTarget !== null
        ? 'Estimate to the care threshold, based on recent trusted readings at the current rate of use.'
        : drop === 0
          ? 'No measurable decline in recent trusted readings. Runway cannot be estimated.'
          : 'Not enough recent, trusted tank history since the last refill to estimate runway.'

  const enabled = store.schedules.list().some(s => s.kind === 'pump' && s.enabled)
  const history = store.pumpRuns.list({ from: new Date(now.getTime() - 14 * DAY).toISOString(), to: now.toISOString(), limit: 100 })
  const finished = history.filter(p => p.endedAt && Date.parse(p.endedAt) <= now.getTime())
    .sort((a, b) => Date.parse(b.endedAt ?? '') - Date.parse(a.endedAt ?? ''))
  const completed = finished.find(p => !p.fault && p.durationS > 0 && (p.scheduledDurationS === null || p.durationS + 1 >= p.scheduledDurationS))
  const last = finished[0]
  const active = store.alerts.list({ activeOnly: true })
  const pumpFault = snap.actuators.pump?.fault
  const lastProblem = pumpFault ?? (active.some(a => a.kind === 'pump_fault')
    ? 'Active pump fault'
    : last && last !== completed ? last.fault ?? 'Most recent observed run ended early.' : null)

  const knownCameras = snap.system?.caps.cameras
  const cameras = (['upper', 'lower'] as const).filter(c => !knownCameras || knownCameras.includes(c)).map((camera) => {
    const last = store.captures.list(camera, 1)[0]
    const age = last ? now.getTime() - Date.parse(last.ts) : null
    const state = settings.captureIntervalMin <= 0
      ? 'off'
      : !snap.online
          ? 'unknown'
          : age === null
            ? 'missing'
            : !Number.isFinite(age) || age < 0 ? 'unknown' : age > settings.captureIntervalMin * 120_000 ? 'quiet' : 'recent'
    return { camera, state, lastPhotoAt: last?.ts ?? null } as const
  })
  const due = chores(store, snap, now, 'all', drop)
    .filter(c => c.state === 'due' || (c.state === 'soon' && c.dueAt === null) || (c.dueAt && Date.parse(c.dueAt) <= until.getTime()))
    .map(({ title, dueAt, state, basis, reason }) => ({ title, dueAt, state, basis, reason }))
  const review: string[] = []
  const unknown: string[] = []
  if (!snap.online) unknown.push('The hardware daemon is offline.')
  if (lastProblem) review.push('Watering needs attention: ' + lastProblem)
  if (active.some(a => a.kind === 'water_low')) review.push('There is an active water-level warning.')
  if (!enabled) review.push('No watering schedule is enabled.')
  if (!completed) unknown.push('No completed pump run was confirmed in the last 14 days.')
  if (hoursToTarget === null) unknown.push(reason)
  else if (hoursToTarget * HOUR <= until.getTime() - now.getTime()) review.push('Check or top off the tank before leaving.')
  for (const c of cameras) {
    if (c.state === 'quiet' || c.state === 'missing') review.push('Check the ' + c.camera + ' camera.')
    if (c.state === 'unknown') unknown.push('The ' + c.camera + ' camera could not be verified.')
  }
  if (due.length) review.push('Review the listed chores for this trip.')
  return {
    checkedAt: now.toISOString(), until: until.toISOString(), state: review.length ? 'review' : unknown.length ? 'unknown' : 'ready',
    tank: { levelPct: level, readingAt: reading?.ts ?? null, targetPct: TANK_MIN_PCT, hoursToTarget, dropPerDay: drop, reason },
    watering: { enabled, lastCompleted: completed && completed.endedAt ? { at: completed.endedAt, durationS: completed.durationS, source: completed.source } : null, lastProblem },
    cameras, chores: due, checks: [...review, ...unknown],
  }
}
