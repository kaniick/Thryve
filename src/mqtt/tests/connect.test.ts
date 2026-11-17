import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHal } from '../../hardware/factory'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { SimHal } from '../../hardware/sim'
import { connectBridge, describeConnectError, resolveBrokerTest, testBroker } from '../bridge'
import { connectAsync } from '../connect'

const fake = { connected: true, on: vi.fn(), subscribe: vi.fn(), publish: vi.fn(), end: vi.fn() }

vi.mock('mqtt', () => ({ connectAsync: vi.fn(async () => fake) }))

afterEach(() => vi.clearAllMocks())

describe('the mqtt entry point', () => {
  it('names connectAsync, which a dynamic import of mqtt itself only has as default.connectAsync in the bundle', () => {
    expect(connectAsync).toBeTypeOf('function')
  })

  it('is what the hardware client connects through', async () => {
    const hal = await createHal({ events: createEventBus(), mqttUrl: 'mqtt://127.0.0.1:1883', unitId: 'u1' })
    expect(connectAsync).toHaveBeenCalledWith('mqtt://127.0.0.1:1883', expect.objectContaining({ reconnectPeriod: 5000 }))
    await hal.close().catch(() => undefined)
  })

  it('is what the Home Assistant bridge connects through', async () => {
    const store = new MemoryStore()
    store.settings.update({ mqttUrl: 'mqtt://ha.local:1883' })
    const bridge = await connectBridge({ store, hal: new SimHal({ tickMs: 0 }), events: createEventBus(), unitId: 'u1' })
    expect(connectAsync).toHaveBeenCalledWith('mqtt://ha.local:1883', expect.objectContaining({ clientId: 'thryve-core-bridge-u1' }))
    bridge?.stop()
  })

  it('tests saved broker settings with a temporary client and closes it', async () => {
    const store = new MemoryStore()
    const settings = store.settings.update({ mqttUrl: 'mqtt://ha.local:8883', mqttUsername: 'ha', mqttPassword: 'secret', mqttTlsEnabled: true })
    await expect(testBroker(settings)).resolves.toEqual({ ok: true, detail: 'Connected to the MQTT broker.' })
    expect(connectAsync).toHaveBeenCalledWith('mqtts://ha.local:8883', { username: 'ha', password: 'secret', rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: 5000 }, false)
    expect(fake.end).toHaveBeenCalledOnce()
    expect(fake.publish).not.toHaveBeenCalled()
  })

  it('reports rejected credentials without returning the broker error text', async () => {
    const store = new MemoryStore()
    const settings = store.settings.update({ mqttUrl: 'mqtt://ha.local:1883' })
    vi.mocked(connectAsync).mockRejectedValueOnce(Object.assign(new Error('private broker message'), { code: 5 }))
    await expect(testBroker(settings)).resolves.toEqual({ ok: false, detail: 'The broker rejected the login. Check the MQTT username and password.' })
  })

  it('tests a draft URL and uses the saved password when the draft omits it', async () => {
    const store = new MemoryStore()
    const saved = store.settings.update({ mqttUrl: 'mqtt://old.local:1883', mqttUsername: 'ha', mqttPassword: 'secret' })
    const draft = resolveBrokerTest(saved, { mqttUrl: 'mqtt://10.10.60.72:1883', mqttUsername: 'ha' })
    expect(draft.mqttPassword).toBe('secret')
    await expect(testBroker(draft)).resolves.toEqual({ ok: true, detail: 'Connected to the MQTT broker.' })
    expect(connectAsync).toHaveBeenCalledWith('mqtt://10.10.60.72:1883', expect.objectContaining({ username: 'ha', password: 'secret' }), false)
  })
})

describe('describeConnectError', () => {
  it('classifies auth, DNS, refusal, timeout, unreachable and TLS without returning the raw message', () => {
    expect(describeConnectError(Object.assign(new Error('secret'), { code: 5 }))).toMatch(/rejected the login/)
    expect(describeConnectError(Object.assign(new Error('secret'), { code: 'ENOTFOUND' }))).toMatch(/resolve the broker hostname/)
    expect(describeConnectError(Object.assign(new Error('secret'), { code: 'ECONNREFUSED' }))).toMatch(/Connection refused/)
    expect(describeConnectError(Object.assign(new Error('connack timeout'), { }))).toMatch(/timed out/)
    expect(describeConnectError(Object.assign(new Error('secret'), { code: 'EHOSTUNREACH' }))).toMatch(/unreachable/)
    expect(describeConnectError(Object.assign(new Error('self-signed certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }))).toMatch(/TLS verification/)
    expect(describeConnectError(new Error('mystery'))).not.toMatch(/mystery/)
  })
})
