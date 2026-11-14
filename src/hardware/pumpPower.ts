import type { ActuatorCommand } from './contract'
import type { HalClient } from './types'

/** seedypod's level, kept as the default. The stock Gardyn firmware runs the pump at 100. */
export const DEFAULT_PUMP_POWER = 30
/** The default soft start, as hald's `limits.pump_soft_start_ms`. */
export const DEFAULT_SOFT_START_MS = 1500
export const MIN_SOFT_START_MS = 100
export const MAX_SOFT_START_MS = 10_000

const WRAPPED = Symbol.for('thryve.pumpPower')

/** How core drives the pump, from Settings › Pump. */
export interface PumpDrive {
  /** % duty, 1–100. */
  power: number
  /** Ramp each start up, or switch straight on. */
  softStart: boolean
  /** The ramp's length in ms. */
  softStartMs: number
}

/** A pump power as stored: a whole percent, 1–100. Anything else is the default. */
export function pumpPower(p: unknown): number {
  return typeof p === 'number' && Number.isFinite(p) ? Math.min(100, Math.max(1, Math.round(p))) : DEFAULT_PUMP_POWER
}

/** A soft start's length as stored: whole ms, 100–10000. Anything else is the default. */
export function softStartMs(ms: unknown): number {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.min(MAX_SOFT_START_MS, Math.max(MIN_SOFT_START_MS, Math.round(ms))) : DEFAULT_SOFT_START_MS
}

/** Whether a pump command starts (or keeps) the pump running, as hald's PumpGuard reads it. */
export function startsPump(cmd: ActuatorCommand): boolean {
  return cmd.on === true || (cmd.on === undefined && (cmd.level ?? 0) > 0)
}

/**
 * The pump command core sends for `cmd`: a start that names no speed runs at
 * the pump power, none goes above it, and it carries the soft start (0 when
 * that's off) unless it names its own. Stops pass through untouched, so a stop
 * always lands. hald still clamps the level to its own `pump_max_duty` and the
 * ramp to its own max, and every run stays bounded and guarded (ADR-0009).
 */
export function powerPumpCommand(cmd: ActuatorCommand, drive: PumpDrive): ActuatorCommand {
  if (!startsPump(cmd)) return cmd
  const p = pumpPower(drive.power)
  return {
    ...cmd,
    level: cmd.level === undefined ? p : Math.min(cmd.level, p),
    softStartMs: cmd.softStartMs ?? (drive.softStart ? softStartMs(drive.softStartMs) : 0),
  }
}

/** The pump drive in a store's settings. */
export function driveOf(s: { pumpPower: number, pumpSoftStart: boolean, pumpSoftStartMs: number }): PumpDrive {
  return { power: s.pumpPower, softStart: s.pumpSoftStart, softStartMs: s.pumpSoftStartMs }
}

/**
 * Every pump command from core (the schedule, the buttons, Autopilot, HomeKit,
 * the Home Assistant bridge, REST and MCP) at the owner's pump power and soft
 * start. Wrapping twice is wrapping once.
 */
export function withPumpPower(hal: HalClient, drive: () => PumpDrive): HalClient {
  if ((hal as unknown as Record<symbol, unknown>)[WRAPPED]) return hal
  return new Proxy(hal, {
    get(target, prop) {
      if (prop === WRAPPED) return true
      if (prop === 'setActuator') {
        const set: HalClient['setActuator'] = (id, cmd) => target.setActuator(id, id === 'pump' ? powerPumpCommand(cmd, drive()) : cmd)
        return set
      }
      const v: unknown = Reflect.get(target, prop, target)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}
