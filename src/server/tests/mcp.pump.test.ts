import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'

describe('pump power over MCP', () => {
  it('reads and sets the pump power, and run_pump without a level runs at it', async () => {
    const store = new MemoryStore()
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(core.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean, content: Array<{ text: string }> }>
    const call = async <T>(name: string, args: Record<string, unknown> = {}) => JSON.parse((await raw(name, args)).content[0]?.text ?? '') as T

    expect(await call('pump_power')).toEqual({ power: 100, halMaxDuty: 100, effective: 100 })
    expect(await call('set_pump_power', { power: 75 })).toEqual({ power: 75, halMaxDuty: 100, effective: 75 })
    expect(store.settings.get().pumpPower).toBe(75)
    expect(await call<{ level: number }>('run_pump', { duration_s: 20 })).toMatchObject({ on: true, level: 75 })
    await call('stop_pump')
    expect((await raw('set_pump_power', { power: 0 })).isError).toBe(true)
    await client.close()
    await core.stop()
  })
})
