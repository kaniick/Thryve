
/**
 * Evaluate notification rules: WHEN a trigger matches, IF conditions hold,
 * THEN send on the chosen channels, with cooldown, dedup and quiet hours.
 */
import { evaluateCondition } from '../autopilot/evaluator'
import type { CompareOp, DayOfWeek } from '../autopilot/types'
import type { EvalContext } from '../autopilot/expressions'
import { SustainTracker } from '../autopilot/expressions'
import { WindowStore } from '../autopilot/windows'
import { decideRate, markSent, type RateState } from './cooldown'
import { EVENT_LABELS, edges, eventMatches, type EventSnapshot, type FiredEvent } from './events'
import { sendOnChannel, type HttpFetch } from './providers'
import { redactSecrets } from './mask'
import { renderTemplate } from './template'
import type { NotificationChannel, NotificationRule, NotifyRunOutcome, NotifyTemplateContext, NotifyTrigger } from './types'

export const NOTIFY_TICK_MS = 15_000
const TIME_OF_DAY_GRACE_MIN = 2

export interface NotifyEngineDeps {
  now: () => number
  clock: () => { nowMinutes: number, dayOfWeek: DayOfWeek, dateKey: string }
  signals: () => Record<string, number | undefined>
  snapshot: () => EventSnapshot
  loadRules: () => NotificationRule[]
  loadChannels: () => NotificationChannel[]
  recordRun: (ruleId: number, outcome: NotifyRunOutcome, detail: unknown) => void
  enabled: () => boolean
  globalQuietHours: () => { start: string, end: string } | null
  unitName: () => string
  changed?: () => void
  log?: (m: string) => void
  fetch?: HttpFetch
}

interface Runtime {
  fingerprint: string
  rate: RateState
  lastTriggerSeen: boolean
  lastTickEvalMs: number
  lastTimeKey: string | null
  lastSignal: number | undefined
  lastThreshold: boolean
}

export class NotifyEngine {
  private readonly windows = new WindowStore()
  private readonly sustain = new SustainTracker()
  private readonly runtime = new Map<number, Runtime>()
  private prev: EventSnapshot | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private lastPrune = 0

  constructor(private readonly d: NotifyEngineDeps) {}

  private get fetch(): HttpFetch {
    return this.d.fetch ?? globalThis.fetch.bind(globalThis)
  }

  start(intervalMs = NOTIFY_TICK_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Evaluate every rule once. Used by the tick and by "test rule" (via testRule). */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const recorded = await this.evaluate()
      if (recorded) this.d.changed?.()
    }
    catch (e) {
      this.d.log?.(`notify tick: ${(e as Error).message}`)
    }
    finally {
      this.ticking = false
    }
  }

  /**
   * Render the rule's templates from the live unit and send to its channels,
   * bypassing trigger, cooldown and quiet hours so the owner can check delivery.
   */
  async testRule(rule: NotificationRule): Promise<{ title: string, message: string, results: Array<{ channelId: number, name: string, ok: boolean, error?: string }> }> {
    const now = this.d.now()
    const clock = this.d.clock()
    const signals = this.d.signals()
    const snap = this.d.snapshot()
    const ctx = this.templateCtx(rule, signals, snap, clock, undefined)
    const title = renderTemplate(rule.titleTemplate, ctx)
    const message = renderTemplate(rule.messageTemplate, ctx)
    const channels = this.channelsFor(rule)
    const results = []
    for (const ch of channels) {
      const r = await sendOnChannel(ch, { title, message, priority: rule.priority }, this.fetch)
      results.push({ channelId: ch.id, name: ch.name, ok: r.ok, error: r.error })
    }
    this.d.recordRun(rule.id, results.some(r => r.ok) ? 'sent' : 'error', { test: true, title, results: results.map(r => ({ channelId: r.channelId, ok: r.ok, error: r.error })) })
    this.d.changed?.()
    void now
    return { title, message, results }
  }

  async testChannel(channel: NotificationChannel): Promise<{ ok: boolean, error?: string }> {
    const name = this.d.unitName()
    return sendOnChannel(channel, {
      title: `Thryve: test (${channel.name})`,
      message: `This is a test from ${name}. If you got this, the ${channel.kind} channel is working.`,
      priority: 'normal',
    }, this.fetch)
  }

  private async evaluate(): Promise<boolean> {
    const rules = this.d.loadRules()
    this.syncRuntime(rules)
    const now = this.d.now()
    const clock = this.d.clock()
    const signals = this.d.signals()
    this.recordWindows(signals, now)
    const snap = this.d.snapshot()
    const fired = edges(this.prev, snap)
    this.prev = snap

    const evctx: EvalContext = {
      signal: k => signals[k],
      windows: this.windows,
      nowMs: now,
      nowMinutes: clock.nowMinutes,
      dayOfWeek: clock.dayOfWeek,
      dateKey: clock.dateKey,
      sustain: this.sustain,
    }

    const globalOn = this.d.enabled()
    const globalQuiet = this.d.globalQuietHours()
    let recorded = false

    for (const rule of rules) {
      const rt = this.runtime.get(rule.id)
      if (!rt) continue
      const match = this.triggerMatch(rule.trigger, rt, evctx, signals, fired, now)
      const cond = evaluateCondition(rule.conditions, evctx, `n${rule.id}:c`)
      const holds = match.holds && cond === true
      const just = match.just && cond === true

      if (!rule.enabled || !globalOn) {
        if (just || (holds && rule.repeatWhileTrue)) {
          recorded = true
          this.d.recordRun(rule.id, 'disabled', { reason: !globalOn ? 'notifications-off' : 'rule-off' })
        }
        continue
      }

      const decision = decideRate({
        nowMs: now,
        nowMinutes: clock.nowMinutes,
        cooldownMin: rule.cooldownMin,
        state: rt.rate,
        dedupKey: match.key,
        justTriggered: just,
        conditionHolds: holds,
        quietHours: rule.quietHours,
        globalQuietHours: globalQuiet,
        ignoreQuietHours: rule.ignoreQuietHours,
        repeatWhileTrue: rule.repeatWhileTrue,
        holdPending: rule.trigger.kind === 'event' || rule.trigger.kind === 'timeOfDay' || rule.trigger.kind === 'signalChange',
      })

      if (decision === 'inactive') continue
      if (decision === 'cooldown' || decision === 'dedup' || decision === 'pending' || decision === 'quiet') {
        recorded = true
        this.d.recordRun(rule.id, decision === 'pending' ? 'quiet' : decision, { key: match.key })
        continue
      }

      const channels = this.channelsFor(rule)
      if (channels.length === 0) {
        recorded = true
        this.d.recordRun(rule.id, 'skipped', { reason: 'no-channels' })
        continue
      }

      const ctx = this.templateCtx(rule, signals, snap, clock, match.event)
      const title = renderTemplate(rule.titleTemplate, ctx)
      const message = renderTemplate(rule.messageTemplate, ctx)
      const results = []
      for (const ch of channels) {
        const r = await sendOnChannel(ch, { title, message, priority: rule.priority }, this.fetch)
        results.push({ channelId: ch.id, name: ch.name, ok: r.ok, error: r.error })
        if (!r.ok) this.d.log?.(redactSecrets(`notify ${rule.name} via ${ch.name}: ${r.error ?? 'failed'}`, secretValues(ch)))
      }
      const ok = results.some(r => r.ok)
      if (ok) markSent(rt.rate, now, match.key)
      recorded = true
      this.d.recordRun(rule.id, ok ? 'sent' : 'error', { title, results, key: match.key })
    }

    if (now - this.lastPrune > 3_600_000) this.lastPrune = now
    return recorded
  }

  private triggerMatch(
    trigger: NotifyTrigger,
    rt: Runtime,
    ctx: EvalContext,
    signals: Record<string, number | undefined>,
    fired: FiredEvent[],
    now: number,
  ): { just: boolean, holds: boolean, key: string, event?: FiredEvent } {
    switch (trigger.kind) {
      case 'tick': {
        const due = now - rt.lastTickEvalMs >= trigger.everyMin * 60_000
        if (due) rt.lastTickEvalMs = now
        return { just: due, holds: due, key: `tick:${trigger.everyMin}` }
      }
      case 'signalChange': {
        const v = signals[trigger.signal]
        const changed = v !== undefined && v !== rt.lastSignal && rt.lastSignal !== undefined
        // First sample just records; a later change is the edge.
        const first = rt.lastSignal === undefined && v !== undefined
        rt.lastSignal = v
        return { just: changed && !first, holds: changed, key: `signal:${trigger.signal}:${v}` }
      }
      case 'timeOfDay': {
        const [h, m] = trigger.at.split(':').map(Number)
        const at = (h ?? 0) * 60 + (m ?? 0)
        const inWindow = ctx.nowMinutes >= at && ctx.nowMinutes <= at + TIME_OF_DAY_GRACE_MIN
        const dayOk = !trigger.days || trigger.days.includes(ctx.dayOfWeek)
        const key = `${ctx.dateKey}:${at}`
        const just = inWindow && dayOk && rt.lastTimeKey !== key
        if (just) rt.lastTimeKey = key
        return { just, holds: inWindow && dayOk, key: `time:${key}` }
      }
      case 'threshold': {
        const v = ctx.signal(trigger.signal)
        const cmp = v === undefined ? undefined : compare(trigger.op, v, trigger.value)
        const held = trigger.forMin && trigger.forMin > 0
          ? ctx.sustain.held(`thr:${rtKey(rt)}`, cmp, trigger.forMin, ctx.nowMs)
          : cmp
        const trueNow = held === true
        const just = trueNow && !rt.lastThreshold
        rt.lastThreshold = trueNow
        return { just, holds: trueNow, key: `threshold:${trigger.signal}:${trigger.op}:${trigger.value}` }
      }
      case 'event': {
        const hit = fired.find(e => eventMatches(trigger, e))
        return { just: !!hit, holds: !!hit, key: hit?.key ?? `event:${trigger.event}`, event: hit }
      }
    }
  }

  private channelsFor(rule: NotificationRule): NotificationChannel[] {
    const all = this.d.loadChannels().filter(c => c.enabled)
    if (rule.channelIds.length === 0) return all
    const want = new Set(rule.channelIds)
    return all.filter(c => want.has(c.id))
  }

  private templateCtx(
    rule: NotificationRule,
    signals: Record<string, number | undefined>,
    snap: EventSnapshot,
    clock: { nowMinutes: number, dateKey: string },
    ev: FiredEvent | undefined,
  ): NotifyTemplateContext {
    const sensor: Record<string, number | undefined> = {}
    for (const [k, v] of Object.entries(signals)) {
      if (k.startsWith('sensor.')) sensor[k.slice('sensor.'.length)] = v
    }
    const hh = String(Math.floor(clock.nowMinutes / 60)).padStart(2, '0')
    const mm = String(clock.nowMinutes % 60).padStart(2, '0')
    return {
      rule: { name: rule.name, id: rule.id },
      event: ev?.event,
      eventLabel: ev ? EVENT_LABELS[ev.event] : undefined,
      alert: ev?.alert,
      unit: { name: this.d.unitName() },
      time: `${hh}:${mm}`,
      date: clock.dateKey,
      update: ev?.update ?? (snap.updateAvailable ? { tag: snap.updateTag } : undefined),
      pod: ev?.pod,
      sensor,
    }
  }

  private recordWindows(signals: Record<string, number | undefined>, now: number): void {
    for (const [k, v] of Object.entries(signals)) {
      if (typeof v === 'number') this.windows.record(k, v, now)
    }
    this.windows.prune(now, 24 * 60)
  }

  private syncRuntime(rules: NotificationRule[]): void {
    const ids = new Set(rules.map(r => r.id))
    for (const id of [...this.runtime.keys()]) {
      if (!ids.has(id)) {
        this.runtime.delete(id)
        this.sustain.reset(`n${id}:`)
      }
    }
    for (const r of rules) {
      const fp = JSON.stringify([r.trigger, r.conditions, r.channelIds, r.priority, r.cooldownMin, r.quietHours, r.repeatWhileTrue])
      const prev = this.runtime.get(r.id)
      if (prev && prev.fingerprint !== fp) {
        this.runtime.delete(r.id)
        this.sustain.reset(`n${r.id}:`)
      }
      if (!this.runtime.has(r.id)) {
        this.runtime.set(r.id, {
          fingerprint: fp,
          rate: { lastSentMs: null, episodeKey: null, pending: false, pendingKey: null },
          lastTriggerSeen: false,
          lastTickEvalMs: 0,
          lastTimeKey: null,
          lastSignal: undefined,
          lastThreshold: false,
        })
      }
    }
  }
}

function compare(op: CompareOp, l: number, r: number): boolean {
  switch (op) {
    case '>': return l > r
    case '>=': return l >= r
    case '<': return l < r
    case '<=': return l <= r
    case '==': return l === r
    case '!=': return l !== r
  }
}

function rtKey(rt: Runtime): string {
  return rt.fingerprint.slice(0, 12)
}

function secretValues(ch: NotificationChannel): string[] {
  const s = ch.secrets as Record<string, unknown>
  const out: string[] = []
  for (const v of Object.values(s)) {
    if (typeof v === 'string') out.push(v)
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x)
  }
  return out
}
