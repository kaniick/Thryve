import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { activity, ActivityEntry } from '../../garden/activity'
import { plantHistory, PlantHistory, PlantLife } from '../../garden/plantHistory'
import { readiness, Readiness } from '../../garden/readiness'
import { visionReview, VisionReview } from '../../garden/visionReview'
import { publicProcedure, router } from '../trpc'

const WeekMs = 7 * 24 * 60 * 60_000

export const gardenRouter = router({
  activity: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/garden/activity', tags: ['garden'], summary: 'Recent watering, light, tank, camera and gateway events' } })
    .input(z.object({ days: z.number().int().min(1).max(7).default(2) }))
    .output(z.object({ checkedAt: z.string(), days: z.number(), entries: z.array(ActivityEntry) }))
    .query(async ({ ctx, input }) => {
      const now = ctx.now?.() ?? new Date()
      const log = await ctx.bootLog?.().catch(() => null) ?? null
      return { checkedAt: now.toISOString(), days: input.days, entries: activity(ctx.store, now, input.days, log, ctx.cameraRecovery?.recent(), ctx.scheduleActivity?.().retrying) }
    }),
  plants: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/garden/plants', tags: ['garden'], summary: 'Current yCubes and a paged history of retired plants' } })
    .input(z.object({ before: z.number().int().positive().optional() }))
    .output(z.object({ active: z.array(PlantLife), archive: z.array(PlantLife), next: z.number().nullable() }))
    .query(({ ctx, input }) => {
      const page = ctx.store.plantJournal.archive(31, input.before)
      return {
        active: ctx.store.plantJournal.active().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)),
        archive: page.slice(0, 30),
        next: page.length > 30 ? page[29]?.id ?? null : null,
      }
    }),
  plant: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/garden/plants/{id}', tags: ['garden'], summary: 'Plant timeline and retained photos from confirmed slot occupancy' } })
    .input(z.object({ id: z.number().int().positive() }))
    .output(PlantHistory)
    .query(({ ctx, input }) => {
      const result = plantHistory(ctx.store, input.id)
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'No plant with that ID' })
      return result
    }),
  readiness: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/garden/readiness', tags: ['garden'], summary: 'Read-only garden check for the next 72 hours or until a supplied time' } })
    .input(z.object({ until: z.string().datetime({ offset: true }).optional() }))
    .output(Readiness)
    .query(({ ctx, input }) => {
      const now = ctx.now?.() ?? new Date()
      const until = input.until ? new Date(input.until) : new Date(now.getTime() + 3 * 86_400_000)
      if (!Number.isFinite(until.getTime()) || until <= now || until.getTime() - now.getTime() > WeekMs) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Trip end must be in the next seven days' })
      }
      return readiness(ctx.store, ctx.hal.snapshot(), now, until)
    }),
  visionReview: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/garden/vision-review', tags: ['garden'], summary: 'Review where recent off-device leaf-cover measurements disagree with the built-in baseline' } })
    .input(z.object({ analyzer: z.string().max(64).optional(), version: z.number().int().positive().optional() }))
    .output(VisionReview)
    .query(({ ctx, input }) => visionReview(ctx.store, input.analyzer && input.version ? { analyzer: input.analyzer, version: input.version } : undefined)),
})
