
import { FOLLOW_ALERT } from '../care/follow'
import { pumpFault } from '../lib/pumpFault'
import type { NotifyEvent } from './types'

/** Care / chore alert kinds that count as a due task. */
const TASK_KINDS = /^(chore_|reminder_|care_|setup_)/
const KNOWN_TASK = new Set(['chore_top_off', 'chore_feed', 'chore_thin', 'follow_change'])

export function isTaskAlert(kind: string): boolean {
  return KNOWN_TASK.has(kind) || TASK_KINDS.test(kind)
}

export function classifyPumpAlert(detail: string): 'dry_run' | 'brown_out' | 'pump_fault' {
  const { reason } = pumpFault(detail)
  const r = reason.toLowerCase()
  if (r.includes('brown-out') || r.includes('brown_out') || r.includes('brownout')) return 'brown_out'
  if (r.includes('dry-run') || r.includes('dry_run') || r.includes('dry run')) return 'dry_run'
  return 'pump_fault'
}

export const EVENT_LABELS: Record<NotifyEvent, string> = {
  pump_fault: 'Pump fault',
  dry_run: 'Pump dry-run',
  brown_out: 'Pump brown-out',
  alert_raised: 'Alert raised',
  alert_cleared: 'Alert cleared',
  pod_attention: 'Pod needs attention',
  pod_harvest: 'Pod ready to harvest',
  task_due: 'Task due',
  light_on: 'Light on',
  light_off: 'Light off',
  update_available: 'Update available',
  unit_offline: 'Unit offline',
  unit_online: 'Unit back online',
  analysis_finding: 'Camera / analysis finding',
}

export interface FiredEvent {
  event: NotifyEvent
  key: string
  alert?: { kind: string, detail: string }
  pod?: { slot: number, plant: string | null, status: string }
  update?: { tag?: string }
}

export interface EventSnapshot {
  alerts: Map<string, { id?: number, detail: string, active: boolean }>
  lightOn: boolean
  pods: Array<{ slot: number, plant: string | null, status: string }>
  unhealthy: Array<{ slot: number, plant: string | null, status: string }>
  updateAvailable: boolean
  updateTag?: string
  halOnline: boolean
}

/** Rising / falling edges between two snapshots. First tick with no previous snapshot fires nothing. */
export function edges(prev: EventSnapshot | null, next: EventSnapshot): FiredEvent[] {
  if (!prev) return []
  const out: FiredEvent[] = []

  for (const [kind, row] of next.alerts) {
    const was = prev.alerts.get(kind)
    // The previous watering move is replaced in one synchronous operation.
    // A new row is a fresh notice even when no snapshot saw the old one close.
    const wateringMove = kind === FOLLOW_ALERT && row.id !== undefined
    if (row.active && (!was?.active || (wateringMove && was.id !== row.id))) {
      const incident = wateringMove ? `${kind}:${row.id}` : kind
      out.push({ event: 'alert_raised', key: `alert_raised:${incident}`, alert: { kind, detail: row.detail } })
      if (kind === 'pump_fault') {
        out.push({ event: 'pump_fault', key: `pump_fault:${kind}`, alert: { kind, detail: row.detail } })
        const ev = classifyPumpAlert(row.detail)
        if (ev !== 'pump_fault') out.push({ event: ev, key: `${ev}:${kind}`, alert: { kind, detail: row.detail } })
      }
      if (kind === 'hal_offline') out.push({ event: 'unit_offline', key: 'unit_offline', alert: { kind, detail: row.detail } })
      if (isTaskAlert(kind)) out.push({ event: 'task_due', key: `task_due:${kind}`, alert: { kind, detail: row.detail } })
    }
    if (!row.active && was?.active) {
      out.push({ event: 'alert_cleared', key: `alert_cleared:${kind}`, alert: { kind, detail: was.detail } })
      if (kind === 'hal_offline') out.push({ event: 'unit_online', key: 'unit_online', alert: { kind, detail: was.detail } })
    }
  }
  for (const [kind, was] of prev.alerts) {
    if (was.active && !next.alerts.has(kind)) {
      out.push({ event: 'alert_cleared', key: `alert_cleared:${kind}`, alert: { kind, detail: was.detail } })
      if (kind === 'hal_offline') out.push({ event: 'unit_online', key: 'unit_online', alert: { kind, detail: was.detail } })
    }
  }

  if (next.lightOn && !prev.lightOn) out.push({ event: 'light_on', key: 'light_on' })
  if (!next.lightOn && prev.lightOn) out.push({ event: 'light_off', key: 'light_off' })

  const prevPod = new Map(prev.pods.map(p => [p.slot, p]))
  for (const p of next.pods) {
    const was = prevPod.get(p.slot)
    if (p.status === 'attention' && was?.status !== 'attention') {
      out.push({ event: 'pod_attention', key: `pod_attention:${p.slot}`, pod: p })
    }
    if (p.status === 'harvest' && was?.status !== 'harvest') {
      out.push({ event: 'pod_harvest', key: `pod_harvest:${p.slot}`, pod: p })
    }
  }

  const prevUnhealthy = new Set(prev.unhealthy.map(p => p.slot))
  for (const p of next.unhealthy) {
    if (!prevUnhealthy.has(p.slot)) out.push({ event: 'analysis_finding', key: `analysis_finding:${p.slot}`, pod: p })
  }

  if (next.updateAvailable && !prev.updateAvailable) {
    out.push({ event: 'update_available', key: `update_available:${next.updateTag ?? 'yes'}`, update: { tag: next.updateTag } })
  }

  if (next.halOnline && !prev.halOnline) out.push({ event: 'unit_online', key: 'unit_online' })
  if (!next.halOnline && prev.halOnline) out.push({ event: 'unit_offline', key: 'unit_offline' })

  return out
}

export function eventMatches(trigger: { event: NotifyEvent, alertKind?: string }, fired: FiredEvent): boolean {
  if (trigger.event !== fired.event) return false
  if (trigger.alertKind && fired.alert?.kind !== trigger.alertKind) return false
  return true
}
