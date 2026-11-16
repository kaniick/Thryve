import { describe, expect, it } from 'vitest'
import { classifyPumpAlert, edges, eventMatches, isTaskAlert, type EventSnapshot } from '../events'

function snap(p: Partial<EventSnapshot> = {}): EventSnapshot {
  return { alerts: new Map(), lightOn: false, pods: [], unhealthy: [], updateAvailable: false, halOnline: true, ...p }
}

describe('notification events', () => {
  it('classifies pump faults and task alerts', () => {
    expect(classifyPumpAlert('pump: dry-run: water below 16 cm')).toBe('dry_run')
    expect(classifyPumpAlert('pump: brown-out: supply fell to 10.2 V')).toBe('brown_out')
    expect(classifyPumpAlert('pump: over-current')).toBe('pump_fault')
    expect(isTaskAlert('chore_top_off')).toBe(true)
    expect(isTaskAlert('water_low')).toBe(false)
  })

  it('emits rising edges only after a previous snapshot', () => {
    expect(edges(null, snap({ alerts: new Map([['pump_fault', { detail: 'dry-run', active: true }]]) }))).toEqual([])
    const prev = snap()
    const next = snap({
      alerts: new Map([['pump_fault', { detail: 'pump: dry-run', active: true }]]),
      lightOn: true,
    })
    const ev = edges(prev, next).map(e => e.event)
    expect(ev).toEqual(expect.arrayContaining(['alert_raised', 'pump_fault', 'dry_run', 'light_on']))
  })

  it('fires unit online when the daemon comes back, and filters alert kinds', () => {
    const prev = snap({ alerts: new Map([['hal_offline', { detail: 'unreachable', active: true }]]), halOnline: false })
    const next = snap({ halOnline: true })
    const ev = edges(prev, next)
    expect(ev.map(e => e.event)).toEqual(expect.arrayContaining(['alert_cleared', 'unit_online']))
    expect(eventMatches({ event: 'alert_raised', alertKind: 'water_low' }, { event: 'alert_raised', key: 'x', alert: { kind: 'pump_fault', detail: '' } })).toBe(false)
    expect(eventMatches({ event: 'alert_raised', alertKind: 'water_low' }, { event: 'alert_raised', key: 'x', alert: { kind: 'water_low', detail: '' } })).toBe(true)
  })
})
