import { describe, expect, it } from 'vitest'
import { decideRate, markSent, type RateState } from '../cooldown'

function state(): RateState {
  return { lastSentMs: null, episodeKey: null, pending: false, pendingKey: null }
}

const base = {
  nowMs: 1_000_000,
  nowMinutes: 12 * 60,
  cooldownMin: 60,
  dedupKey: 'tank-low',
  justTriggered: true,
  conditionHolds: true,
  quietHours: null as { start: string, end: string } | null,
  globalQuietHours: null as { start: string, end: string } | null,
  ignoreQuietHours: false,
  repeatWhileTrue: false,
}

describe('notification rate limiting', () => {
  it('sends on the rising edge, then dedups the same episode', () => {
    const st = state()
    expect(decideRate({ ...base, state: st })).toBe('send')
    markSent(st, base.nowMs, 'tank-low')
    expect(decideRate({ ...base, state: st, nowMs: base.nowMs + 1_000, justTriggered: false, conditionHolds: true })).toBe('dedup')
  })

  it('blocks a re-trigger inside the cooldown, then allows a new episode', () => {
    const st = state()
    markSent(st, base.nowMs, 'tank-low')
    st.episodeKey = null
    expect(decideRate({ ...base, state: st, nowMs: base.nowMs + 10 * 60_000, justTriggered: true })).toBe('cooldown')
    expect(decideRate({ ...base, state: st, nowMs: base.nowMs + 61 * 60_000, justTriggered: true })).toBe('send')
  })

  it('holds an event during quiet hours and flushes when they end', () => {
    const st = state()
    const quiet = { start: '22:00', end: '07:00' }
    expect(decideRate({ ...base, state: st, nowMinutes: 23 * 60, quietHours: quiet, holdPending: true })).toBe('pending')
    expect(st.pending).toBe(true)
    // Pulse is over on the next tick, but the event should still send after 07:00.
    expect(decideRate({ ...base, state: st, nowMinutes: 8 * 60, justTriggered: false, conditionHolds: false, quietHours: quiet, holdPending: true })).toBe('send')
  })

  it('drops a pending threshold when the condition clears during quiet hours', () => {
    const st = state()
    const quiet = { start: '22:00', end: '07:00' }
    expect(decideRate({ ...base, state: st, nowMinutes: 23 * 60, quietHours: quiet })).toBe('pending')
    expect(decideRate({ ...base, state: st, nowMinutes: 23 * 60 + 1, justTriggered: false, conditionHolds: false, quietHours: quiet })).toBe('inactive')
    expect(st.pending).toBe(false)
  })

  it('ignores quiet hours when asked, and re-arms while true after cooldown', () => {
    const st = state()
    const quiet = { start: '22:00', end: '07:00' }
    expect(decideRate({ ...base, state: st, nowMinutes: 23 * 60, quietHours: quiet, ignoreQuietHours: true })).toBe('send')
    markSent(st, base.nowMs, 'tank-low')
    expect(decideRate({ ...base, state: st, nowMs: base.nowMs + 61 * 60_000, justTriggered: false, conditionHolds: true, repeatWhileTrue: true })).toBe('send')
  })
})
