import { describe, expect, it } from 'vitest'
import { createCallerFactory } from '../../server/trpc'
import { appRouter } from '../../server/routers/app'
import { createCore } from '../../server/bootstrap'
import { MemoryStore } from '../../store/memory'
import { DEFAULT_PUMP_POWER, powerPumpCommand, pumpPower, startsPump, withPumpPower } from '../pumpPower'
import { HalRefused, SimHal } from '../sim'

describe('pump power', () => {
  it('defaults to full power, as the stock Gardyn firmware runs the pump', () => {
    expect(DEFAULT_PUMP_POWER).toBe(100)
    expect(new MemoryStore().settings.get().pumpPower).toBe(100)
    expect(new SimHal({ tickMs: 0 }).snapshot().system?.limits.pumpMaxDuty).toBe(100)
  })

  it('stores a whole percent, 1–100, and anything else as the default', () => {
    expect([pumpPower(55.4), pumpPower(0), pumpPower(250), pumpPower(Number.NaN), pumpPower(undefined)]).toEqual([55, 1, 100, 100, 100])
  })

  it('fills in a start without a speed, caps one above it, and passes stops through', () => {
    expect(powerPumpCommand({ on: true, durationS: 60 }, 70)).toEqual({ on: true, durationS: 60, level: 70 })
    expect(powerPumpCommand({ on: true, level: 90, durationS: 60 }, 70)).toEqual({ on: true, level: 70, durationS: 60 })
    expect(powerPumpCommand({ on: true, level: 40, durationS: 60 }, 70)).toEqual({ on: true, level: 40, durationS: 60 })
    expect(powerPumpCommand({ level: 90 }, 70)).toEqual({ level: 70 })
    const stop = { on: false }
    expect(powerPumpCommand(stop, 70)).toBe(stop)
    expect(powerPumpCommand({ on: false, level: 90 }, 70)).toEqual({ on: false, level: 90 })
    expect(powerPumpCommand({}, 70)).toEqual({})
    expect([startsPump({ on: true }), startsPump({ level: 5 }), startsPump({ level: 0 }), startsPump({})]).toEqual([true, true, false, false])
  })

  it('wraps a HAL once, leaves other actuators and methods alone, and keeps the HAL\'s refusals', async () => {
    const sim = new SimHal({ tickMs: 0, limits: { waterLowCm: 0 } })
    let power = 60
    const hal = withPumpPower(sim, () => power)
    expect(withPumpPower(hal, () => 1)).toBe(hal)
    expect(hal.snapshot()).toEqual(sim.snapshot())
    expect((await hal.setActuator('light', { on: true, level: 80 })).level).toBe(80)
    // waterLowCm 0: the tank always reads dry, and a wrapped start is refused all the same.
    await expect(hal.setActuator('pump', { on: true, durationS: 10 })).rejects.toBeInstanceOf(HalRefused)
    power = 30
    const ok = withPumpPower(new SimHal({ tickMs: 0 }), () => power)
    expect((await ok.setActuator('pump', { on: true, durationS: 10 })).level).toBe(30)
  })

  it('the HAL\'s cap still wins over the pump power', async () => {
    const hal = withPumpPower(new SimHal({ tickMs: 0, limits: { pumpMaxDuty: 50 } }), () => 100)
    expect((await hal.setActuator('pump', { on: true, durationS: 10 })).level).toBe(50)
  })

  it('every pump run through core, a schedule among them, runs at the pump power', async () => {
    const sim = new SimHal({ tickMs: 0 })
    const store = new MemoryStore()
    const core = createCore({ hal: sim, store, version: 'test' })
    const caller = createCallerFactory(appRouter)(core.ctx)
    expect(await caller.pump.power()).toEqual({ power: 100, halMaxDuty: 100, effective: 100 })
    expect((await caller.pump.runOnce({ durationS: 30 })).level).toBe(100)
    await caller.pump.stop()
    expect(await caller.pump.setPower({ power: 65 })).toEqual({ power: 65, halMaxDuty: 100, effective: 65 })
    expect(store.settings.get().pumpPower).toBe(65)
    // The scheduler, HomeKit and Autopilot all take ctx.hal: a run without a speed gets the power.
    expect((await core.ctx.hal.setActuator('pump', { on: true, durationS: 30 })).level).toBe(65)
    expect((await caller.pump.runOnce({ durationS: 30, level: 90 })).level).toBe(65)
    await caller.pump.stop()
    expect((await caller.settings.update({ pumpPower: 80 })).pumpPower).toBe(80)
    expect((await caller.pump.runOnce({ durationS: 30 })).level).toBe(80)
    await expect(caller.pump.setPower({ power: 0 })).rejects.toThrow()
    await expect(caller.settings.update({ pumpPower: 101 })).rejects.toThrow()
    await caller.pump.stop()
    await core.stop()
  })
})
