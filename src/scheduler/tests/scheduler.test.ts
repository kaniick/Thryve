import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActuatorState } from '../../hardware/contract'
import { HalRefused, SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { LightArbiter } from '../../control/light'
import { MemoryStore } from '../../store/memory'
import { lightLevelAt, MISSED_ALERT, PUMP_RETRIES, refusalReason, Scheduler } from '../scheduler'
import { dayEnabled, localTime, minuteToHHMM, zoneAbbr } from '../time'

afterEach(() => vi.restoreAllMocks())

describe('lightLevelAt', () => {
  const curve = { setpoints: [{ minute: 360, level: 0 }, { minute: 420, level: 80 }, { minute: 1200, level: 80 }, { minute: 1260, level: 0 }] }
  it('interpolates ramps', () => {
    expect(lightLevelAt(curve, 360)).toBe(0)
    expect(lightLevelAt(curve, 390)).toBe(40)
    expect(lightLevelAt(curve, 420)).toBe(80)
    expect(lightLevelAt(curve, 800)).toBe(80)
    expect(lightLevelAt(curve, 1230)).toBe(40)
  })
  it('wraps across midnight using the last → first segment', () => {
    expect(lightLevelAt(curve, 1300)).toBe(0)
    expect(lightLevelAt(curve, 100)).toBe(0)
    const night = { setpoints: [{ minute: 1380, level: 100 }, { minute: 60, level: 0 }] }
    // 23:00 → 01:00 ramps 100 → 0; at 00:00 we are halfway.
    expect(lightLevelAt(night, 0)).toBe(50)
  })
  it('handles empty and single-point curves', () => {
    expect(lightLevelAt({ setpoints: [] }, 100)).toBeNull()
    expect(lightLevelAt({ setpoints: [{ minute: 0, level: 33 }] }, 999)).toBe(33)
  })
})

describe('time helpers', () => {
  it('converts to the zone and weekday bitmask', () => {
    const lt = localTime(new Date('2026-10-31T07:30:00Z'), 'America/Los_Angeles') // Sat 00:30 PDT
    expect(lt).toEqual({ date: '2026-10-31', minute: 30, weekday: 5 })
    expect(dayEnabled(0b0100000, 5)).toBe(true)
    expect(dayEnabled(0b0011111, 5)).toBe(false)
    expect(minuteToHHMM(1439)).toBe('23:59')
  })
  it('falls back to UTC on a bad zone', () => {
    expect(localTime(new Date('2026-01-01T12:00:00Z'), 'Not/AZone').minute).toBe(720)
    expect(zoneAbbr(new Date('2026-01-01T12:00:00Z'), 'Not/AZone')).toBe('UTC')
  })
  it('names the zone as a clock does, daylight time included', () => {
    expect(zoneAbbr(new Date('2026-11-10T14:00:00Z'), 'America/Los_Angeles')).toBe('PST')
    expect(zoneAbbr(new Date('2026-07-10T14:00:00Z'), 'America/Los_Angeles')).toBe('PDT')
    expect(zoneAbbr(new Date('2026-11-10T14:00:00Z'), 'UTC')).toBe('UTC')
  })
})

describe('Scheduler', () => {
  function setup(nowIso: string, waterLowCm = 16) {
    const store = new MemoryStore()
    store.settings.update({ timezone: 'UTC' })
    const hal = new SimHal({ tickMs: 0, limits: { waterLowCm } })
    const events = createEventBus()
    let now = new Date(nowIso)
    const s = new Scheduler({ store, hal, events, now: () => now })
    return { store, hal, events, s, setNow: (iso: string) => (now = new Date(iso)) }
  }

  it('applies the light curve and only re-sends on change', async () => {
    const { store, hal, s, setNow } = setup('2026-10-31T07:00:00Z')
    store.schedules.upsert({ id: 'l', kind: 'light', name: 'day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 0 }, { minute: 480, level: 60 }] } })
    let sets = 0
    hal.subscribe(e => e.type === 'actuator' && e.id === 'light' && sets++)
    await s.tick()
    expect(hal.snapshot().actuators.light).toMatchObject({ on: true, level: 30 })
    await s.tick()
    expect(sets).toBe(1)
    setNow('2026-10-31T08:00:00Z')
    await s.tick()
    expect(hal.snapshot().actuators.light?.level).toBe(60)
    expect(sets).toBe(2)
  })

  it('hands the curve to the light arbiter, which lets a manual hold win until it ends', async () => {
    const store = new MemoryStore()
    store.settings.update({ timezone: 'UTC' })
    const hal = new SimHal({ tickMs: 0 })
    let now = new Date('2026-10-31T07:00:00Z')
    const light = new LightArbiter({ hal, now: () => now.getTime(), holdMs: 30 * 60_000 })
    const s = new Scheduler({ store, hal, events: createEventBus(), light, now: () => now })
    store.schedules.upsert({ id: 'l', kind: 'light', name: 'day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 0 }, { minute: 480, level: 60 }] } })
    expect((await s.tick()).lightTarget).toBe(30)
    await light.idle()
    expect(hal.snapshot().actuators.light?.level).toBe(30)
    await light.setManual(100)
    now = new Date('2026-10-31T07:20:00Z')
    await s.tick()
    await light.idle()
    expect(hal.snapshot().actuators.light?.level).toBe(100)
    now = new Date('2026-10-31T07:40:00Z')
    await s.tick()
    await light.idle()
    // The hold is over: the light lands on the curve's current point, not the one it skipped.
    expect(hal.snapshot().actuators.light?.level).toBe(50)
    light.close()
  })

  it('fires a pump schedule exactly once per minute-of-day, bounded by the HAL', async () => {
    const { store, hal, s } = setup('2026-10-31T08:00:30Z')
    store.schedules.upsert({ id: 'p', kind: 'pump', name: 'morning', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })
    const r1 = await s.tick()
    expect(r1.pumpFired).toEqual(['p'])
    expect(hal.snapshot().actuators.pump).toMatchObject({ on: true, remainingS: 300 })
    const r2 = await s.tick()
    expect(r2.pumpFired).toEqual([])
    expect(store.schedules.recentRuns()).toHaveLength(1)
  })

  it('holds a pump slot while the clock can\'t be believed, and doesn\'t use it up', async () => {
    const { store, hal } = setup('2026-10-31T08:00:30Z')
    store.schedules.upsert({ id: 'p', kind: 'pump', name: 'morning', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })
    let trusted = false
    const logs: string[] = []
    const s = new Scheduler({ store, hal, events: createEventBus(), now: () => new Date('2026-10-31T08:00:30Z'), clockTrusted: () => trusted, log: m => logs.push(m) })
    expect((await s.tick()).pumpFired).toEqual([])
    expect(store.schedules.recentRuns()).toHaveLength(0)
    expect(logs.join()).toContain('the clock isn\'t set yet')
    trusted = true
    expect((await s.tick()).pumpFired).toEqual(['p'])
  })

  it('respects the day mask and disabled flag', async () => {
    const { store, s } = setup('2026-10-31T08:00:00Z') // Saturday → bit 5
    store.schedules.upsert({ id: 'wk', kind: 'pump', name: 'weekdays', enabled: true, days: 0b0011111, spec: { minute: 480, durationS: 60 } })
    store.schedules.upsert({ id: 'off', kind: 'pump', name: 'off', enabled: false, days: 127, spec: { minute: 480, durationS: 60 } })
    expect((await s.tick()).pumpFired).toEqual([])
  })

  it('records a refused pump run without throwing', async () => {
    const { store, hal, s } = setup('2026-10-31T08:00:00Z', 8)
    store.schedules.upsert({ id: 'p', kind: 'pump', name: 'm', enabled: true, days: 127, spec: { minute: 480, durationS: 60 } })
    // drain the sim tank to trip the interlock
    await hal.setActuator('pump', { on: true, level: 30, durationS: 900 })
    for (let i = 0; i < 60; i++) hal.tick(60)
    await hal.acknowledgeAlert('pump_fault')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = await s.tick()
    expect(r.pumpFired).toEqual([])
    expect(store.schedules.recentRuns()[0]?.result).toBe('refused: water level low (dry-run interlock)')
  })
})

describe('Scheduler: a refused pump run is tried again', () => {
  const off: ActuatorState = { on: false, level: 0, since: '2026-11-16T08:00:00Z', fault: null, remainingS: null }
  const onState: ActuatorState = { on: true, level: 30, since: '2026-11-16T08:00:00Z', fault: null, remainingS: 300 }

  /** Monday 2026-11-16 08:00:30 UTC, a weekly Mon 08:00 run, and a HAL whose answers are scripted. */
  function rig() {
    const store = new MemoryStore()
    store.settings.update({ timezone: 'UTC' })
    const hal = new SimHal({ tickMs: 0 })
    const events = createEventBus()
    const emitted: string[] = []
    events.subscribe(e => e.kind === 'mutation' && emitted.push(e.path))
    let at = Date.parse('2026-11-16T08:00:30Z')
    let trusted = true
    const s = new Scheduler({ store, hal, events, now: () => new Date(at), clockTrusted: () => trusted })
    store.schedules.upsert({ id: 'mon', kind: 'pump', name: 'Monday water', enabled: true, days: 0b0000001, spec: { minute: 480, durationS: 300 } })
    const set = vi.spyOn(hal, 'setActuator')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const missed = () => store.alerts.list({ activeOnly: true }).filter(a => a.kind === MISSED_ALERT)
    return { store, hal, s, set, warn, emitted, missed, minutes: (n: number) => (at += n * 60_000), untrust: (v: boolean) => (trusted = !v) }
  }

  it('retries a minute later and stops once hald accepts, on the third minute', async () => {
    const r = rig()
    r.set.mockRejectedValueOnce(new HalRefused('refused: water level low (dry-run interlock)'))
      .mockResolvedValueOnce(off)
      .mockResolvedValueOnce(onState)
    expect((await r.s.tick()).pumpFired).toEqual([])
    expect(r.store.schedules.recentRuns()[0]?.result).toBe('refused: water level low (dry-run interlock)')
    // Ticks inside the same minute don't retry.
    expect((await r.s.tick()).pumpFired).toEqual([])
    expect(r.set).toHaveBeenCalledTimes(1)
    r.minutes(1)
    expect((await r.s.tick()).pumpFired).toEqual([])
    // A start refused on the tank level comes back as the pump's state, off with no fault.
    expect(r.store.schedules.recentRuns()[0]?.result).toBe('refused: the unit refused the start')
    r.minutes(1)
    expect((await r.s.tick()).pumpFired).toEqual(['mon'])
    expect(r.store.schedules.recentRuns()).toEqual([expect.objectContaining({ key: 'mon:2026-11-16:480', result: 'fired' })])
    r.minutes(1)
    expect((await r.s.tick()).pumpFired).toEqual([])
    expect(r.set).toHaveBeenCalledTimes(3)
    // Every try goes through the HAL's pump command, so hald's guard decides each one.
    for (const call of r.set.mock.calls) expect(call).toEqual(['pump', { on: true, level: undefined, durationS: 300 }])
    expect(r.warn).toHaveBeenCalledTimes(2)
    expect(String(r.warn.mock.calls[0]?.[0])).toBe('pump schedule Monday water (08:00) refused on try 1: water level low (dry-run interlock); trying again in a minute (15 left)')
    expect(r.missed()).toHaveLength(0)
  })

  it(`raises one alert when the first try and all ${PUMP_RETRIES} retries are refused, and the next run clears it`, async () => {
    const r = rig()
    r.set.mockRejectedValue(new HalRefused('refused: water level low (dry-run interlock)'))
    await r.s.tick()
    for (let i = 0; i < PUMP_RETRIES; i++) {
      r.minutes(1)
      await r.s.tick()
    }
    expect(r.set).toHaveBeenCalledTimes(PUMP_RETRIES + 1)
    expect(r.missed()).toHaveLength(1)
    expect(r.missed()[0]?.detail).toBe('Scheduled watering at 08:00 didn\'t run: the pump was refused 16 times, through 08:15. Last reason: water level low (dry-run interlock).')
    expect(String(r.warn.mock.calls.at(-1)?.[0])).toMatch(/refused on try 16: .*; giving up$/)
    expect(r.emitted).toEqual([`alerts.${MISSED_ALERT}`])
    // It gives up: no more tries, and no second alert.
    for (let i = 0; i < 5; i++) {
      r.minutes(1)
      await r.s.tick()
    }
    expect(r.set).toHaveBeenCalledTimes(PUMP_RETRIES + 1)
    expect(r.store.alerts.list().filter(a => a.kind === MISSED_ALERT)).toHaveLength(1)
    // A week on, the run fires and the alert clears.
    r.set.mockReset().mockResolvedValue(onState)
    r.minutes(7 * 1440 - 20)
    expect((await r.s.tick()).pumpFired).toEqual(['mon'])
    expect(r.missed()).toHaveLength(0)
    expect(r.emitted).toEqual([`alerts.${MISSED_ALERT}`, `alerts.${MISSED_ALERT}`])
    expect(r.store.schedules.recentRuns().map(x => x.result)).toEqual(['fired', 'refused: water level low (dry-run interlock)'])
  })

  it('gives way to the schedule\'s next run, and drops a schedule that was turned off', async () => {
    const r = rig()
    r.set.mockResolvedValue(off)
    r.store.schedules.upsert({ id: 'daily', kind: 'pump', name: 'Daily', enabled: true, days: 127, spec: { minute: 600, durationS: 60 } })
    await r.s.tick()
    // The schedule moves two minutes on while it's being retried: that run is its next one.
    r.store.schedules.upsert({ id: 'mon', kind: 'pump', name: 'Monday water', enabled: true, days: 0b0000001, spec: { minute: 482, durationS: 300 } })
    r.minutes(1)
    await r.s.tick()
    r.set.mockClear()
    r.minutes(1)
    await r.s.tick()
    expect(r.set).toHaveBeenCalledTimes(1)
    expect(r.store.schedules.recentRuns().map(x => x.key)).toEqual(['mon:2026-11-16:482', 'mon:2026-11-16:480'])
    // Turned off while it's retried: no more tries.
    r.store.schedules.upsert({ id: 'mon', kind: 'pump', name: 'Monday water', enabled: false, days: 0b0000001, spec: { minute: 482, durationS: 300 } })
    r.minutes(1)
    await r.s.tick()
    expect(r.set).toHaveBeenCalledTimes(1)
  })

  it('drops the retries of a schedule that was deleted', async () => {
    const r = rig()
    r.set.mockResolvedValue(off)
    await r.s.tick()
    r.store.schedules.remove('mon')
    r.minutes(1)
    await r.s.tick()
    expect(r.set).toHaveBeenCalledTimes(1)
  })

  it('waits for the clock to be trusted again before a retry, without counting it', async () => {
    const r = rig()
    r.set.mockRejectedValueOnce(new Error('refused: board over temperature')).mockResolvedValueOnce(onState)
    await r.s.tick()
    r.untrust(true)
    r.minutes(1)
    expect((await r.s.tick()).pumpFired).toEqual([])
    expect(r.set).toHaveBeenCalledTimes(1)
    r.untrust(false)
    r.minutes(1)
    expect((await r.s.tick()).pumpFired).toEqual(['mon'])
  })

  it('a clock that isn\'t trusted still skips the slot without recording it', async () => {
    const r = rig()
    r.untrust(true)
    expect((await r.s.tick()).pumpFired).toEqual([])
    expect(r.set).not.toHaveBeenCalled()
    expect(r.store.schedules.recentRuns()).toHaveLength(0)
    r.minutes(1)
    await r.s.tick()
    expect(r.set).not.toHaveBeenCalled()
  })

  it('leaves a manual run alone: refused or not, nothing is recorded, retried or raised', async () => {
    const r = rig()
    r.minutes(30)
    r.set.mockRejectedValueOnce(new HalRefused('refused: water level low (dry-run interlock)'))
    await expect(r.hal.setActuator('pump', { on: true, durationS: 60 })).rejects.toThrow('water level low')
    for (let i = 0; i < 3; i++) {
      r.minutes(1)
      await r.s.tick()
    }
    expect(r.set).toHaveBeenCalledTimes(1)
    expect(r.store.schedules.recentRuns()).toHaveLength(0)
    expect(r.store.alerts.list()).toHaveLength(0)
    expect(r.warn).not.toHaveBeenCalled()
  })

  it('names why hald refused, from the error or from what core last heard', () => {
    const hal = new SimHal({ tickMs: 0 })
    const snap = hal.snapshot()
    expect(refusalReason(snap, new HalRefused('pump fault latched: dry-run; acknowledge before restarting'))).toBe('pump fault latched: dry-run; acknowledge before restarting')
    expect(refusalReason(snap, undefined, { on: false, level: 0, since: '', fault: 'over-temp', remainingS: null })).toBe('over-temp')
    const alert = (kind: 'water_low' | 'over_temp') => ({ kind, active: true, ts: '2026-11-16T08:00:00Z', detail: '' })
    expect(refusalReason({ ...snap, alerts: { water_low: alert('water_low') } })).toBe('water low')
    expect(refusalReason({ ...snap, alerts: { over_temp: alert('over_temp') } })).toBe('board over temperature')
    expect(refusalReason({ ...snap, sensors: {} })).toBe('tank level unavailable')
    const level = { ts: '2026-11-16T08:00:00Z', value: 9, unit: 'cm', quality: 'suspect' as const }
    expect(refusalReason({ ...snap, sensors: { water_distance: level } })).toBe('tank level unavailable')
    expect(refusalReason({ ...snap, alerts: {}, sensors: { water_distance: { ...level, quality: 'good' } } })).toBe('the unit refused the start')
  })
})
