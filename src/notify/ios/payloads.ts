import type { FeedItem } from './types'

/** What the Thryve iPhone app expects in a push (kaniick/Thryve-ios, Notifications/ and LiveActivity/). */

export const APP_BUNDLE_ID = 'com.thryve.app'
/** The app's notification categories; THRYVE_ALERT carries an Acknowledge button. */
export const ALERT_CATEGORY = 'THRYVE_ALERT'
export const EVENT_CATEGORY = 'THRYVE_EVENT'

/** A banner on the phone, matching the app's local notifications so the two never stack. */
export function alertPayload(item: FeedItem): Record<string, unknown> {
  return {
    aps: {
      'alert': { title: item.title, body: item.body },
      'sound': 'default',
      'thread-id': 'thryve',
      'category': item.alertId !== null ? ALERT_CATEGORY : EVENT_CATEGORY,
    },
    feedId: item.id,
    ...(item.alertId !== null ? { alertId: item.alertId } : {}),
  }
}

/** The watering Live Activity's ContentState (WateringAttributes.ContentState in the app). */
export interface WateringState {
  /** Unix seconds. */
  startedAt: number
  endsAt: number | null
  powerPct: number
  softStartS: number
  running: boolean
  fault: string | null
}

export type LiveActivityEvent = 'start' | 'update' | 'end'

export function liveActivityTopic(bundleId: string): string {
  return `${bundleId}.push-type.liveactivity`
}

/**
 * A liveactivity push. "start" (push-to-start) also names the attributes type
 * and needs an alert; "end" can say when the phone should take it down.
 */
export function liveActivityPayload(event: LiveActivityEvent, state: WateringState, opts: { nowS: number, unitName: string, dismissAtS?: number }): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    'timestamp': opts.nowS,
    'event': event,
    'content-state': state,
  }
  // Past its end with no word from the unit, the phone shows it as stale.
  if (state.endsAt != null && event !== 'end') aps['stale-date'] = Math.round(state.endsAt + 60)
  if (event === 'start') {
    aps['attributes-type'] = 'WateringAttributes'
    aps['attributes'] = { unitName: opts.unitName }
    aps['alert'] = { title: 'Watering', body: `${opts.unitName}'s pump is running at ${state.powerPct}%.` }
  }
  if (event === 'end') aps['dismissal-date'] = opts.dismissAtS ?? opts.nowS + 60
  return { aps }
}
