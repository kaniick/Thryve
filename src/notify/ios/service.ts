/**
 * The "ios" notification channel: the Thryve iPhone app.
 *
 * Every notification a rule sends here goes into a small feed the app reads
 * over the LAN (`notifications.feed`), so phones without push still catch up in
 * the background. When the owner has saved an APNs key, it is also pushed
 * through Apple to every registered phone, straight from the unit.
 *
 * It also drives the app's watering Live Activity over APNs: push-to-start when
 * the pump starts, updates when the run changes, and an end when it stops.
 */
import type { ActuatorState } from '../../hardware/contract'
import type { HalClient } from '../../hardware/types'
import type { EventBus } from '../../lib/eventBus'
import type { Store } from '../../store/types'
import type { SendRequest, SendResult } from '../providers/http'
import type { IosConfig, IosSecrets, NotificationChannel } from '../types'
import { alertPayload, APP_BUNDLE_ID, liveActivityPayload, liveActivityTopic, type LiveActivityEvent, type WateringState } from './payloads'
import { isDeadToken, type ActivityToken, type ApnsEnvironment, type ApnsKey, type ApnsSender, type FeedItem, type FeedLevel, type IosDevice } from './types'

/** How many notifications the feed keeps for phones to catch up on. */
export const FEED_KEEP = 200
/** Give a running app this long to start the Live Activity itself before push-to-start does. */
export const PUSH_TO_START_DELAY_MS = 5_000

export interface DeviceRegistration {
  deviceId: string
  name: string
  token?: string | null
  environment: ApnsEnvironment
  bundleId?: string
}

export interface IosServiceDeps {
  store: Store
  /** The APNs client; node hosts only. Without it the feed still works. */
  apns?: ApnsSender | null
  now?: () => Date
  log?: (m: string) => void
}

const LEVEL: Record<SendRequest['priority'], FeedLevel> = { lowest: 'info', low: 'info', normal: 'info', high: 'warning', emergency: 'critical' }

/** A whole APNs key from an iOS channel, or null when any part is missing. */
export function channelKey(ch: NotificationChannel): { key: ApnsKey, bundleId: string } | null {
  if (ch.kind !== 'ios' || !ch.enabled) return null
  const cfg = ch.config as IosConfig
  const secrets = ch.secrets as IosSecrets
  if (!secrets.apnsKey || !cfg.keyId || !cfg.teamId) return null
  return { key: { p8: secrets.apnsKey, keyId: cfg.keyId, teamId: cfg.teamId }, bundleId: cfg.bundleId || APP_BUNDLE_ID }
}

export class IosService {
  private lastPump: { on: boolean, state: WateringState | null } = { on: false, state: null }
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly d: IosServiceDeps) {}

  private get store() {
    return this.d.store.notifications.ios
  }

  private nowIso(): string {
    return (this.d.now?.() ?? new Date()).toISOString()
  }

  private nowS(): number {
    return Math.floor((this.d.now?.() ?? new Date()).getTime() / 1000)
  }

  /** The key push uses: the first enabled iOS channel that has one. */
  key(): { key: ApnsKey, bundleId: string } | null {
    for (const ch of this.d.store.notifications.channels.list()) {
      const k = channelKey(ch)
      if (k) return k
    }
    return null
  }

  /** True when the unit can push: an APNs key saved and an APNs client on this host. */
  get apnsConfigured(): boolean {
    return !!this.d.apns && this.key() !== null
  }

  register(r: DeviceRegistration): { apnsConfigured: boolean } {
    this.store.devices.upsert({
      deviceId: r.deviceId,
      name: r.name,
      token: r.token ?? null,
      environment: r.environment,
      bundleId: r.bundleId || APP_BUNDLE_ID,
    }, this.nowIso())
    return { apnsConfigured: this.apnsConfigured }
  }

  unregister(deviceId: string): boolean {
    this.store.activityTokens.removeDevice(deviceId)
    return this.store.devices.remove(deviceId)
  }

  registerActivityToken(t: Omit<ActivityToken, 'updatedAt'>): void {
    if (!this.store.devices.get(t.deviceId)) return
    this.store.activityTokens.upsert(t, this.nowIso())
  }

  feed(afterId: number | null, limit = 20): { items: FeedItem[], latestId: number | null } {
    return { items: afterId === null ? [] : this.store.feed.after(afterId, limit), latestId: this.store.feed.latestId() }
  }

  /** The alert a notification is about, for the banner's Acknowledge button. */
  private alertIdFor(kind: string | undefined): number | null {
    if (!kind) return null
    return this.d.store.alerts.list({ activeOnly: true }).find(a => a.kind === kind)?.id ?? null
  }

  private addToFeed(title: string, body: string, level: FeedLevel, alertId: number | null): FeedItem {
    const item = this.store.feed.add({ title, body, level, alertId, createdAt: this.nowIso() })
    this.store.feed.prune(FEED_KEEP)
    return item
  }

  /** sendOnChannel for kind "ios". */
  async send(channel: NotificationChannel, req: SendRequest): Promise<SendResult> {
    const item = this.addToFeed(req.title, req.message, LEVEL[req.priority], this.alertIdFor(req.alertKind))
    const key = channelKey(channel) ?? this.key()
    const phones = this.store.devices.list().filter(p => p.token)
    if (!this.d.apns || !key || phones.length === 0) return { ok: true, id: `feed-${item.id}` }
    const results = await Promise.all(phones.map(p => this.pushAlert(p, item, key)))
    const pushed = results.filter(Boolean).length
    if (pushed === 0) return { ok: false, id: `feed-${item.id}`, error: `APNs refused all ${phones.length} iPhone(s); they'll still get it from the feed` }
    return { ok: true, id: `feed-${item.id}` }
  }

  /** "Send a test notification" in the app. */
  async test(deviceId: string): Promise<{ sent: boolean, via: 'apns' | 'feed' }> {
    const unit = this.d.store.settings.get().unitName
    const item = this.addToFeed('Thryve', `Test from ${unit}: notifications are working on this iPhone.`, 'info', null)
    const phone = this.store.devices.get(deviceId)
    const key = this.key()
    if (!phone?.token || !this.d.apns || !key) return { sent: false, via: 'feed' }
    return { sent: await this.pushAlert(phone, item, key), via: 'apns' }
  }

  private async pushAlert(phone: IosDevice, item: FeedItem, key: { key: ApnsKey, bundleId: string }): Promise<boolean> {
    if (!phone.token || !this.d.apns) return false
    const r = await this.d.apns.send(key.key, {
      token: phone.token,
      environment: phone.environment,
      topic: phone.bundleId || key.bundleId,
      pushType: 'alert',
      payload: alertPayload(item),
      priority: 10,
      // The app's local notifications use the same id, so a push and a check never stack.
      collapseId: `thryve-${item.id}`,
    })
    if (!r.ok) {
      this.d.log?.(`apns: ${phone.name}: ${r.status} ${r.reason ?? ''}`.trim())
      if (isDeadToken(r)) this.store.devices.setToken(phone.deviceId, null, this.nowIso())
    }
    return r.ok
  }

  // MARK: Live Activity

  /** Follows the pump and keeps the phones' watering Live Activities current. */
  attach(o: { events: EventBus, hal: HalClient }): void {
    this.unsubscribe?.()
    this.unsubscribe = o.events.subscribe((e) => {
      if (e.kind === 'hal' && e.event.type === 'actuator' && e.event.id === 'pump') void this.pumpChanged(e.event.state)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  /** The Live Activity's content for a pump reading (WateringAttributes.ContentState in the app). */
  wateringState(pump: ActuatorState): WateringState {
    const s = this.d.store.settings.get()
    const started = Date.parse(pump.since)
    const now = this.nowS()
    return {
      startedAt: Number.isFinite(started) ? Math.floor(started / 1000) : now,
      endsAt: pump.remainingS !== null ? now + pump.remainingS : null,
      powerPct: Math.round(pump.level),
      softStartS: s.pumpSoftStart ? s.pumpSoftStartMs / 1000 : 0,
      running: pump.on,
      fault: pump.fault,
    }
  }

  async pumpChanged(pump: ActuatorState): Promise<void> {
    const prev = this.lastPump
    const running = pump.on && pump.level > 0
    if (running) {
      const state = this.wateringState(pump)
      this.lastPump = { on: true, state }
      if (!prev.on) {
        // Updates go to activities the app already started; push-to-start waits a moment for one.
        await this.sendActivity('update', state)
        if (this.startTimer) clearTimeout(this.startTimer)
        this.startTimer = setTimeout(() => {
          this.startTimer = null
          if (this.lastPump.on) void this.pushToStart()
        }, PUSH_TO_START_DELAY_MS)
      }
      else if (prev.state && changed(prev.state, state)) {
        await this.sendActivity('update', state)
      }
      return
    }
    if (!prev.on) return
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    const last = prev.state ?? this.wateringState(pump)
    const now = this.nowS()
    const final: WateringState = { ...last, running: false, fault: pump.fault, endsAt: Math.min(last.endsAt ?? now, now) }
    this.lastPump = { on: false, state: null }
    await this.sendActivity('end', final, pump.fault ? now + 15 * 60 : now + 60)
    this.store.activityTokens.removeKind('update')
  }

  /** Push-to-start on phones that have no running watering activity yet. */
  async pushToStart(): Promise<void> {
    const state = this.lastPump.state
    if (!state) return
    const tokens = this.store.activityTokens.list()
    const running = new Set(tokens.filter(t => t.kind === 'update').map(t => t.deviceId))
    await this.pushActivity(tokens.filter(t => t.kind === 'start' && !running.has(t.deviceId)), 'start', state)
  }

  private async sendActivity(event: LiveActivityEvent, state: WateringState, dismissAtS?: number): Promise<void> {
    await this.pushActivity(this.store.activityTokens.list().filter(t => t.kind === 'update'), event, state, dismissAtS)
  }

  private async pushActivity(tokens: ActivityToken[], event: LiveActivityEvent, state: WateringState, dismissAtS?: number): Promise<void> {
    const key = this.key()
    const apns = this.d.apns
    if (!apns || !key || tokens.length === 0) return
    const unitName = this.d.store.settings.get().unitName
    await Promise.all(tokens.map(async (t) => {
      const phone = this.store.devices.get(t.deviceId)
      const r = await apns.send(key.key, {
        token: t.token,
        environment: t.environment,
        topic: liveActivityTopic(phone?.bundleId || key.bundleId),
        pushType: 'liveactivity',
        payload: liveActivityPayload(event, state, { nowS: this.nowS(), unitName, dismissAtS }),
        priority: 10,
      })
      if (!r.ok) {
        this.d.log?.(`apns liveactivity ${event}: ${r.status} ${r.reason ?? ''}`.trim())
        if (isDeadToken(r)) this.store.activityTokens.removeToken(t.token)
      }
    }))
  }
}

/** Only what the unit changed: a new end (beyond clock jitter), power or fault. */
export function changed(a: WateringState, b: WateringState): boolean {
  return Math.abs((a.endsAt ?? 0) - (b.endsAt ?? 0)) > 3 || a.powerPct !== b.powerPct || a.fault !== b.fault || a.running !== b.running
}
