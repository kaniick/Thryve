import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HAL_MQTT_URL, halBrokerStatus, parseHalTomlBroker, readHalTomlBroker } from '../halBroker'

describe('parseHalTomlBroker', () => {
  it('reads uncommented mqtt keys and ignores comments and other tables', () => {
    const parsed = parseHalTomlBroker(`
# mqtt_url = "mqtt://commented:1883"
mqtt_url = "mqtt://user:secret@ha.local:1883"
mqtt_username = "ha"
mqtt_password = "p@ss"
[limits]
pump_max_duty = 100
`)
    expect(parsed).toEqual({ url: 'mqtt://user:secret@ha.local:1883', explicit: true, hasUsername: true, hasPassword: true })
  })

  it('treats a missing mqtt_url as unset, without inventing credentials', () => {
    expect(parseHalTomlBroker('unit_id = "u1"\n')).toEqual({ url: null, explicit: false, hasUsername: false, hasPassword: false })
  })
})

describe('readHalTomlBroker', () => {
  it('fills the daemon default when the file has no mqtt_url, and is null when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thryve-hal-toml-'))
    const path = join(dir, 'hal.toml')
    await writeFile(path, 'unit_id = "u1"\n')
    await expect(readHalTomlBroker(path)).resolves.toEqual({
      url: DEFAULT_HAL_MQTT_URL, explicit: false, hasUsername: false, hasPassword: false,
    })
    await expect(readHalTomlBroker(join(dir, 'nope.toml'))).resolves.toBeNull()
  })
})

describe('halBrokerStatus', () => {
  it('does not look at a config when the backend is the simulator, and never returns credentials', async () => {
    await expect(halBrokerStatus({ sim: true })).resolves.toEqual({
      broker: null, url: null, connected: null, sim: true, configPath: null, usingDefault: false,
    })
    const dir = await mkdtemp(join(tmpdir(), 'thryve-hal-toml-'))
    const path = join(dir, 'hal.toml')
    await writeFile(path, 'mqtt_url = "mqtt://user:secret@10.10.60.72:1883"\n')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, mqtt_connected: true }), { status: 200 }))
    await expect(halBrokerStatus({ sim: false, tomlPath: path, httpBase: 'http://hal', fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({
      broker: '10.10.60.72:1883',
      url: 'mqtt://10.10.60.72:1883',
      connected: true,
      sim: false,
      configPath: path,
      usingDefault: false,
    })
  })

  it('says the status is unknown when health cannot be reached, and uses the default URL without a file', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(halBrokerStatus({ sim: false, tomlPath: join(tmpdir(), 'missing-hal.toml'), httpBase: 'http://hal', fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toMatchObject({
      broker: '127.0.0.1:1883',
      url: DEFAULT_HAL_MQTT_URL,
      connected: null,
      sim: false,
      configPath: null,
      usingDefault: true,
    })
  })
})
