// Run with tsx in a checkout. Uses a new synthetic DB, never the unit's data.
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CareEngine } from '../../src/care/engine'
import { SimHal } from '../../src/hardware/sim'
import { createEventBus } from '../../src/lib/eventBus'
import { SqliteStore } from '../../src/store/sqlite'

const temp = mkdtempSync(join(tmpdir(), 'thryve-perf-'))
const url = join(temp, 'fixture.db')
const now = new Date('2026-11-24T20:00:00.000Z')
const to = now.toISOString()
const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString()
const store = new SqliteStore({ url })
const db = new Database(url)

function bench(name: string, repeats: number, run: () => void) {
  for (let i = 0; i < 3; i++) run()
  const values: number[] = []
  for (let i = 0; i < repeats; i++) {
    const start = performance.now()
    run()
    values.push(performance.now() - start)
  }
  values.sort((a, b) => a - b)
  console.log(`${name}: median ${values[Math.floor(repeats / 2)]?.toFixed(3)} ms over ${repeats} runs`)
}

try {
  const write = {
    ts: db.prepare('INSERT INTO telemetry (ts, sensor, value) VALUES (?, ?, ?)'),
    quality: db.prepare('INSERT INTO sensor_quality (ts, sensor, quality) VALUES (?, ?, ?)'),
    alert: db.prepare('INSERT INTO alerts (kind, active, detail, raisedAt) VALUES (?, 0, ?, ?)'),
    vision: db.prepare('INSERT INTO analysis_results (captureId, camera, ts, analyzer, version, slot, metric, value, source) VALUES (?, \'upper\', ?, \'green-threshold\', 1, ?, \'green_fraction\', 0.16, \'device\')'),
  }
  db.transaction(() => {
    for (let i = 104_228; i > 0; i--) write.ts.run(at(i), 'water_level_pct', 75 + i % 3)
    for (let i = 83_905; i > 0; i--) write.quality.run(at(i / 6), 'water_level_pct', i % 10 ? 'good' : 'suspect')
    for (let i = 4_718; i > 0; i--) write.alert.run('isolated-test-alert', 'Historical alert', at(i))
    for (let i = 0; i < 16_260; i++) write.vision.run(`still-${i}`, at(i / 30), i % 30 + 1)
  })()
  for (let slot = 1; slot <= 30; slot++) store.pods.update(slot, { plant: 'Basil', status: 'seeded', plantedAt: at(2 * 1440) }, to)
  const hal = new SimHal({ tickMs: 0, now: () => now })
  const snapshot = hal.snapshot.bind(hal)
  hal.snapshot = () => {
    const state = snapshot()
    return { ...state, sensors: { ...state.sensors, water_level_pct: { ts: to, value: 70, unit: '%', quality: 'good' } } }
  }
  const care = new CareEngine({ store, hal, events: createEventBus(), now: () => now })
  store.telemetry.add([{ ts: to, sensor: 'water_level_pct', value: 70 }])
  bench('Care check, 30 young pods', 30, () => care.tick())
  bench('Settings read x100', 30, () => {
    for (let i = 0; i < 100; i++) store.settings.get()
  })
  bench('Tank quality, 1 hour', 30, () => store.sensorQuality.trustedShare('water_level_pct', to, 3600))
  bench('Telemetry chart, 30 days to 500 points', 30, () => store.telemetry.range('water_level_pct', at(30 * 1440), to, 500))
}
finally {
  db.close()
  store.close()
  rmSync(temp, { recursive: true, force: true })
}
