import { setImmediate } from 'node:timers/promises'
import { SensorId } from '../hardware/contract'
import type { Store, TelemetryPoint } from '../store/types'

export interface TelemetryExportOpts {
  from: string
  to: string
  sensor?: string
  format: 'csv' | 'json'
}

const ROWS_PER_CHUNK = 128

/** Stream without queuing all history on the event loop or in memory. */
export function telemetryExportStream(store: Store, opts: TelemetryExportOpts): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const ids = opts.sensor ? [opts.sensor as TelemetryPoint['sensor']] : SensorId.options
  const csv = opts.format === 'csv'
  const scans = ids.map(id => store.telemetry.scan(id, opts.from, opts.to))
  let canceled = false

  function* chunks() {
    let text = csv ? 'sensor,ts,value\n' : '['
    let first = true
    let rows = 0
    for (const scan of scans) {
      for (const { sensor, ts, value } of scan) {
        text += csv ? `${sensor},${ts},${value}\n` : `${first ? '' : ','}${JSON.stringify({ sensor, ts, value })}`
        first = false
        if (++rows === ROWS_PER_CHUNK) {
          yield text
          text = ''
          rows = 0
        }
      }
    }
    if (!csv) text += ']'
    if (text) yield text
  }

  const iterator = chunks()
  return new ReadableStream({
    async pull(controller) {
      // Let actuator timers and HTTP handlers run even with a fast downloader.
      await setImmediate()
      if (canceled) return
      const chunk = iterator.next()
      if (chunk.done) controller.close()
      else controller.enqueue(enc.encode(chunk.value))
    },
    cancel() {
      canceled = true
      iterator.return()
    },
  })
}

export function telemetryExportFilename(opts: TelemetryExportOpts): string {
  const who = opts.sensor ?? 'all'
  const ext = opts.format === 'json' ? 'json' : 'csv'
  return `thryve-telemetry-${who}.${ext}`
}
