import { describe, expect, it, vi } from 'vitest'
import { NotifyEngine } from '../engine'
import type { EventSnapshot } from '../events'
import type { NotificationChannel, NotificationRule } from '../types'
import type { NotifyRunOutcome } from '../types'

function emptySnap(over: Partial<EventSnapshot> = {}): EventSnapshot {
  return { alerts: new Map(), lightOn: false, pods: [], unhealthy: [], updateAvailable: false, halOnline: true, ...over }
}

function rule(over: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: 1,
    name: 'Tank low',
    enabled: true,
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
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

const channel: NotificationChannel = {
  id: 1, name: 'Phone', kind: 'pushover', enabled: true,
  config: {}, secrets: { userKey: 'user-secret-key-xxxx', appToken: 'app-secret-token-yyyy' },
  createdAt: '', updatedAt: '',
}

function harness(opts?: { rules?: NotificationRule[], channels?: NotificationChannel[], signals?: Record<string, number | undefined>, snap?: EventSnapshot, enabled?: boolean, quiet?: { start: string, end: string } | null }) {
  const runs: Array<{ ruleId: number, outcome: NotifyRunOutcome, detail: unknown }> = []
  let signals = opts?.signals ?? { 'sensor.water_level_pct': 18 }
  let snap = opts?.snap ?? emptySnap()
  const posts: Array<{ url: string, body: string }> = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: String(init?.body ?? '') })
    return new Response(JSON.stringify({ status: 1, request: 'req' }), { status: 200 })
  })
  const readSignals = vi.fn<(slots: number[]) => Record<string, number | undefined>>(() => signals)
  const readSnapshot = vi.fn(() => snap)
  const engine = new NotifyEngine({
    now: () => Date.parse('2026-11-16T20:00:00Z'),
    clock: () => ({ nowMinutes: 12 * 60, dayOfWeek: 'monday', dateKey: '2026-11-16' }),
    signals: readSignals,
    snapshot: readSnapshot,
    loadRules: () => opts?.rules ?? [rule()],
    loadChannels: () => opts?.channels ?? [channel],
    recordRun: (ruleId, outcome, detail) => { runs.push({ ruleId, outcome, detail }) },
    enabled: () => opts?.enabled ?? true,
    globalQuietHours: () => opts?.quiet ?? null,
    unitName: () => 'Kitchen',
    fetch: fetchImpl,
  })
  return {
    engine, runs, posts, fetchImpl, readSignals, readSnapshot,
    setSignals(s: Record<string, number | undefined>) { signals = s },
    setSnap(s: EventSnapshot) { snap = s },
  }
}

describe('notification engine', () => {
  it('skips analysis and snapshots without rules, and starts with a quiet baseline once configured', async () => {
    const rules: NotificationRule[] = []
    const h = harness({ rules })
    await h.engine.tick()
    expect(h.readSignals).not.toHaveBeenCalled()
    expect(h.readSnapshot).not.toHaveBeenCalled()
    rules.push(rule({ trigger: { kind: 'event', event: 'light_on' } }))
    h.setSnap(emptySnap({ lightOn: true }))
    await h.engine.tick()
    expect(h.readSignals).toHaveBeenCalledWith([])
    expect(h.posts).toHaveLength(0)
  })

  it('reads just the unique pod slots in thresholds and nested window conditions', async () => {
    const r = rule({
      trigger: { kind: 'threshold', signal: 'pod.5.green', op: '>', value: 0.25 },
      conditions: { kind: 'not', condition: { kind: 'compare', op: '>', left: { kind: 'window', signal: 'pod.8.trend', fn: 'avg', lastMin: 30 }, right: { kind: 'signal', signal: 'pod.5.trend' } } },
    })
    const h = harness({ rules: [r] })
    await h.engine.tick()
    expect(h.readSignals).toHaveBeenCalledExactlyOnceWith([5, 8])
    h.readSignals.mockClear()
    await h.engine.testRule(r)
    expect(h.readSignals).toHaveBeenCalledExactlyOnceWith([5, 8])
  })

  it('sends once when a threshold is crossed, then dedups until it clears', async () => {
    const h = harness()
    await h.engine.tick() // first sample, rising edge
    expect(h.runs.map(r => r.outcome)).toEqual(['sent'])
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]?.body).toContain('Tank+is+at+18%')
    await h.engine.tick()
    expect(h.runs.at(-1)?.outcome).toBe('dedup')
    expect(h.posts).toHaveLength(1)
  })

  it('fires a pump fault event and does not send when notifications are off', async () => {
    const evRule = rule({ id: 2, name: 'Pump', trigger: { kind: 'event', event: 'pump_fault' }, titleTemplate: 'Fault', messageTemplate: '{{alert.detail}}' })
    const h = harness({ rules: [evRule], enabled: false, snap: emptySnap() })
    await h.engine.tick() // seed previous snapshot
    h.setSnap(emptySnap({ alerts: new Map([['pump_fault', { detail: 'pump: dry-run', active: true }]]) }))
    await h.engine.tick()
    expect(h.runs.at(-1)?.outcome).toBe('disabled')
    expect(h.posts).toHaveLength(0)
  })

  it('sends a pump fault when enabled and records an error when the provider fails', async () => {
    const evRule = rule({ id: 2, name: 'Pump', trigger: { kind: 'event', event: 'dry_run' }, titleTemplate: 'Dry', messageTemplate: '{{alert.detail}}', ignoreQuietHours: true })
    const h = harness({ rules: [evRule] })
    h.fetchImpl.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await h.engine.tick()
    h.setSnap(emptySnap({ alerts: new Map([['pump_fault', { detail: 'pump: dry-run: water below 16 cm', active: true }]]) }))
    await h.engine.tick()
    expect(h.runs.at(-1)?.outcome).toBe('error')
  })

  it('testRule bypasses the trigger and cooldown', async () => {
    const h = harness({ signals: { 'sensor.water_level_pct': 40 } })
    const out = await h.engine.testRule(rule())
    expect(out.title).toBe('Thryve: tank low')
    expect(out.message).toBe('Tank is at 40%.')
    expect(out.results[0]?.ok).toBe(true)
    expect(h.posts).toHaveLength(1)
  })
})
