import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyHalBroker, halMqttCommand } from '../halBroker'

const helper = resolve(import.meta.dirname, '../../../scripts/thryve-hal-mqtt.cjs')
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('halMqttCommand', () => {
  it('takes THRYVE_HAL_MQTT_CMD as a JSON array and is otherwise null when the helper is not installed', () => {
    expect(halMqttCommand({ THRYVE_HAL_MQTT_CMD: '["node","scripts/thryve-hal-mqtt.cjs"]' })).toEqual(['node', 'scripts/thryve-hal-mqtt.cjs'])
    expect(halMqttCommand({})).toBeNull()
  })
})

describe('applyHalBroker', () => {
  it('runs the helper with secrets on stdin, reports its detail, and never echoes the password', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-hal-'))
    dirs.push(dir)
    const etc = join(dir, 'etc')
    mkdirSync(etc)
    writeFileSync(join(etc, 'hal.toml'), 'unit_id = "u1"\n')
    const env = {
      THRYVE_HAL_MQTT_CMD: JSON.stringify(['node', helper]),
      THRYVE_HAL_MQTT_DRY: '1',
      THRYVE_ETC_DIR: etc,
      THRYVE_HAL_MQTT_DROPIN: join(dir, 'mqtt.conf'),
      THRYVE_HAL_MQTT_ENV: join(dir, 'core-mqtt.env'),
    }
    const result = await applyHalBroker({ url: 'mqtt://10.10.60.72:1883', username: 'ha', password: 's3cret' }, env)
    expect(result).toEqual({ ok: true, detail: 'Wrote hal.toml and the core MQTT drop-in.' })
    expect(JSON.stringify(result)).not.toContain('s3cret')
    expect(readFileSync(join(etc, 'hal.toml'), 'utf8')).toContain('mqtt_password = "s3cret"')
  })

  it('explains when the helper is not installed', async () => {
    const result = await applyHalBroker({ url: 'mqtt://ha:1883' }, {})
    expect(result.ok).toBe(false)
    expect(result.code).toBe('unavailable')
    expect(result.detail).toMatch(/scripts\/install/)
  })
})
