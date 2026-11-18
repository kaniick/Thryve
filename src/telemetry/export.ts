import { SensorId } from '../hardware/contract'
import type { Store, TelemetryPoint } from '../store/types'

export interface TelemetryExportOpts {
  from: string
  to: string
  sensor?: string
  format: 'csv' | 'json'
}

function points(store: Store, sensor: string, from: string, to: string): TelemetryPoint[] {
  return store.telemetry.range(sensor as TelemetryPoint['sensor'], from, to, -1)
}

/** Streamed CSV or JSON (an array) of telemetry points, not downsampled. */
export function telemetryExportStream(store: Store, opts: TelemetryExportOpts): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const ids = opts.sensor ? [opts.sensor] : [...(SensorId.options as string[])]
  const format = opts.format
  return new ReadableStream({
    start(controller) {
      const push = (s: string) => controller.enqueue(enc.encode(s))
      try {
        if (format === 'csv') {
          push('sensor,ts,value\n')
          for (const id of ids) {
            for (const p of points(store, id, opts.from, opts.to)) {
              push(`${id},${p.ts},${p.value}\n`)
            }
          }
        }
        else {
          push('[')
          let first = true
          for (const id of ids) {
            for (const p of points(store, id, opts.from, opts.to)) {
              push(`${first ? '' : ','}${JSON.stringify({ sensor: id, ts: p.ts, value: p.value })}`)
              first = false
            }
          }
          push(']')
        }
        controller.close()
      }
      catch (e) {
        controller.error(e)
      }
    },
  })
}

export function telemetryExportFilename(opts: TelemetryExportOpts): string {
  const who = opts.sensor ?? 'all'
  const ext = opts.format === 'json' ? 'json' : 'csv'
  return `thryve-telemetry-${who}.${ext}`
}
