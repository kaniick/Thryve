import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/thryve-hal-mqtt.cjs')
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function run(input: object, env: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, THRYVE_HAL_MQTT_DRY: '1', ...env },
  })
}

describe('thryve-hal-mqtt', () => {
  it('writes mqtt keys into hal.toml and a core drop-in, without restarting, and never prints the password', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thryve-hal-mqtt-'))
    dirs.push(dir)
    const etc = join(dir, 'etc')
    mkdirSync(etc)
    writeFileSync(join(etc, 'hal.toml'), 'unit_id = "u1"\n# mqtt_url = "mqtt://127.0.0.1:1883"\n')
    const dropin = join(dir, 'mqtt.conf')
    const envFile = join(dir, 'core-mqtt.env')
    const r = run({ url: 'mqtt://10.10.60.72:1883', username: 'ha', password: 's3cret' }, {
      THRYVE_ETC_DIR: etc,
      THRYVE_HAL_MQTT_DROPIN: dropin,
      THRYVE_HAL_MQTT_ENV: envFile,
    })
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}')
    expect(result).toEqual({ ok: true, detail: 'Wrote hal.toml and the core MQTT drop-in.' })
    expect(r.stdout + r.stderr).not.toContain('s3cret')
    const toml = readFileSync(join(etc, 'hal.toml'), 'utf8')
    expect(toml).toContain('mqtt_url = "mqtt://10.10.60.72:1883"')
    expect(toml).toContain('mqtt_username = "ha"')
    expect(toml).toContain('mqtt_password = "s3cret"')
    expect(toml).toContain('# mqtt_url = "mqtt://127.0.0.1:1883"')
    expect(readFileSync(dropin, 'utf8')).toBe(`[Service]\nEnvironmentFile=-${envFile}\n`)
    expect(readFileSync(envFile, 'utf8')).toBe('HAL_MQTT_URL="mqtt://ha:s3cret@10.10.60.72:1883"\n')
    expect(readFileSync(dropin, 'utf8')).not.toContain('s3cret')
  })

  it('refuses a missing config or a bad URL and stays off the files it would write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thryve-hal-mqtt-'))
    dirs.push(dir)
    const missing = run({ url: 'mqtt://ha:1883' }, { THRYVE_ETC_DIR: join(dir, 'none') })
    expect(missing.status).toBe(1)
    expect(JSON.parse(missing.stdout.trim().split('\n').at(-1) ?? '{}').code).toBe('missing')
    const bad = run({ url: 'http://ha' }, { THRYVE_ETC_DIR: dir })
    expect(JSON.parse(bad.stdout.trim().split('\n').at(-1) ?? '{}').code).toBe('invalid')
  })
})
