import { describe, expect, it, vi } from 'vitest'
import { HalRefused, SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import type { PumpRun, ScheduleRun } from '../../store/types'
import { createCore } from '../../server/bootstrap'
import { createCallerFactory } from '../../server/trpc'
import { appRouter } from '../../server/routers/app'
import { pumpReceipt, readLightReceipt } from '../receipts'

const at = '2026-11-26T16:00:00.000Z'
const run: ScheduleRun = { scheduleId: 'am', key: 'scheduled-1', firedAt: at, result: 'fired' }
const seen: PumpRun = {
  id: 1, startedAt: '2026-11-26T16:00:01.000Z', endedAt: '2026-11-26T16:00:16.000Z',
  level: 100, durationS: 15, source: 'scheduled', scheduleId: 'am', scheduledDurationS: 15, fault: null,
}

describe('schedule receipts', () => {
  it('does not mistake a command, a manual run or ambiguous events for completed watering', () => {
    expect(pumpReceipt(run, 'Morning', [], false)).toMatchObject({ outcome: 'unconfirmed' })
    expect(pumpReceipt(run, 'Morning', [{ ...seen, source: 'manual' }], false)).toMatchObject({ outcome: 'unconfirmed' })
    expect(pumpReceipt(run, 'Morning', [seen, { ...seen, id: 2 }], false)).toMatchObject({ outcome: 'unconfirmed' })
    expect(pumpReceipt(run, 'Morning', [{ ...seen, startedAt: '2026-11-26T16:01:00.000Z' }], false)).toMatchObject({ outcome: 'unconfirmed' })
    expect(pumpReceipt(run, 'Morning', [seen], false)).toMatchObject({ outcome: 'completed', durationS: 15, reportedStart: seen.startedAt })
  })

  it('distinguishes a retry, a refusal, an unended start, and early or fault stops', () => {
    const refused = { ...run, result: 'refused: tank level unavailable' }
    expect(pumpReceipt(refused, 'Morning', [seen], true)).toMatchObject({ outcome: 'retrying', reason: 'tank level unavailable', reportedStart: null })
    expect(pumpReceipt(refused, 'Morning', [seen], false)).toMatchObject({ outcome: 'refused' })
    expect(pumpReceipt(run, 'Morning', [{ ...seen, endedAt: null }], false)).toMatchObject({ outcome: 'start-observed', durationS: null })
    expect(pumpReceipt(run, 'Morning', [{ ...seen, scheduledDurationS: null }], false)).toMatchObject({ outcome: 'stop-observed', durationS: 15 })
    expect(pumpReceipt(run, 'Morning', [{ ...seen, durationS: 3 }], false)).toMatchObject({ outcome: 'stopped-early' })
    expect(pumpReceipt(run, 'Morning', [{ ...seen, fault: 'dry-run' }], false)).toMatchObject({ outcome: 'stopped-with-fault', fault: 'dry-run' })
  })

  it('does not validate an offline retained light state or claim a manual match came from the schedule', () => {
    const snap = new SimHal({ tickMs: 0 }).snapshot()
    expect(readLightReceipt(at, 100, 'schedule', { ...snap, online: false })).toMatchObject({ outcome: 'unconfirmed', reported: null })
    expect(readLightReceipt(at, 0, 'manual', snap)).toMatchObject({ outcome: 'held' })
    const state = snap.actuators.light
    if (!state) throw new Error('Sim has no light')
    expect(readLightReceipt(at, 100, 'schedule', { ...snap, actuators: { light: { ...state, on: true, level: 100, fault: 'sim-fault' } } })).toMatchObject({ outcome: 'not-matched', fault: 'sim-fault' })
  })

  it('surfaces verified lighting and pump history through the existing read-only schedules router', async () => {
    const store = new MemoryStore()
    const now = () => new Date(at)
    store.settings.update({ timezone: 'UTC' })
    store.schedules.upsert({ id: 'light-a', kind: 'light', enabled: true, days: 127, name: 'Main', spec: { setpoints: [{ minute: 0, level: 70 }] } })
    store.schedules.upsert({ id: 'am', kind: 'pump', enabled: false, days: 127, name: 'Morning', spec: { minute: 0, durationS: 15 } })
    store.schedules.recordRun(run)
    store.pumpRuns.open(seen.startedAt, 100, [run])
    store.pumpRuns.close(seen.endedAt ?? at, null)
    const core = createCore({ store, hal: new SimHal({ tickMs: 0, now }), now, version: 'test' })
    try {
      const caller = createCallerFactory(appRouter)(core.ctx)
      await core.scheduler.tick()
      await core.scheduler.tick()
      expect(await caller.schedules.receipts()).toMatchObject({
        timezone: 'UTC',
        watering: [{ name: 'Morning', outcome: 'completed', durationS: 15 }],
      })
      expect((await caller.schedules.receipts()).lights).toEqual([{ at, target: 70, reported: 70, outcome: 'matched', source: 'schedule', fault: null }])
      await core.ctx.light.setManual(20)
      await core.scheduler.tick()
      expect((await caller.schedules.receipts()).lights[0]).toMatchObject({ outcome: 'held', target: 70, reported: 20 })
    }
    finally {
      await core.stop()
    }
  })

  it('joins the retry to its own HAL start, even outside the old time window', async () => {
    let time = new Date(at)
    const now = () => time
    const store = new MemoryStore()
    store.settings.update({ timezone: 'UTC' })
    store.schedules.upsert({ id: 'am', kind: 'pump', enabled: true, days: 127, name: 'Morning', spec: { minute: 960, durationS: 15 } })
    const hal = new SimHal({ tickMs: 0, now })
    const command = hal.setActuator.bind(hal)
    let refuse = true
    vi.spyOn(hal, 'setActuator').mockImplementation((id, cmd) => {
      if (id === 'pump' && cmd.on && refuse) {
        refuse = false
        return Promise.reject(new HalRefused('tank level unavailable'))
      }
      return command(id, cmd)
    })
    const core = createCore({ store, hal, now, version: 'test' })
    core.recorder.start()
    const caller = createCallerFactory(appRouter)(core.ctx)
    try {
      await core.scheduler.tick()
      const key = store.schedules.recentRuns()[0]?.key
      expect(key).toBeTruthy()
      expect((await caller.schedules.receipts()).watering[0]).toMatchObject({ key, outcome: 'retrying', attempts: [{ runKey: key, attempt: 1, result: 'refused' }] })
      time = new Date('2026-11-26T16:01:00.000Z')
      await core.scheduler.tick()
      expect((await caller.schedules.receipts()).watering[0]).toMatchObject({ key, outcome: 'start-observed', reportedStart: time.toISOString() })
      time = new Date('2026-11-26T16:01:15.000Z')
      await command('pump', { on: false })
      expect(store.schedules.recentRuns()).toHaveLength(1)
      expect((await caller.schedules.receipts()).watering[0]).toMatchObject({
        key, outcome: 'completed', durationS: 15,
        attempts: [{ runKey: key, attempt: 1, result: 'refused' }, { runKey: key, attempt: 2, result: 'accepted' }],
      })
    }
    finally {
      await core.stop()
    }
  })

  it('never substitutes a nearby pump run for a new acknowledgement with no new start', () => {
    expect(pumpReceipt(run, 'Morning', [seen], false, [{ runKey: run.key, attempt: 1, at, result: 'accepted', reason: null, requestedS: 15, reportedStart: null }]))
      .toMatchObject({ outcome: 'unconfirmed', reportedStart: null })
  })
})
