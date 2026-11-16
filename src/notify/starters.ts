
import type { NotificationRule } from './types'

export type StarterRule = Omit<NotificationRule, 'id' | 'createdAt' | 'updatedAt'> & { id: string, description: string }

/**
 * Off-by-default templates the owner can add from Notifications → Starter
 * rules. They save disabled until the owner turns one on and has a channel.
 */
export const STARTER_RULES: StarterRule[] = [
  {
    id: 'pump-fault',
    name: 'Pump fault',
    description: 'When the pump trips (dry-run, brown-out or a latched fault), push a high-priority notice so you can refill or check the supply.',
    enabled: false,
    trigger: { kind: 'event', event: 'pump_fault' },
    conditions: { kind: 'and', conditions: [] },
    channelIds: [],
    titleTemplate: 'Thryve: pump fault',
    messageTemplate: '{{alert.detail}}',
    priority: 'high',
    cooldownMin: 30,
    quietHours: null,
    ignoreQuietHours: true,
    repeatWhileTrue: false,
  },
  {
    id: 'tank-low',
    name: 'Tank low',
    description: 'When the tank drops below 25 %, tell you. A 60-minute cooldown and an edge trigger stop a flapping level sensor from spamming.',
    enabled: false,
    trigger: { kind: 'threshold', signal: 'sensor.water_level_pct', op: '<', value: 25 },
    conditions: { kind: 'and', conditions: [] },
    channelIds: [],
    titleTemplate: 'Thryve: tank low',
    messageTemplate: 'Tank is at {{sensor.water_level_pct}}%.',
    priority: 'high',
    cooldownMin: 60,
    quietHours: null,
    ignoreQuietHours: false,
    repeatWhileTrue: false,
  },
  {
    id: 'unit-offline',
    name: 'Unit offline',
    description: 'When the hardware daemon drops, and again when it comes back.',
    enabled: false,
    trigger: { kind: 'event', event: 'unit_offline' },
    conditions: { kind: 'and', conditions: [] },
    channelIds: [],
    titleTemplate: 'Thryve: unit offline',
    messageTemplate: 'The hardware daemon is unreachable.',
    priority: 'emergency',
    cooldownMin: 15,
    quietHours: null,
    ignoreQuietHours: true,
    repeatWhileTrue: false,
  },
]
