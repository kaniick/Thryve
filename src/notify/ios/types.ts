/**
 * The Thryve iPhone app as a notification channel ("ios"). Browser-safe: the
 * APNs client itself (node:crypto, node:http2) lives in ../apns/client.ts and
 * is handed in on node hosts only.
 */

export type ApnsEnvironment = 'sandbox' | 'production'

export interface ApnsKey {
  /** The AuthKey_XXXXXXXXXX.p8 contents (PEM). */
  p8: string
  /** The key's 10-character Key ID. */
  keyId: string
  /** The Apple Developer team ID. */
  teamId: string
}

export interface ApnsRequest {
  token: string
  environment: ApnsEnvironment
  /** apns-topic: the bundle ID, or `<bundle>.push-type.liveactivity` for Live Activities. */
  topic: string
  pushType: 'alert' | 'liveactivity' | 'background'
  payload: Record<string, unknown>
  /** 10 shows now; 5 lets the phone save power. */
  priority?: 5 | 10
  collapseId?: string
  /** Unix seconds after which Apple stops trying; 0 = once. */
  expiration?: number
}

export interface ApnsResult {
  ok: boolean
  status: number
  /** Apple's reason, e.g. "BadDeviceToken", "Unregistered", "InvalidProviderToken". */
  reason?: string
  apnsId?: string
}

/** Sends one push. On node hosts, ApnsClient; absent in the browser demo and most tests. */
export interface ApnsSender {
  send(key: ApnsKey, req: ApnsRequest): Promise<ApnsResult>
}

/** The token is dead for good: forget it rather than retry. */
export function isDeadToken(r: ApnsResult): boolean {
  return r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.reason === 'DeviceTokenNotForTopic'
}

/** An iPhone running the Thryve app, registered with this unit. */
export interface IosDevice {
  /** A random id the app makes on install. */
  deviceId: string
  name: string
  /** The APNs device token (hex), or null when the phone only checks in (background checks). */
  token: string | null
  environment: ApnsEnvironment
  bundleId: string
  createdAt: string
  updatedAt: string
}

/** An ActivityKit push token: "start" (push-to-start, one per phone) or "update" (one running activity). */
export interface ActivityToken {
  deviceId: string
  kind: 'start' | 'update'
  /** Set for "update" tokens. */
  activityId: string | null
  token: string
  environment: ApnsEnvironment
  updatedAt: string
}

export type FeedLevel = 'info' | 'warning' | 'critical'

/** One notification for the phones, kept so an app without push can catch up. */
export interface FeedItem {
  id: number
  title: string
  body: string
  level: FeedLevel
  /** The alert it's about, so the banner can acknowledge it. */
  alertId: number | null
  createdAt: string
}
