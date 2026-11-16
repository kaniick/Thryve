/**
 * The Thryve iPhone app's side of notifications: phones register here (with an
 * APNs device token when push is available), read the feed of what the "ios"
 * channel sent, and hand over Live Activity push tokens. Mounted under
 * `notifications` (notifications.feed, notifications.devices.*, notifications.activities.*).
 */
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { IosService } from '../../notify/ios/service'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Environment = z.enum(['sandbox', 'production'])
/** APNs device and ActivityKit tokens: hex, 32–100 bytes. */
const Token = z.string().regex(/^[0-9a-fA-F]{64,200}$/, 'expected an APNs token in hex').transform(s => s.toLowerCase())
const DeviceId = z.string().min(8).max(64)

const FeedItemOut = z.object({
  id: z.number(),
  title: z.string(),
  body: z.string(),
  level: z.enum(['info', 'warning', 'critical']),
  alertId: z.number().nullable(),
  createdAt: z.string(),
})

const DeviceOut = z.object({
  deviceId: z.string(),
  name: z.string(),
  hasToken: z.boolean(),
  environment: Environment,
  bundleId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

function ios(ctx: Context): IosService {
  if (!ctx.ios) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'iPhone notifications aren\'t available on this host' })
  return ctx.ios
}

export const iosDevicesRouter = router({
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/ios/devices', tags: ['notifications'], summary: 'iPhones registered for notifications; tokens are never returned' } })
    .output(z.array(DeviceOut))
    .query(({ ctx }) => ctx.store.notifications.ios.devices.list().map(({ token, ...d }) => ({ ...d, hasToken: !!token }))),
  register: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/ios/devices', tags: ['notifications'], summary: 'Register this iPhone (the Thryve app) for notifications, with its APNs token when it has one' } })
    .input(z.object({
      deviceId: DeviceId,
      name: z.string().min(1).max(80),
      platform: z.literal('ios').optional(),
      token: Token.nullish(),
      environment: Environment,
      bundleId: z.string().max(155).optional(),
    }))
    .output(z.object({ apnsConfigured: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const out = ios(ctx).register(input)
      ctx.events.emit({ kind: 'mutation', path: 'notifications.devices' })
      return out
    }),
  unregister: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/notifications/ios/devices/{deviceId}', tags: ['notifications'], summary: 'Forget an iPhone' } })
    .input(z.object({ deviceId: DeviceId }))
    .output(z.object({ ok: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const ok = ios(ctx).unregister(input.deviceId)
      ctx.events.emit({ kind: 'mutation', path: 'notifications.devices' })
      return { ok }
    }),
  test: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/ios/devices/{deviceId}/test', tags: ['notifications'], summary: 'Send a test to one iPhone: through APNs when set up, otherwise into the feed' } })
    .input(z.object({ deviceId: DeviceId }))
    .output(z.object({ sent: z.boolean(), via: z.enum(['apns', 'feed']) }))
    .mutation(({ ctx, input }) => ios(ctx).test(input.deviceId)),
})

export const iosActivitiesRouter = router({
  register: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/ios/activities', tags: ['notifications'], summary: 'A watering Live Activity push token: "start" (push-to-start) or "update" (one running activity)' } })
    .input(z.object({
      deviceId: DeviceId,
      kind: z.enum(['start', 'update']),
      activityId: z.string().min(1).max(100).nullish(),
      token: Token,
      environment: Environment,
    }).refine(t => t.kind === 'start' || !!t.activityId, { message: 'an update token needs its activityId' }))
    .output(z.object({ ok: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ios(ctx).registerActivityToken({ ...input, activityId: input.kind === 'start' ? null : input.activityId ?? null })
      return { ok: true }
    }),
})

export const iosFeedProcedure = publicProcedure
  .meta({ openapi: { method: 'GET', path: '/notifications/feed', tags: ['notifications'], summary: 'What the iPhone channel sent after a cursor, oldest first; no cursor gives just the newest id' } })
  .input(z.object({ afterId: z.number().int().nonnegative().nullish(), limit: z.number().int().min(1).max(100).optional() }))
  .output(z.object({ items: z.array(FeedItemOut), latestId: z.number().nullable() }))
  .query(({ ctx, input }) => ios(ctx).feed(input.afterId ?? null, input.limit ?? 20))
