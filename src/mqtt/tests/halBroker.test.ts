import { describe, expect, it } from 'vitest'
import { DEFAULT_HAL_MQTT_URL, halBrokerStatus, mqttConnectedFromHealth, parseHalTomlBroker, tomlBrokerFromText, upsertHalTomlMqtt } from '../halBroker'

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
    expect(tomlBrokerFromText('unit_id = "u1"\n')).toEqual({
      url: DEFAULT_HAL_MQTT_URL, explicit: false, hasUsername: false, hasPassword: false,
    })
  })
})

describe('halBrokerStatus', () => {
  it('does not look at a config when the backend is the simulator, and never returns credentials', () => {
    expect(halBrokerStatus({ sim: true })).toEqual({
      broker: null, url: null, connected: null, sim: true, configPath: null, usingDefault: false,
    })
    const file = tomlBrokerFromText('mqtt_url = "mqtt://user:secret@10.10.60.72:1883"\n')
    expect(halBrokerStatus({ sim: false, file, configPath: '/etc/thryve/hal.toml', connected: true })).toEqual({
      broker: '10.10.60.72:1883',
      url: 'mqtt://10.10.60.72:1883',
      connected: true,
      sim: false,
      configPath: '/etc/thryve/hal.toml',
      usingDefault: false,
    })
  })

  it('uses the default URL without a file, and leaves connected unknown until health answers', () => {
    expect(halBrokerStatus({ sim: false, file: null, connected: null })).toMatchObject({
      broker: '127.0.0.1:1883',
      url: DEFAULT_HAL_MQTT_URL,
      connected: null,
      sim: false,
      configPath: null,
      usingDefault: true,
    })
    expect(mqttConnectedFromHealth({ ok: true, mqtt_connected: false })).toBe(false)
    expect(mqttConnectedFromHealth({ ok: true })).toBeNull()
  })
})

describe('upsertHalTomlMqtt', () => {
  it('replaces uncommented keys, leaves comments and other tables, and appends missing ones', () => {
    const out = upsertHalTomlMqtt(`# mqtt_url = "mqtt://127.0.0.1:1883"
unit_id = "u1"
mqtt_url = "mqtt://old:1883"
[limits]
pump_max_duty = 100
`, { url: 'mqtt://10.10.60.72:1883', username: 'ha', password: 'p"w' })
    expect(out).toContain('# mqtt_url = "mqtt://127.0.0.1:1883"')
    expect(out).toContain('mqtt_url = "mqtt://10.10.60.72:1883"')
    expect(out).toContain('mqtt_username = "ha"')
    expect(out).toContain('mqtt_password = "p\\"w"')
    expect(out).toContain('pump_max_duty = 100')
    expect(out).not.toContain('mqtt://old:1883')
    expect(parseHalTomlBroker(out)).toMatchObject({ url: 'mqtt://10.10.60.72:1883', hasUsername: true, hasPassword: true })
  })

  it('drops a username or password key when it is cleared', () => {
    const out = upsertHalTomlMqtt('mqtt_url = "mqtt://ha:1883"\nmqtt_username = "ha"\nmqtt_password = "secret"\n', { url: 'mqtt://ha:1883' })
    expect(out).toBe('mqtt_url = "mqtt://ha:1883"\n')
  })
})
