import type { ActuatorCommand } from './contract'
import type { HalClient } from './types'

/** Full power: how the stock Gardyn firmware runs the pump, and the default. */
export const DEFAULT_PUMP_POWER = 100

const WRAPPED = Symbol.for('thryve.pumpPower')

/** A pump power as stored: a whole percent, 1–100. Anything else is the default. */
export function pumpPower(p: unknown): number {
  return typeof p === 'number' && Number.isFinite(p) ? Math.min(100, Math.max(1, Math.round(p))) : DEFAULT_PUMP_POWER
}

/** Whether a pump command starts (or keeps) the pump running, as hald's PumpGuard reads it. */
export function startsPump(cmd: ActuatorCommand): boolean {
  return cmd.on === true || (cmd.on === undefined && (cmd.level ?? 0) > 0)
}

/**
 * The pump command core sends for `cmd` at pump power `power`: a start that
 * names no speed runs at the pump power, and none goes above it. Stops pass
 * through untouched, so a stop always lands. hald still clamps the level to its
 * own `pump_max_duty`, and every run stays bounded and guarded (ADR-0009).
 */
export function powerPumpCommand(cmd: ActuatorCommand, power: number): ActuatorCommand {
  if (!startsPump(cmd)) return cmd
  const p = pumpPower(power)
  return { ...cmd, level: cmd.level === undefined ? p : Math.min(cmd.level, p) }
}

/**
 * Every pump command from core (the schedule, the buttons, Autopilot, HomeKit,
 * the Home Assistant bridge, REST and MCP) at the owner's pump power. Wrapping
 * twice is wrapping once.
 */
export function withPumpPower(hal: HalClient, power: () => number): HalClient {
  if ((hal as unknown as Record<symbol, unknown>)[WRAPPED]) return hal
  return new Proxy(hal, {
    get(target, prop) {
      if (prop === WRAPPED) return true
      if (prop === 'setActuator') {
        const set: HalClient['setActuator'] = (id, cmd) => target.setActuator(id, id === 'pump' ? powerPumpCommand(cmd, power()) : cmd)
        return set
      }
      const v: unknown = Reflect.get(target, prop, target)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}
