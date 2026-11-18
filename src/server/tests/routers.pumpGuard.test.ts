import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { PumpGuardCommand, topics } from '../../hardware/contract'
import { HalRefused, SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function caller(hal = new SimHal({ tickMs: 0 })) {
  const events = createEventBus()
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test' })
  return { hal, events, core, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('the pump dry-run guard from core', () => {
  it('sets the grace through the unit, held to its bounds, and says so', async () => {
    const { c, events } = caller()
    const seen: string[] = []
    events.subscribe(e => seen.push(e.kind === 'mutation' ? e.path : e.kind))
    expect((await c.system.info()).system?.limits).toMatchObject({ pumpDryGuard: 'level', pumpDryGraceMs: 1000, pumpDryGraceMinMs: 300, pumpDryGraceMaxMs: 5000 })
    expect(await c.pump.setDryGrace({ ms: 1200 })).toMatchObject({ pumpDryGraceMs: 1200 })
    expect((await c.pump.setDryGrace({ ms: 0 })).pumpDryGraceMs).toBe(300)
    expect((await c.pump.setDryGrace({ ms: 10_000 })).pumpDryGraceMs).toBe(5000)
    expect((await c.system.info()).system?.limits.pumpDryGraceMs).toBe(5000)
    expect(seen.filter(p => p === 'pump.guard')).toHaveLength(3)
    await expect(c.pump.setDryGrace({ ms: 10_001 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('maps a hald that can\'t set it to PRECONDITION_FAILED, and passes other errors on', async () => {
    const refusing = new SimHal({ tickMs: 0 })
    refusing.setPumpGuard = async () => {
      throw new HalRefused('this hald can\'t set the dry-run grace; update it')
    }
    await expect(caller(refusing).c.pump.setDryGrace({ ms: 1000 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /update it/ })
    const broken = new SimHal({ tickMs: 0 })
    broken.setPumpGuard = async () => {
      throw new Error('hald did not report the dry-run grace within 5000 ms')
    }
    await expect(caller(broken).c.pump.setDryGrace({ ms: 1000 })).rejects.toThrow(/within 5000 ms/)
  })

  it('the simulator holds a grace to whatever bounds it has', async () => {
    const open = new SimHal({ tickMs: 0, limits: { pumpDryGraceMinMs: undefined, pumpDryGraceMaxMs: undefined } })
    expect((await open.setPumpDryGrace(12_345.4)).pumpDryGraceMs).toBe(12_345)
    expect((await open.setPumpDryGrace(-5)).pumpDryGraceMs).toBe(0)
  })

  it('is set over MCP too, as the grace and the full guard', async () => {
    const { core } = caller()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(core.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const grace = (await client.listTools()).tools.find(t => t.name === 'set_pump_dry_grace')
    expect(Object.keys((grace?.inputSchema as { properties: object }).properties)).toEqual(['ms'])
    expect(grace?.description).toMatch(/set_pump_guard/)
    const r = await client.callTool({ name: 'set_pump_dry_grace', arguments: { ms: 2000 } })
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? '')).toMatchObject({ pumpDryGraceMs: 2000 })
    const g = await client.callTool({ name: 'set_pump_guard', arguments: { dry_guard: 'level', water_low_cm: 16 } })
    expect(JSON.parse((g.content as Array<{ text: string }>)[0]?.text ?? '')).toMatchObject({ pumpDryGuard: 'level', waterLowCm: 16 })
    const s = await client.callTool({ name: 'set_tank_sampling', arguments: { distance_samples: 7 } })
    expect(JSON.parse((s.content as Array<{ text: string }>)[0]?.text ?? '')).toMatchObject({ distanceSamples: 7 })
    await client.close()
  })

  it('lets the app set the mode and cutoffs, and still refuses unknown fields', async () => {
    const { c } = caller()
    expect(await c.pump.setGuard({ dryGuard: 'level', waterLowCm: 16 })).toMatchObject({ pumpDryGuard: 'level', waterLowCm: 16 })
    expect(PumpGuardCommand.safeParse({ dryGraceMs: 1000, pumpDryGuard: 'current' }).success).toBe(false)
    expect(PumpGuardCommand.safeParse({}).success).toBe(false)
    expect(PumpGuardCommand.safeParse({ mode: 'level' }).success).toBe(false)
    expect(PumpGuardCommand.safeParse({ dryGuard: 'none' }).success).toBe(false)
    expect(Object.keys(topics).filter(t => /guard|tankSensor/i.test(t)).sort()).toEqual(['pumpGuardSet', 'tankSensorSet'])
  })
})
