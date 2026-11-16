
import { z } from 'zod'
import { ConditionSchema, DayOfWeek } from '../autopilot/schema'
import { NOTIFY_EVENTS, NOTIFY_PRIORITIES, type NotifyEvent, type NotifyPriority } from './types'

const CompareOp = z.enum(['>', '>=', '<', '<=', '==', '!='])

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM')

export const ChannelKindSchema = z.string().min(1).max(40)

export const PushoverConfigSchema = z.object({
  device: z.string().max(80).optional(),
  sound: z.string().max(40).optional(),
  retry: z.number().int().min(30).max(10800).optional(),
  expire: z.number().int().min(30).max(10800).optional(),
})

export const PushbulletConfigSchema = z.object({
  deviceIden: z.string().max(80).optional(),
  channelTag: z.string().max(80).optional(),
})

export const AppriseConfigSchema = z.object({
  serverUrl: z.string().min(1).max(300),
  configKey: z.string().max(120).optional(),
  tag: z.string().max(120).optional(),
})

export const ChannelConfigSchema = z.union([PushoverConfigSchema, PushbulletConfigSchema, AppriseConfigSchema])

/** Write-only: omitted fields keep the stored value; empty string clears. */
export const ChannelSecretsInput = z.object({
  userKey: z.string().max(80).optional(),
  appToken: z.string().max(80).optional(),
  accessToken: z.string().max(200).optional(),
  apiKey: z.string().max(200).optional(),
  urls: z.array(z.string().min(1).max(500)).max(20).optional(),
}).passthrough()

export const ChannelInput = z.object({
  name: z.string().min(1).max(60),
  kind: ChannelKindSchema,
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: ChannelSecretsInput.optional(),
})

export const MaskedSecrets = z.object({
  userKey: z.string().nullable(),
  hasUserKey: z.boolean(),
  appToken: z.string().nullable(),
  hasAppToken: z.boolean(),
  accessToken: z.string().nullable(),
  hasAccessToken: z.boolean(),
  apiKey: z.string().nullable(),
  hasApiKey: z.boolean(),
  urls: z.number(),
  hasUrls: z.boolean(),
})

export const PublicChannel = z.object({
  id: z.number(),
  name: z.string(),
  kind: ChannelKindSchema,
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  secrets: MaskedSecrets,
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const NotifyEventSchema = z.enum(NOTIFY_EVENTS as unknown as [NotifyEvent, ...NotifyEvent[]])
export const NotifyPrioritySchema = z.enum(NOTIFY_PRIORITIES as unknown as [NotifyPriority, ...NotifyPriority[]])

export const NotifyTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tick'), everyMin: z.number().positive().max(24 * 60) }),
  z.object({ kind: z.literal('signalChange'), signal: z.string().min(1) }),
  z.object({ kind: z.literal('timeOfDay'), at: Time, days: z.array(DayOfWeek).optional() }),
  z.object({
    kind: z.literal('threshold'),
    signal: z.string().min(1),
    op: CompareOp,
    value: z.number(),
    forMin: z.number().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('event'), event: NotifyEventSchema, alertKind: z.string().min(1).optional() }),
])

export const QuietHoursSchema = z.object({ start: Time, end: Time })

export const RuleInput = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().optional(),
  trigger: NotifyTriggerSchema,
  conditions: ConditionSchema,
  channelIds: z.array(z.number().int().positive()).max(20),
  titleTemplate: z.string().min(1).max(200),
  messageTemplate: z.string().min(1).max(2000),
  priority: NotifyPrioritySchema.optional(),
  cooldownMin: z.number().int().min(0).max(24 * 60).optional(),
  quietHours: QuietHoursSchema.nullable().optional(),
  ignoreQuietHours: z.boolean().optional(),
  repeatWhileTrue: z.boolean().optional(),
})

export const PublicRule = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: NotifyTriggerSchema,
  conditions: ConditionSchema,
  channelIds: z.array(z.number()),
  titleTemplate: z.string(),
  messageTemplate: z.string(),
  priority: NotifyPrioritySchema,
  cooldownMin: z.number(),
  quietHours: QuietHoursSchema.nullable(),
  ignoreQuietHours: z.boolean(),
  repeatWhileTrue: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const RunOutcomeSchema = z.enum(['sent', 'skipped', 'quiet', 'cooldown', 'dedup', 'error', 'disabled'])

export const PublicRun = z.object({
  id: z.number(),
  ruleId: z.number(),
  firedAt: z.string(),
  outcome: RunOutcomeSchema,
  detail: z.unknown(),
})
