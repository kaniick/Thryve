import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ActuatorCommand, ActuatorState, Alert, ButtonEvent, CalibrationCommand, CalibrationResult, DeviceCommand, DeviceInventory, DeviceKindInfo, DeviceResult, PumpGuardCommand, Reading, SystemInfo } from '../contract'

const dir = join(__dirname, '../../../hal/contract/fixtures')
const schemas = { system: SystemInfo, system_without_board: SystemInfo, actuator_state: ActuatorState, reading: Reading, alert: Alert, alert_dose_fault: Alert, command: ActuatorCommand, calibration_command: CalibrationCommand, calibration_result: CalibrationResult, device_inventory: DeviceInventory, device_kinds: z.array(DeviceKindInfo), device_command: DeviceCommand, device_result: DeviceResult, button_event: ButtonEvent, pump_guard_command: PumpGuardCommand } as const

describe('the system limits', () => {
  it('carry the brown-out guard, and an older hald\'s carry none', () => {
    const read = (name: string) => SystemInfo.parse(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))).limits
    const l = read('system')
    expect([l.pumpMaxDuty, l.pumpBrownoutV, l.pumpBrownoutMs, l.pumpBrownoutPi]).toEqual([100, 10.8, 300, true])
    const old = read('system_without_board')
    expect([old.pumpBrownoutV, old.pumpBrownoutMs, old.pumpBrownoutPi]).toEqual([undefined, undefined, undefined])
  })
})

describe('HAL contract fixtures parse on the TS side', () => {
  for (const file of readdirSync(dir)) {
    const name = file.replace(/\.json$/, '') as keyof typeof schemas
    it(`${file}`, () => {
      const schema = schemas[name]
      expect(schema, `no schema registered for fixture ${file}`).toBeDefined()
      const parsed = schema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')))
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true)
    })
  }
})
