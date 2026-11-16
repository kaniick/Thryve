import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { catalog } from '../../autopilot/signals'
import { EVENT_LABELS } from '../../notify/events'
import { mergeSecrets, parseConfig, publicChannel } from '../../notify/public'
import {
  ChannelInput,
  PublicChannel,
  PublicRule,
  PublicRun,
  QuietHoursSchema,
  RuleInput,
} from '../../notify/schema'
import { STARTER_RULES } from '../../notify/starters'
import { NOTIFY_EVENTS } from '../../notify/types'
import type { NotificationRule } from '../../notify/types'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const ts = (ctx: Context) => (ctx.now?.() ?? new Date()).toISOString()

function changed(ctx: Context) {
  ctx.events.emit({ kind: 'mutation', path: 'notifications' })
  void ctx.notifier.tick()
}

function mustChannel(ctx: Context, id: number) {
  const ch = ctx.store.notifications.channels.get(id)
  if (!ch) throw new TRPCError({ code: 'NOT_FOUND', message: `no notification channel ${id}` })
  return ch
}

function mustRule(ctx: Context, id: number) {
  const r = ctx.store.notifications.rules.get(id)
  if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: `no notification rule ${id}` })
  return r
}

const Status = z.object({
  enabled: z.boolean(),
  quietHours: QuietHoursSchema.nullable(),
  channels: z.number(),
  rules: z.number(),
  armed: z.number(),
})

const EventInfo = z.object({ event: z.enum(NOTIFY_EVENTS as unknown as [typeof NOTIFY_EVENTS[number], ...typeof NOTIFY_EVENTS[number][]]), label: z.string() })

const RuleWithLast = PublicRule.extend({ lastRun: PublicRun.nullable() })

function withLast(ctx: Context, r: NotificationRule) {
  const [last] = ctx.store.notifications.runs.list({ ruleId: r.id, limit: 1 })
  return { ...r, lastRun: last ?? null }
}

const TestChannelOut = z.object({ ok: z.boolean(), error: z.string().optional() })
const TestRuleOut = z.object({
  title: z.string(),
  message: z.string(),
  results: z.array(z.object({ channelId: z.number(), name: z.string(), ok: z.boolean(), error: z.string().optional() })),
})

const Starter = PublicRule.omit({ id: true, createdAt: true, updatedAt: true }).extend({
  id: z.string(),
  description: z.string(),
  alreadyAdded: z.boolean(),
})

/** Push notification channels and IF/THEN rules. Secrets are write-only. */
export const notificationsRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/status', tags: ['notifications'], summary: 'Kill switch, quiet hours, and how many channels and rules are set up' } })
    .output(Status)
    .query(({ ctx }) => {
      const s = ctx.store.settings.get()
      const channels = ctx.store.notifications.channels.list()
      const rules = ctx.store.notifications.rules.list()
      return {
        enabled: s.notificationsEnabled,
        quietHours: s.notifyQuietStart && s.notifyQuietEnd ? { start: s.notifyQuietStart, end: s.notifyQuietEnd } : null,
        channels: channels.length,
        rules: rules.length,
        armed: rules.filter(r => r.enabled).length,
      }
    }),
  setGlobal: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/notifications/enabled', tags: ['notifications'], summary: 'The kill switch: off stops every notification rule' } })
    .input(z.object({ enabled: z.boolean() }))
    .output(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.store.settings.update({ notificationsEnabled: input.enabled })
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      changed(ctx)
      return { enabled: input.enabled }
    }),
  setQuietHours: publicProcedure
    .meta({ openapi: { method: 'PUT', path: '/notifications/quiet-hours', tags: ['notifications'], summary: 'Unit-wide quiet hours (HH:MM local); null clears them' } })
    .input(z.object({ quietHours: QuietHoursSchema.nullable() }))
    .output(z.object({ quietHours: QuietHoursSchema.nullable() }))
    .mutation(({ ctx, input }) => {
      ctx.store.settings.update({
        notifyQuietStart: input.quietHours?.start ?? null,
        notifyQuietEnd: input.quietHours?.end ?? null,
      })
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      changed(ctx)
      return { quietHours: input.quietHours }
    }),
  catalog: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/catalog', tags: ['notifications'], summary: 'Signals, events and starter templates the rule builder can use' } })
    .output(z.object({
      signals: z.array(z.object({ key: z.string(), label: z.string(), unit: z.string(), group: z.string(), liveOnly: z.boolean() })),
      events: z.array(EventInfo),
    }))
    .query(() => ({
      signals: catalog(),
      events: NOTIFY_EVENTS.map(event => ({ event, label: EVENT_LABELS[event] })),
    })),
  starters: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/starters', tags: ['notifications'], summary: 'Off-by-default starter rules the owner can add' } })
    .output(z.array(Starter))
    .query(({ ctx }) => {
      const names = new Set(ctx.store.notifications.rules.list().map(r => r.name))
      return STARTER_RULES.map(s => ({ ...s, alreadyAdded: names.has(s.name) }))
    }),

  channels: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/channels', tags: ['notifications'], summary: 'Configured channels; secrets are masked' } })
    .output(z.array(PublicChannel))
    .query(({ ctx }) => ctx.store.notifications.channels.list().map(publicChannel)),
  getChannel: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/channels/{id}', tags: ['notifications'] } })
    .input(z.object({ id: z.number().int() }))
    .output(PublicChannel)
    .query(({ ctx, input }) => publicChannel(mustChannel(ctx, input.id))),
  createChannel: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/channels', tags: ['notifications'], summary: 'Add a channel. Tokens are write-only and stored on the unit.' } })
    .input(ChannelInput)
    .output(PublicChannel)
    .mutation(({ ctx, input }) => {
      const ch = ctx.store.notifications.channels.create({
        name: input.name,
        kind: input.kind,
        enabled: input.enabled ?? true,
        config: parseConfig(input.kind, input.config),
        secrets: mergeSecrets(input.kind, undefined, input.secrets),
      }, ts(ctx))
      changed(ctx)
      return publicChannel(ch)
    }),
  updateChannel: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/notifications/channels/{id}', tags: ['notifications'], summary: 'Update a channel. Omitted secrets are left unchanged; an empty string clears one.' } })
    .input(ChannelInput.partial().extend({ id: z.number().int() }))
    .output(PublicChannel)
    .mutation(({ ctx, input }) => {
      const cur = mustChannel(ctx, input.id)
      const kind = input.kind ?? cur.kind
      const updated = ctx.store.notifications.channels.update(input.id, {
        name: input.name,
        kind,
        enabled: input.enabled,
        config: input.config !== undefined ? parseConfig(kind, input.config) : undefined,
        secrets: input.secrets !== undefined || input.kind ? mergeSecrets(kind, cur.secrets, input.secrets) : undefined,
      }, ts(ctx))
      if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `no notification channel ${input.id}` })
      changed(ctx)
      return publicChannel(updated)
    }),
  removeChannel: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/notifications/channels/{id}', tags: ['notifications'] } })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.notifications.channels.remove(input.id)
      changed(ctx)
      return { removed }
    }),
  testChannel: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/channels/{id}/test', tags: ['notifications'], summary: 'Send a test message on this channel' } })
    .input(z.object({ id: z.number().int() }))
    .output(TestChannelOut)
    .mutation(({ ctx, input }) => ctx.notifier.testChannel(mustChannel(ctx, input.id))),

  rules: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/rules', tags: ['notifications'] } })
    .output(z.array(RuleWithLast))
    .query(({ ctx }) => ctx.store.notifications.rules.list().map(r => withLast(ctx, r))),
  getRule: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/rules/{id}', tags: ['notifications'] } })
    .input(z.object({ id: z.number().int() }))
    .output(RuleWithLast)
    .query(({ ctx, input }) => withLast(ctx, mustRule(ctx, input.id))),
  createRule: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/rules', tags: ['notifications'] } })
    .input(RuleInput)
    .output(PublicRule)
    .mutation(({ ctx, input }) => {
      const r = ctx.store.notifications.rules.create({
        name: input.name,
        enabled: input.enabled ?? false,
        trigger: input.trigger,
        conditions: input.conditions,
        channelIds: input.channelIds,
        titleTemplate: input.titleTemplate,
        messageTemplate: input.messageTemplate,
        priority: input.priority ?? 'normal',
        cooldownMin: input.cooldownMin ?? 60,
        quietHours: input.quietHours ?? null,
        ignoreQuietHours: input.ignoreQuietHours ?? false,
        repeatWhileTrue: input.repeatWhileTrue ?? false,
      }, ts(ctx))
      changed(ctx)
      return r
    }),
  updateRule: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/notifications/rules/{id}', tags: ['notifications'] } })
    .input(RuleInput.partial().extend({ id: z.number().int() }))
    .output(PublicRule)
    .mutation(({ ctx, input }) => {
      mustRule(ctx, input.id)
      const { id, ...patch } = input
      const r = ctx.store.notifications.rules.update(id, patch, ts(ctx))
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: `no notification rule ${id}` })
      changed(ctx)
      return r
    }),
  removeRule: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/notifications/rules/{id}', tags: ['notifications'] } })
    .input(z.object({ id: z.number().int() }))
    .output(z.object({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const removed = ctx.store.notifications.rules.remove(input.id)
      changed(ctx)
      return { removed }
    }),
  testRule: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/rules/{id}/test', tags: ['notifications'], summary: 'Render the rule from live readings and send it, bypassing cooldown and quiet hours' } })
    .input(z.object({ id: z.number().int() }))
    .output(TestRuleOut)
    .mutation(({ ctx, input }) => ctx.notifier.testRule(mustRule(ctx, input.id))),
  runs: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications/runs', tags: ['notifications'], summary: 'Rule history, newest first' } })
    .input(z.object({ ruleId: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }).optional())
    .output(z.array(PublicRun))
    .query(({ ctx, input }) => ctx.store.notifications.runs.list({ ruleId: input?.ruleId, limit: input?.limit ?? 50 })),
})
