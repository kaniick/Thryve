/**
 * Process-wide event bus (ADR-0015): every mutation and every HAL event is
 * broadcast here, and the UI subscribes over SSE (tRPC subscription) so it
 * never polls.
 */
import type { HalEvent } from '../hardware/types'

export type CoreEvent
  = | { kind: 'hal', event: HalEvent }
    | { kind: 'mutation', path: string }
    | { kind: 'schedule', action: 'fired' | 'changed', id: string }
    // A step of an update (ADR-0026), with the helper's new log lines.
    | { kind: 'update', state: string, lines: string[] }

export interface EventBus {
  emit(e: CoreEvent): void
  subscribe(l: (e: CoreEvent) => void): () => void
}

const LISTENER_ERROR_LOG_MS = 60_000

export function createEventBus(): EventBus {
  const lastErrorAt = new WeakMap<(e: CoreEvent) => void, number>()
  const listeners = new Set<(e: CoreEvent) => void>()
  return {
    emit(e) {
      for (const l of listeners) {
        try {
          l(e)
        }
        catch (err) {
          // Notifications are independent: a failed subscriber must not drop
          // the event for everyone else or escape an MQTT/HTTP callback.
          const now = performance.now()
          if (now - (lastErrorAt.get(l) ?? -Infinity) >= LISTENER_ERROR_LOG_MS) {
            lastErrorAt.set(l, now)
            console.warn(`core event subscriber failed (${e.kind}): ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}
