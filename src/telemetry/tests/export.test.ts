import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { telemetryExportFilename, telemetryExportStream } from '../export'
import type { TelemetryPoint } from '../../store/types'

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  return out + dec.decode()
}

describe('telemetry export', () => {
  it('streams csv and json of every point, optionally one sensor, without downsampling', async () => {
    const store = new MemoryStore()
    const pts: TelemetryPoint[] = [
      { ts: '2026-11-10T00:00:00.000Z', sensor: 'air_temp', value: 21 },
      { ts: '2026-11-10T00:01:00.000Z', sensor: 'air_temp', value: 22 },
      { ts: '2026-11-10T00:00:00.000Z', sensor: 'ph', value: 6.1 },
    ]
    store.telemetry.add(pts)
    const csv = await readStream(telemetryExportStream(store, {
      from: '2026-11-10T00:00:00.000Z',
      to: '2026-11-10T00:01:00.000Z',
      sensor: 'air_temp',
      format: 'csv',
    }))
    expect(csv).toBe('sensor,ts,value\nair_temp,2026-11-10T00:00:00.000Z,21\nair_temp,2026-11-10T00:01:00.000Z,22\n')
    const json = await readStream(telemetryExportStream(store, {
      from: '2026-11-10T00:00:00.000Z',
      to: '2026-11-10T01:00:00.000Z',
      format: 'json',
    }))
    expect(JSON.parse(json)).toEqual(expect.arrayContaining([
      { sensor: 'air_temp', ts: '2026-11-10T00:00:00.000Z', value: 21 },
      { sensor: 'air_temp', ts: '2026-11-10T00:01:00.000Z', value: 22 },
      { sensor: 'ph', ts: '2026-11-10T00:00:00.000Z', value: 6.1 },
    ]))
    expect(telemetryExportFilename({ from: '', to: '', format: 'csv' })).toBe('thryve-telemetry-all.csv')
    expect(telemetryExportFilename({ from: '', to: '', sensor: 'ph', format: 'json' })).toBe('thryve-telemetry-ph.json')
  })
})
