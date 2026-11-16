/**
 * Push notification channels and IF/THEN rules (Settings → Notifications).
 * Conditions reuse Autopilot\'s AST so the two editors feel the same.
 */
import type { CompareOp, Condition, DayOfWeek } from '../autopilot/types'

export type ChannelKind = 'pushover' | 'pushbullet' | 'apprise'

export type NotifyPriority = 'lowest' | 'low' | 'normal' | 'high' | 'emergency'

export const NOTIFY_PRIORITIES: readonly NotifyPriority[] = ['lowest', 'low', 'normal', 'high', 'emergency']

/** Maps a rule priority onto Pushover\'s numeric scale. */
export const PUSHOVER_PRIORITY: Record<NotifyPriority, -2 | -1 | 0 | 1 | 2> = {
  lowest: -2,
  low: -1,
  normal: 0,
  high: 1,
  emergency: 2,
}

export interface PushoverConfig {
  device?: string
  sound?: string
  /** Emergency retry interval, seconds (Pushover requires 30–10800). */
  retry?: number
  /** Emergency expiry, seconds (Pushover requires 30–10800). */
  expire?: number
}

export interface PushoverSecrets {
  userKey?: string
  appToken?: string
}

export interface PushbulletConfig {
  deviceIden?: string
  channelTag?: string
}

export interface PushbulletSecrets {
  accessToken?: string
}

/**
 * Talk to an external Apprise API server (caronc/apprise-api). The unit never
 * runs the Python Apprise package itself.
 */
export interface AppriseConfig {
  /** Base URL of the Apprise API, e.g. http://apprise.local:8000 */
  serverUrl: string
  /** Optional config key: POST /notify/{key} instead of /notify. */
  configKey?: string
  tag?: string
}

export interface AppriseSecrets {
  /** If the API is locked down with a key. */
  apiKey?: string
  /** Raw Apprise URLs (often contain tokens); sent as `urls` to the API. */
  urls?: string[]
}

export type ChannelConfig = PushoverConfig | PushbulletConfig | AppriseConfig
export type ChannelSecrets = PushoverSecrets | PushbulletSecrets | AppriseSecrets

export interface NotificationChannel {
  id: number
  name: string
  kind: ChannelKind
  enabled: boolean
  config: ChannelConfig
  secrets: ChannelSecrets
  createdAt: string
  updatedAt: string
}

export type NotifyEvent
  = | 'pump_fault'
    | 'dry_run'
    | 'brown_out'
    | 'alert_raised'
    | 'alert_cleared'
    | 'pod_attention'
    | 'pod_harvest'
    | 'task_due'
    | 'light_on'
    | 'light_off'
    | 'update_available'
    | 'unit_offline'
    | 'unit_online'
    | 'analysis_finding'

export const NOTIFY_EVENTS: readonly NotifyEvent[] = [
  'pump_fault', 'dry_run', 'brown_out',
  'alert_raised', 'alert_cleared',
  'pod_attention', 'pod_harvest', 'task_due',
  'light_on', 'light_off',
  'update_available', 'unit_offline', 'unit_online',
  'analysis_finding',
]

export type NotifyTrigger
  = | { kind: 'tick', everyMin: number }
    | { kind: 'signalChange', signal: string }
    | { kind: 'timeOfDay', at: string, days?: DayOfWeek[] }
    | { kind: 'threshold', signal: string, op: CompareOp, value: number, forMin?: number }
    | { kind: 'event', event: NotifyEvent, alertKind?: string }

export interface QuietHours { start: string, end: string }

export interface NotificationRule {
  id: number
  name: string
  enabled: boolean
  trigger: NotifyTrigger
  conditions: Condition
  /** Empty means every enabled channel. */
  channelIds: number[]
  titleTemplate: string
  messageTemplate: string
  priority: NotifyPriority
  cooldownMin: number
  quietHours: QuietHours | null
  ignoreQuietHours: boolean
  /** If still true after the cooldown, send again (reminders). Default off. */
  repeatWhileTrue: boolean
  createdAt: string
  updatedAt: string
}

export type NotifyRunOutcome = 'sent' | 'skipped' | 'quiet' | 'cooldown' | 'dedup' | 'error' | 'disabled'

export interface NotificationRun {
  id: number
  ruleId: number
  firedAt: string
  outcome: NotifyRunOutcome
  detail: unknown
}

export interface NotifyTemplateContext {
  rule: { name: string, id: number }
  event?: string
  eventLabel?: string
  alert?: { kind: string, detail: string }
  unit: { name: string }
  time: string
  date: string
  update?: { tag?: string }
  pod?: { slot: number, plant: string | null, status: string }
  sensor: Record<string, number | undefined>
  [key: string]: unknown
}
