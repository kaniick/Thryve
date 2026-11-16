
import { inTimeWindow } from '../autopilot/evaluator'

export interface RateState {
  /** Last time a message was actually sent for this rule. */
  lastSentMs: number | null
  /** Dedup key of the current episode (cleared when the condition drops). */
  episodeKey: string | null
  /** A fire was held because of quiet hours; send when they end if it still holds. */
  pending: boolean
  pendingKey: string | null
}

export type RateDecision = 'send' | 'pending' | 'cooldown' | 'dedup' | 'quiet' | 'inactive'

export function inQuietHours(nowMinutes: number, hours: { start: string, end: string } | null | undefined): boolean {
  if (!hours) return false
  return inTimeWindow(nowMinutes, hours.start, hours.end)
}

/**
 * Decide whether a rule that has just matched (or is still matching) should
 * send. Edges fire once per episode; `repeatWhileTrue` re-arms after cooldown
 * while the condition holds. Quiet hours hold a send until they end unless
 * `ignoreQuietHours` is set (for emergencies).
 */
export function decideRate(o: {
  nowMs: number
  nowMinutes: number
  cooldownMin: number
  state: RateState
  dedupKey: string
  justTriggered: boolean
  conditionHolds: boolean
  quietHours: { start: string, end: string } | null
  globalQuietHours: { start: string, end: string } | null
  ignoreQuietHours: boolean
  repeatWhileTrue: boolean
  /** Events and time-of-day are pulses: keep a quiet-hours hold until it can send. */
  holdPending?: boolean
}): RateDecision {
  const st = o.state
  if (!o.conditionHolds && !o.justTriggered) {
    if (st.pending && o.holdPending) {
      const quiet = !o.ignoreQuietHours && (inQuietHours(o.nowMinutes, o.quietHours) || inQuietHours(o.nowMinutes, o.globalQuietHours))
      const cooling = st.lastSentMs !== null && o.cooldownMin > 0 && o.nowMs - st.lastSentMs < o.cooldownMin * 60_000
      if (cooling) return 'cooldown'
      if (quiet) return 'pending'
      return 'send'
    }
    st.episodeKey = null
    if (st.pending && !o.holdPending) {
      st.pending = false
      st.pendingKey = null
    }
    return 'inactive'
  }

  const sameEpisode = st.episodeKey === o.dedupKey
  const cooling = st.lastSentMs !== null && o.cooldownMin > 0 && o.nowMs - st.lastSentMs < o.cooldownMin * 60_000
  const quiet = !o.ignoreQuietHours && (inQuietHours(o.nowMinutes, o.quietHours) || inQuietHours(o.nowMinutes, o.globalQuietHours))

  const edge = o.justTriggered && !sameEpisode
  const reminder = o.repeatWhileTrue && o.conditionHolds && sameEpisode && !cooling
  const flushPending = st.pending && st.pendingKey === o.dedupKey && o.conditionHolds && !quiet && !cooling

  if (!edge && !reminder && !flushPending) {
    if (sameEpisode && !o.repeatWhileTrue && (st.lastSentMs !== null || st.pending)) return 'dedup'
    if (cooling && (o.justTriggered || o.conditionHolds)) return 'cooldown'
    return 'inactive'
  }

  if (cooling) return 'cooldown'
  if (quiet) {
    st.pending = true
    st.pendingKey = o.dedupKey
    st.episodeKey = o.dedupKey
    return 'pending'
  }
  return 'send'
}

export function markSent(state: RateState, nowMs: number, key: string): void {
  state.lastSentMs = nowMs
  state.episodeKey = key
  state.pending = false
  state.pendingKey = null
}

export function markEpisode(state: RateState, key: string): void {
  state.episodeKey = key
}
