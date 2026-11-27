import { z } from 'zod'
import { pumpReceipt } from '../scheduler/receipts'
import type { Store } from '../store/types'

export const ACTIVITY_KINDS = ['watering', 'lighting', 'tank', 'camera', 'restart', 'observer'] as const
export const ActivityEntry = z.object({
  key: z.string(),
  at: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  title: z.string(),
  detail: z.string(),
  attention: z.boolean(),
})
export type ActivityEntry = z.infer<typeof ActivityEntry>

const tanks = new Set(['water_low', 'setup_water_sensor', 'pump_fault', 'dose_fault', 'tank_sensor_fault'])
const cameras = new Set(['camera_missing', 'camera_upper_missing', 'camera_lower_missing'])
const reason = (value: string) => value.replaceAll('-', ' ')
const stamp = (ts: string) => {
  const time = Date.parse(ts)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}
export const latestFirst = (a: ActivityEntry, b: ActivityEntry) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key)

export function activity(store: Store, now: Date, days: number, bootLog: string | null, restartAttempts: Array<{ camera: string, ts: string, ok: boolean }> = [], retrying: string[] = []): ActivityEntry[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const until = now.toISOString()
  const entries: ActivityEntry[] = []
  const add = (entry: ActivityEntry) => {
    const at = stamp(entry.at)
    if (at && at >= since && at <= until) entries.push({ ...entry, at })
  }
  const runs = store.schedules.recentRuns(100)
  const names = new Map(store.schedules.list().map(s => [s.id, s.name]))
  const attempts = new Map<string, ReturnType<Store['diagnostics']['attempts']>>()
  for (const attempt of store.diagnostics.attempts(runs.map(r => r.key))) {
    const group = attempts.get(attempt.runKey) ?? []
    group.push(attempt)
    attempts.set(attempt.runKey, group)
  }
  const pumpRuns = store.pumpRuns.list({ from: since, limit: 200 })
  const correlated = new Set<string>()
  for (const run of runs) {
    const receipt = pumpReceipt(run, names.get(run.scheduleId) ?? run.scheduleId, pumpRuns, retrying.includes(run.key), attempts.get(run.key))
    if (receipt.reportedStart) correlated.add(receipt.reportedStart)
    add({
      key: 'schedule:' + run.key, at: receipt.at, kind: 'watering', title: receipt.name + ' · ' + reason(receipt.outcome),
      detail: [receipt.fault ?? receipt.reason, receipt.durationS === null ? null : receipt.durationS + ' s reported', receipt.attempts.length ? receipt.attempts.length + ' attempt(s)' : null].filter(Boolean).join(' · '),
      attention: !['completed', 'start-observed', 'stop-observed'].includes(receipt.outcome),
    })
    if (receipt.attempts.length > 1) {
      for (const attempt of receipt.attempts) add({
        key: 'attempt:' + run.key + ':' + attempt.attempt, at: attempt.at, kind: 'watering',
        title: receipt.name + ' · attempt ' + attempt.attempt + ' ' + attempt.result,
        detail: attempt.reason ?? 'Pump command accepted by HAL.', attention: attempt.result === 'refused',
      })
    }
  }
  for (const run of pumpRuns) {
    if (correlated.has(run.startedAt)) continue
    add({ key: 'pump:' + run.id, at: run.endedAt ?? run.startedAt, kind: 'watering', title: (run.source === 'manual' ? 'Manual watering' : 'Unpaired pump event') + (run.endedAt ? ' · stopped' : ' · started'),
      detail: run.fault ?? (run.endedAt ? run.durationS + ' s reported' : 'Pump start reported by HAL.'), attention: run.fault !== null })
  }
  for (const [i, l] of store.diagnostics.lights(256).entries()) add({
    key: 'light:' + l.at + ':' + i, at: l.at, kind: 'lighting', title: 'Lights · ' + reason(l.outcome),
    detail: [l.target === null ? 'no target' : 'target ' + l.target + '%', l.reported === null ? 'no hardware report' : 'reported ' + l.reported + '%', l.source, l.fault].filter(Boolean).join(' · '),
    attention: !!l.fault || l.outcome === 'not-matched' || l.outcome === 'unconfirmed',
  })
  for (const a of store.alerts.list({ limit: 200 })) {
    const kind = tanks.has(a.kind) ? 'tank' : cameras.has(a.kind) ? 'camera' : a.kind === 'hal_offline' ? 'restart' : null
    if (!kind) continue
    const name = a.kind.replaceAll('_', ' ')
    add({ key: 'alert:' + a.id, at: a.raisedAt, kind, title: name + ' · raised', detail: a.detail.slice(0, 240), attention: true })
    if (a.clearedAt) add({ key: 'clear:' + a.id, at: a.clearedAt, kind, title: name + ' · cleared', detail: '', attention: false })
  }
  for (const f of store.diagnostics.frameProblems(since, 100)) add({
    key: 'frame:' + f.captureId, at: f.ts, kind: 'camera', title: f.camera + ' camera · ' + reason(f.check),
    detail: 'Recorded result for this photo.', attention: ['failed', 'damaged', 'unreadable'].includes(f.check),
  })
  for (const [i, a] of restartAttempts.entries()) add({
    key: 'usb:' + a.camera + ':' + a.ts + ':' + i, at: a.ts, kind: 'camera',
    title: a.camera + ' camera · USB restart ' + (a.ok ? 'reported' : 'failed'), detail: '', attention: !a.ok,
  })
  for (const [i, b] of store.diagnostics.coreStarts(100).entries()) add({
    key: 'core:' + b.at + ':' + i, at: b.at, kind: 'restart', title: 'Core started', detail: b.version, attention: false,
  })
  for (const [i, line] of (bootLog ?? '').trim().split('\n').slice(-100).entries()) {
    const at = line.split(' ')[0] ?? ''
    if (!line.includes(' clock=synced ')) continue
    const hub = /\bhub=([01])\b/.exec(line)?.[1]
    add({ key: 'boot:' + at + ':' + i, at, kind: 'restart', title: 'Gateway boot logged',
      detail: hub === '1' ? 'USB hub detected.' : hub === '0' ? 'USB hub not detected when logged.' : '', attention: hub === '0' })
  }
  return entries.sort(latestFirst)
}
