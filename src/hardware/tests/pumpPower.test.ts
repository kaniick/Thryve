import { describe, expect, it, vi } from 'vitest'
import { createCallerFactory } from '../../server/trpc'
import { appRouter } from '../../server/routers/app'
import { createCore } from '../../server/bootstrap'
import { MemoryStore } from '../../store/memory'
import type { PumpDrive } from '../pumpPower'
import { DEFAULT_PUMP_POWER, powerPumpCommand, pumpPower, softStartMs, startsPump, withPumpPower } from '../pumpPower'
import { HalRefused, SimHal } from '../sim'

const drive = (o: Partial<PumpDrive> = {}): PumpDrive => ({ power: 70, softStart: true, softStartMs: 1500, ...o })

describe('pump power', () => {
  it('defaults to seedypod\'s 30 % with a soft start, under a HAL cap that allows full power', () => {
    expect(DEFAULT_PUMP_POWER).toBe(30)
    const s = new MemoryStore().settings.get()
    expect([s.pumpPower, s.pumpSoftStart, s.pumpSoftStartMs]).toEqual([30, true, 1500])
    expect(new SimHal({ tickMs: 0 }).snapshot().system?.limits.pumpMaxDuty).toBe(100)
  })

  it('stores whole numbers in range, and anything else as the default', () => {
    expect([pumpPower(55.4), pumpPower(0), pumpPower(250), pumpPower(Number.NaN), pumpPower(undefined)]).toEqual([55, 1, 100, 30, 30])
    expect([softStartMs(2500.4), softStartMs(0), softStartMs(99_999), softStartMs(null)]).toEqual([2500, 100, 10_000, 1500])
  })

  it('fills in a start without a speed, caps one above it, adds the soft start, and passes stops through', () => {
    expect(powerPumpCommand({ on: true, durationS: 60 }, drive())).toEqual({ on: true, durationS: 60, level: 70, softStartMs: 1500 })
    expect(powerPumpCommand({ on: true, level: 90, durationS: 60 }, drive())).toEqual({ on: true, level: 70, durationS: 60, softStartMs: 1500 })
    expect(powerPumpCommand({ on: true, level: 40, durationS: 60 }, drive({ softStart: false }))).toEqual({ on: true, level: 40, durationS: 60, softStartMs: 0 })
    expect(powerPumpCommand({ on: true, softStartMs: 300 }, drive())).toEqual({ on: true, level: 70, softStartMs: 300 })
    expect(powerPumpCommand({ level: 90 }, drive({ softStartMs: 4000 }))).toEqual({ level: 70, softStartMs: 4000 })
    const stop = { on: false }
    expect(powerPumpCommand(stop, drive())).toBe(stop)
    expect(powerPumpCommand({}, drive())).toEqual({})
    expect([startsPump({ on: true }), startsPump({ level: 5 }), startsPump({ level: 0 }), startsPump({})]).toEqual([true, true, false, false])
  })

  it('wraps a HAL once, leaves other actuators and methods alone, and keeps the HAL\'s refusals', async () => {
    const sim = new SimHal({ tickMs: 0, limits: { waterLowCm: 0 } })
    const hal = withPumpPower(sim, () => drive({ power: 60 }))
    expect(withPumpPower(hal, () => drive({ power: 1 }))).toBe(hal)
    // Date frozen: the two snapshots' reading times could otherwise straddle a millisecond.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-14T12:00:00Z') })
    try {
      expect(hal.snapshot()).toEqual(sim.snapshot())
    }
    finally {
      vi.useRealTimers()
    }
    expect((await hal.setActuator('light', { on: true, level: 80 })).level).toBe(80)
    // waterLowCm 0: the tank always reads dry, and a wrapped start is refused all the same.
    await expect(hal.setActuator('pump', { on: true, durationS: 10 })).rejects.toBeInstanceOf(HalRefused)
  })

  it('the HAL\'s cap still wins over the pump power', async () => {
    const hal = withPumpPower(new SimHal({ tickMs: 0, limits: { pumpMaxDuty: 50 } }), () => drive({ power: 100 }))
    expect((await hal.setActuator('pump', { on: true, durationS: 10 })).level).toBe(50)
  })

  it('every pump run through core, a schedule among them, runs at the pump power the owner chose', async () => {
    const sim = new SimHal({ tickMs: 0 })
    const sent: unknown[] = []
    const set = sim.setActuator.bind(sim)
    sim.setActuator = (id, cmd) => {
      if (id === 'pump') sent.push(cmd)
      return set(id, cmd)
    }
    const store = new MemoryStore()
    const core = createCore({ hal: sim, store, version: 'test' })
    const caller = createCallerFactory(appRouter)(core.ctx)
    expect(await caller.pump.power()).toEqual({ power: 30, halMaxDuty: 100, effective: 30, softStart: true, softStartMs: 1500 })
    expect((await caller.pump.runOnce({ durationS: 30 })).level).toBe(30)
    expect(sent.at(-1)).toEqual({ on: true, durationS: 30, level: 30, softStartMs: 1500 })
    await caller.pump.stop()
    // Higher than 30 when the owner chooses: up to the HAL's cap.
    expect(await caller.pump.setPower({ power: 100 })).toMatchObject({ power: 100, effective: 100 })
    expect(store.settings.get().pumpPower).toBe(100)
    // The scheduler, HomeKit and Autopilot all take ctx.hal: a run without a speed gets the power.
    expect((await core.ctx.hal.setActuator('pump', { on: true, durationS: 30 })).level).toBe(100)
    await caller.pump.stop()
    expect(await caller.pump.setPower({ power: 65, softStart: false })).toMatchObject({ power: 65, softStart: false, softStartMs: 1500 })
    expect((await caller.pump.runOnce({ durationS: 30, level: 90 })).level).toBe(65)
    expect(sent.at(-1)).toEqual({ on: true, durationS: 30, level: 65, softStartMs: 0 })
    await caller.pump.stop()
    expect(await caller.pump.setPower({ softStart: true, softStartMs: 3000 })).toMatchObject({ power: 65, softStart: true, softStartMs: 3000 })
    expect((await caller.settings.update({ pumpPower: 80 })).pumpPower).toBe(80)
    await caller.pump.runOnce({ durationS: 30 })
    expect(sent.at(-1)).toEqual({ on: true, durationS: 30, level: 80, softStartMs: 3000 })
    await caller.pump.stop()
    expect(sent.at(-1)).toEqual({ on: false })
    await expect(caller.pump.setPower({ power: 0 })).rejects.toThrow()
    await expect(caller.pump.setPower({ softStartMs: 50 })).rejects.toThrow()
    await expect(caller.settings.update({ pumpPower: 101 })).rejects.toThrow()
    await core.stop()
  })
})
