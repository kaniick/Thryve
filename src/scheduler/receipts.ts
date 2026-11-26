import type { LightSource } from '../control/light'
import type { HalSnapshot } from '../hardware/types'
import type { PumpRun, ScheduleRun } from '../store/types'

export const PUMP_OUTCOMES = ['completed', 'stopped-early', 'stopped-with-fault', 'start-observed', 'stop-observed', 'retrying', 'refused', 'unconfirmed'] as const
export const LIGHT_OUTCOMES = ['matched', 'held', 'not-matched', 'unconfirmed', 'no-target'] as const
export interface LightReceipt {
  at: string
  target: number | null
  reported: number | null
  outcome: typeof LIGHT_OUTCOMES[number]
  source: LightSource
  fault: string | null
}

export function readLightReceipt(at: string, target: number | null, source: LightSource, snap: HalSnapshot): LightReceipt {
  const state = snap.online ? snap.actuators.light : undefined
  const reported = state ? (state.on ? state.level : 0) : null
  const fault = state?.fault ?? null
  const held = source === 'manual' || source === 'autopilot'
  let outcome: LightReceipt['outcome'] = 'matched'
  if (target === null) outcome = 'no-target'
  else if (held) outcome = 'held'
  else if (reported === null) outcome = 'unconfirmed'
  else if (fault || Math.abs(reported - target) >= 0.5) outcome = 'not-matched'
  return { at, target, reported, outcome, source, fault }
}

export function pumpReceipt(run: ScheduleRun, name: string, history: PumpRun[], retrying: boolean) {
  const base = { key: run.key, at: run.firedAt, name, reportedStart: null, durationS: null, fault: null }
  if (run.result.startsWith('refused')) {
    return { ...base, outcome: retrying ? 'retrying' as const : 'refused' as const, reason: run.result.replace(/^refused:\s*/i, '') }
  }
  // The recorder attributes starts only when it sees a matching schedule
  // within ten seconds. Don't borrow a manual run or guess after a retry.
  const at = Date.parse(run.firedAt)
  const candidates = history.filter(r => r.source === 'scheduled' && r.scheduleId === run.scheduleId && Math.abs(Date.parse(r.startedAt) - at) <= 10_000)
  const match = candidates.length === 1 ? candidates[0] : undefined
  if (!match) {
    return { ...base, outcome: 'unconfirmed' as const, reason: run.result === 'fired' ? 'Core accepted the run, but no matching pump event was recorded.' : 'No matching pump event was recorded.' }
  }
  const timing = { reportedStart: match.startedAt, durationS: match.endedAt ? match.durationS : null, fault: match.fault, reason: null }
  if (!match.endedAt) return { ...base, ...timing, outcome: 'start-observed' as const }
  if (match.fault) return { ...base, ...timing, outcome: 'stopped-with-fault' as const }
  // Allow one second of timestamp granularity at the HAL boundary.
  if (match.scheduledDurationS === null) return { ...base, ...timing, outcome: 'stop-observed' as const }
  if (match.durationS + 1 < match.scheduledDurationS) return { ...base, ...timing, outcome: 'stopped-early' as const }
  return { ...base, ...timing, outcome: 'completed' as const }
}
