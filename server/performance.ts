import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const RESOLUTION_MS = 100
const WINDOW_MS = 30_000
const LOG_AT_MS = 1_000

export interface CorePerformanceWindow {
  endedAt: string
  windowMs: number
  eventLoopUtilization: number
  p95LagMs: number
  maxLagMs: number
}

/** A constant-memory view of Core's main loop, without polling SQLite or HAL. */
export function startCorePerformance(onStall: (window: CorePerformanceWindow) => void = (window) => {
  console.warn(`core: event loop delayed up to ${window.maxLagMs}ms in the last ${window.windowMs}ms`)
}) {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()
  let started = performance.now()
  let previous = performance.eventLoopUtilization()
  let latest: CorePerformanceWindow | null = null

  const timer = setInterval(() => {
    const now = performance.now()
    const utilization = performance.eventLoopUtilization()
    if (histogram.count) {
      const lag = (ns: number) => Math.max(0, Math.round(ns / 1e6 - RESOLUTION_MS))
      latest = {
        endedAt: new Date().toISOString(),
        windowMs: Math.round(now - started),
        eventLoopUtilization: Math.round(performance.eventLoopUtilization(utilization, previous).utilization * 1000) / 1000,
        p95LagMs: lag(histogram.percentile(95)),
        maxLagMs: lag(histogram.max),
      }
      if (latest.maxLagMs >= LOG_AT_MS) onStall(latest)
    }
    histogram.reset()
    previous = utilization
    started = now
  }, WINDOW_MS)
  timer.unref()

  return {
    latest: () => latest,
    stop() {
      clearInterval(timer)
      histogram.disable()
    },
  }
}
