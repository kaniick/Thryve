import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { ActuatorId } from '../../hardware/contract'
import { ActuatorCommand, ActuatorState, Limits, PumpGuardCommand } from '../../hardware/contract'
import { MAX_SOFT_START_MS, MIN_SOFT_START_MS, pumpPower, softStartMs } from '../../hardware/pumpPower'
import { HalRefused } from '../../hardware/sim'
import { publicProcedure, router } from '../trpc'

async function set(ctx: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx'], id: z.infer<typeof ActuatorId>, cmd: z.infer<typeof ActuatorCommand>) {
  try {
    const state = await ctx.hal.setActuator(id, cmd)
    // A command that starts the pump says so, so the UI can tell a run someone started from a Stop.
    const starts = id === 'pump' && (cmd.on === true || (cmd.on === undefined && (cmd.level ?? 0) > 0))
    ctx.events.emit({ kind: 'mutation', path: starts ? 'actuators.pump.on' : `actuators.${id}` })
    return state
  }
  catch (e) {
    if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
    throw e
  }
}

const PumpPower = z.object({
  power: z.number().int().min(1).max(100).describe('Pump power, % duty: runs without their own speed use it, and none from core goes above it'),
  halMaxDuty: z.number().nullable().describe('hald\'s limits.pump_max_duty, which caps every run; null while hald is offline'),
  effective: z.number().describe('What a run without its own speed drives now: the lower of power and halMaxDuty'),
  softStart: z.boolean().describe('Whether each start ramps up gently; off switches the pump straight on'),
  softStartMs: z.number().int().describe('The ramp\'s length in ms'),
})

function powerView(ctx: Parameters<Parameters<typeof publicProcedure.query>[0]>[0]['ctx']): z.infer<typeof PumpPower> {
  const power = pumpPower(ctx.store.settings.get().pumpPower)
  const halMaxDuty = ctx.hal.snapshot().system?.limits.pumpMaxDuty ?? null
  const s = ctx.store.settings.get()
  return { power, halMaxDuty, effective: halMaxDuty === null ? power : Math.min(power, halMaxDuty), softStart: s.pumpSoftStart, softStartMs: softStartMs(s.pumpSoftStartMs) }
}

const LightOwner = z.object({ source: z.enum(['manual', 'autopilot', 'schedule']).nullable(), level: z.number().nullable(), leaseId: z.string().nullable(), manualUntil: z.string().nullable(), schedule: z.number().nullable() })
/** When a hand's hold ends: a time ahead, or null for until someone resumes. */
const HoldUntil = z.string().datetime({ offset: true }).nullable()

/** A hold's end as epoch ms (null stays null); one already past is refused. */
function holdEnd(until: string | null, now: number): number | null {
  if (until === null) return null
  const at = Date.parse(until)
  if (at <= now) throw new TRPCError({ code: 'BAD_REQUEST', message: 'until is already past' })
  return at
}

export const lightRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/light', tags: ['light'] } })
    .output(ActuatorState.nullable())
    .query(({ ctx }) => ctx.hal.snapshot().actuators.light ?? null),
  set: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light', tags: ['light'], summary: 'Turn the grow light on/off and set brightness 0–100' } })
    .input(ActuatorCommand.omit({ durationS: true }).extend({ until: HoldUntil.optional().describe('When the hold ends; null holds until resumed; left out, 30 minutes') }))
    .output(ActuatorState)
    .mutation(async ({ ctx, input }) => {
      // A person set the light: it holds over Autopilot and the curve for a while (ADR-0020).
      const level = input.on === false ? 0 : input.level ?? (ctx.hal.snapshot().actuators.light?.level || 100)
      const until = input.until === undefined ? undefined : holdEnd(input.until, (ctx.now ?? (() => new Date()))().getTime())
      try {
        const state = await ctx.light.setManual(level, until)
        ctx.events.emit({ kind: 'mutation', path: 'actuators.light' })
        return state
      }
      catch (e) {
        if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
        throw e
      }
    }),
  owner: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/light/owner', tags: ['light'], summary: 'Who controls the light now: manual hold, Autopilot or the schedule' } })
    .output(LightOwner)
    .query(({ ctx }) => ctx.light.status()),
  hold: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light/hold', tags: ['light'], summary: 'Change when a manual hold ends: a time, or null to hold until resumed' } })
    .input(z.object({ until: HoldUntil }))
    .output(LightOwner)
    .mutation(({ ctx, input }) => {
      if (!ctx.light.holdUntil(holdEnd(input.until, (ctx.now ?? (() => new Date()))().getTime()))) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the light isn\'t held by hand' })
      ctx.events.emit({ kind: 'mutation', path: 'actuators.light' })
      return ctx.light.status()
    }),
  resume: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/light/resume', tags: ['light'], summary: 'End a manual hold and hand the light back to Autopilot or the schedule' } })
    .output(LightOwner)
    .mutation(async ({ ctx }) => {
      await ctx.light.resume()
      await ctx.light.idle()
      ctx.events.emit({ kind: 'mutation', path: 'actuators.light' })
      return ctx.light.status()
    }),
})

export const pumpRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pump', tags: ['pump'] } })
    .output(ActuatorState.nullable())
    .query(({ ctx }) => ctx.hal.snapshot().actuators.pump ?? null),
  set: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump', tags: ['pump'], summary: 'Run the pump; every run is bounded by the HAL max-run limit and the dry-run interlock' } })
    .input(ActuatorCommand)
    .output(ActuatorState)
    .mutation(({ ctx, input }) => set(ctx, 'pump', input)),
  runOnce: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/run-once', tags: ['pump'], summary: 'Run the pump for N seconds at a speed' } })
    .input(z.object({ durationS: z.number().int().positive(), level: z.number().min(1).max(100).optional() }))
    .output(ActuatorState)
    .mutation(({ ctx, input }) => set(ctx, 'pump', { on: true, level: input.level, durationS: input.durationS })),
  power: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pump/power', tags: ['pump'], summary: 'Pump power and soft start: the % duty runs without their own speed use, the HAL cap over it, and the start ramp' } })
    .output(PumpPower)
    .query(({ ctx }) => powerView(ctx)),
  setPower: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/power', tags: ['pump'], summary: 'Set the pump power (1–100 % duty) and the soft start. If the unit reboots when the pump starts, lower the power or lengthen the ramp' } })
    .input(z.object({
      power: z.number().int().min(1).max(100).optional(),
      softStart: z.boolean().optional(),
      softStartMs: z.number().int().min(MIN_SOFT_START_MS).max(MAX_SOFT_START_MS).optional(),
    }))
    .output(PumpPower)
    .mutation(({ ctx, input }) => {
      ctx.store.settings.update({
        ...(input.power === undefined ? {} : { pumpPower: input.power }),
        ...(input.softStart === undefined ? {} : { pumpSoftStart: input.softStart }),
        ...(input.softStartMs === undefined ? {} : { pumpSoftStartMs: input.softStartMs }),
      })
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      return powerView(ctx)
    }),
  stop: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/stop', tags: ['pump'] } })
    .input(z.void())
    .output(ActuatorState)
    .mutation(({ ctx }) => set(ctx, 'pump', { on: false })),
  setDryGrace: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/dry-grace', tags: ['pump'], summary: 'Set how long after a start the pump current isn\'t checked, while the pump spins up; the unit holds it to the bounds in its hal.toml' } })
    .input(z.object({ ms: z.number().int().min(0).max(10_000) }))
    .output(Limits)
    .mutation(async ({ ctx, input }) => {
      try {
        const limits = await ctx.hal.setPumpGuard({ dryGraceMs: input.ms })
        ctx.events.emit({ kind: 'mutation', path: 'pump.guard' })
        return limits
      }
      catch (e) {
        if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
        throw e
      }
    }),
  setGuard: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/pump/guard', tags: ['pump'], summary: 'Set the dry-run guard mode, tank or current cutoffs, spin-up grace, or the no-trusted-reading window; the unit holds each value to the bounds in its hal.toml' } })
    .input(PumpGuardCommand)
    .output(Limits)
    .mutation(async ({ ctx, input }) => {
      try {
        const limits = await ctx.hal.setPumpGuard(input)
        ctx.events.emit({ kind: 'mutation', path: 'pump.guard' })
        return limits
      }
      catch (e) {
        if (e instanceof HalRefused) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message })
        throw e
      }
    }),
  runs: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/pump/runs', tags: ['pump'], summary: 'Actual pump runs, including manual ones, newest first' } })
    .input(z.object({
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }).optional())
    .output(z.array(z.object({
      id: z.number(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      durationS: z.number(),
      source: z.enum(['scheduled', 'manual']),
      scheduleId: z.string().nullable(),
      scheduledDurationS: z.number().nullable(),
      fault: z.string().nullable(),
      level: z.number().nullable(),
    })))
    .query(({ ctx, input }) => ctx.store.pumpRuns.list({
      from: input?.from,
      to: input?.to,
      limit: input?.limit ?? 50,
    })),
})
