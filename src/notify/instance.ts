/**
 * Production wiring for the notification engine: live signals, event snapshots,
 * HTTP providers, and the run log. The engine itself stays free of I/O.
 */
import { liveSignals } from '../autopilot/signals'
import type { DayOfWeek } from '../autopilot/types'
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import { localTime } from '../scheduler/time'
import type { Store } from '../store/types'
import type { UpdateClient } from '../update/client'
import { NotifyEngine } from './engine'
import type { EventSnapshot } from './events'
import type { IosService } from './ios/service'
import type { HttpFetch } from './providers'

const DAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const RUN_RETENTION_DAYS = 30

export function createNotifier(o: {
  hal: HalClient
  store: Store
  events: EventBus
  now?: () => Date
  update?: UpdateClient | null
  log?: (m: string) => void
  fetch?: HttpFetch
  ios?: IosService | null
}): NotifyEngine {
  const now = () => o.now?.() ?? new Date()
  let lastPrune = 0

  const engine = new NotifyEngine({
    now: () => now().getTime(),
    clock: () => {
      const lt = localTime(now(), o.store.settings.get().timezone)
      return { nowMinutes: lt.minute, dayOfWeek: DAYS[lt.weekday] ?? 'monday', dateKey: lt.date }
    },
    signals: () => liveSignals(o.hal.snapshot(), o.store, now(), o.store.pods.list().map(p => p.slot)),
    snapshot: () => eventSnapshot(o.hal, o.store, o.update ?? null),
    loadRules: () => o.store.notifications.rules.list(),
    loadChannels: () => o.store.notifications.channels.list(),
    recordRun: (ruleId, outcome, detail) => {
      const ts = now()
      o.store.notifications.runs.add({ ruleId, firedAt: ts.toISOString(), outcome, detail })
      if (ts.getTime() - lastPrune > 3_600_000) {
        lastPrune = ts.getTime()
        o.store.notifications.runs.prune(new Date(ts.getTime() - RUN_RETENTION_DAYS * 86_400_000).toISOString())
      }
    },
    enabled: () => o.store.settings.get().notificationsEnabled,
    globalQuietHours: () => {
      const s = o.store.settings.get()
      if (!s.notifyQuietStart || !s.notifyQuietEnd) return null
      return { start: s.notifyQuietStart, end: s.notifyQuietEnd }
    },
    unitName: () => o.store.settings.get().unitName,
    changed: () => o.events.emit({ kind: 'mutation', path: 'notifications' }),
    log: o.log,
    fetch: o.fetch,
    ios: o.ios,
  })

  o.events.subscribe((e) => {
    if (e.kind === 'hal') void engine.tick()
    if (e.kind === 'mutation' && /^(alerts|grow|settings|captures|analysis|update)/.test(e.path)) void engine.tick()
    if (e.kind === 'update') void engine.tick()
  })

  return engine
}

export function eventSnapshot(hal: HalClient, store: Store, update: UpdateClient | null): EventSnapshot {
  const snap = hal.snapshot()
  const alerts: EventSnapshot['alerts'] = new Map()
  for (const a of store.alerts.list({ activeOnly: true })) alerts.set(a.kind, { id: a.id, detail: a.detail, active: true })
  const light = snap.actuators.light
  const pods = store.pods.list().map(p => ({ slot: p.slot, plant: p.plant, status: p.status }))
  const unhealthy = labelsUnhealthy(store).map((slot) => {
    const p = pods.find(x => x.slot === slot)
    return { slot, plant: p?.plant ?? null, status: p?.status ?? 'empty' }
  })
  const check = update?.lastCheck() ?? null
  return {
    alerts,
    lightOn: !!(light && (light.on || (light.level ?? 0) > 0)),
    pods,
    unhealthy,
    updateAvailable: !!check?.updateAvailable,
    updateTag: check?.available?.tag,
    halOnline: snap.online !== false,
  }
}

function labelsUnhealthy(store: Store): number[] {
  const ts = new Date().toISOString()
  return store.podLabels.lastBefore(ts).filter(l => l.label === 'unhealthy').map(l => l.slot)
}
