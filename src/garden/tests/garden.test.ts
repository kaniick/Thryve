import Database from 'better-sqlite3'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Reading } from '../../hardware/contract'
import type { HalSnapshot } from '../../hardware/types'
import { MemoryStore } from '../../store/memory'
import { defaultMigrationsFolder, SqliteStore } from '../../store/sqlite'
import type { AnalysisRow, Capture, Store } from '../../store/types'
import { swapPodRecords } from '../../vision/podOrder'
import { activity } from '../activity'
import { parseObserver } from '../observer'
import { plantHistory } from '../plantHistory'
import { readiness } from '../readiness'
import { visionReview } from '../visionReview'

const NOW = new Date('2026-11-26T12:00:00Z')
const HOUR = 3_600_000
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString()
const through = (hours: number) => new Date(at(-hours))
const frame = (id: string, camera: Capture['camera'], hoursAgo: number): Capture => ({ id, camera, ts: at(hoursAgo), path: id + '.jpg', bytes: 1 })
const gardens: SqliteStore[] = []
const dirs: string[] = []
const dir = () => {
  const root = mkdtempSync(join(tmpdir(), 'thryve-garden-'))
  dirs.push(root)
  return root
}
const sqlite = (url = ':memory:', migrationsFolder?: string) => {
  const store = new SqliteStore({ url, migrationsFolder })
  gardens.push(store)
  return store
}

afterEach(() => {
  for (const s of gardens.splice(0)) s.close()
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true })
})

function plant(store: Store, slot: number, name: string, start = 60) {
  return store.pods.update(slot, { plant: name, status: 'seeded', plantedAt: at(start).slice(0, 10) }, at(start))
}
function enableWater(store: Store) {
  store.schedules.upsert({ id: 'daily', name: 'Morning water', kind: 'pump', enabled: true, days: 127, spec: { minute: 480, durationS: 120, level: 100 } })
}

describe.each([['memory', () => new MemoryStore()], ['SQLite', () => sqlite()]] as const)('plant history in %s', (_, open) => {
  it('follows a cross-camera swap and limits photos to each half-open occupancy window', () => {
    const store = open()
    plant(store, 1, 'Rosemary')
    plant(store, 16, 'Basil')
    const rosemary = store.plantJournal.active().find(l => l.slot === 1)
    if (!rosemary) throw new Error('missing rosemary')
    store.pods.update(1, { notes: 'Trimmed roots' }, at(36))
    store.pods.update(1, { lastHarvestAt: at(34) }, at(34))
    for (const c of [frame('before-sowing', 'upper', 61), frame('upper-before', 'upper', 49), frame('upper-at-move', 'upper', 24), frame('lower-before', 'lower', 25), frame('lower-at-move', 'lower', 24), frame('lower-after-move', 'lower', 20), frame('lower-after-remove', 'lower', 8)]) {
      store.captures.add(c)
    }
    swapPodRecords(store, 1, 16, at(24))
    expect(store.pods.list().find(p => p.slot === 16)).toMatchObject({ plant: 'Rosemary', lastHarvestAt: at(34), notes: 'Trimmed roots' })
    store.pods.update(16, { status: 'empty', plant: null, plantedAt: null }, at(12))
    plant(store, 16, 'Rosemary', 7)
    const got = plantHistory(store, rosemary.id)
    expect(got?.life).toMatchObject({ plant: 'Rosemary', slot: null, endedAt: at(12) })
    expect(got?.events.map(e => e.kind)).toEqual(['sowed', 'note', 'harvested', 'moved', 'removed'])
    expect(got?.events.find(e => e.kind === 'moved')).toMatchObject({ slot: 16, fromSlot: 1, at: at(24) })
    expect(got?.visits.map(v => [v.slot, v.photos.map(p => p.id)])).toEqual([[16, ['lower-at-move', 'lower-after-move']], [1, ['upper-before']]])
    expect(store.plantJournal.archive(30).map(l => l.id)).toEqual([rosemary.id])
    expect(store.plantJournal.active().find(l => l.slot === 16)?.id).not.toBe(rosemary.id)
  })

  it('retains both identities in a batch and rejects invalid moves without applying any part of them', () => {
    const store = open()
    const a = plant(store, 1, 'Basil')
    const b = plant(store, 2, 'Parsley')
    expect(() => store.pods.apply([{ slot: 2, fromSlot: 1, patch: { plant: a.plant } }], at(20))).toThrow(/source and destination/)
    expect(store.plantJournal.active().map(l => l.slot)).toEqual([1, 2])
    store.pods.apply([
      { slot: 1, patch: { plant: b.plant, plantedAt: b.plantedAt, status: b.status }, fromSlot: 2 },
      { slot: 2, patch: { status: 'empty', plant: null, plantedAt: null } },
      { slot: 16, patch: { plant: a.plant, plantedAt: a.plantedAt, status: a.status }, fromSlot: 1 },
    ], at(12))
    expect(store.pods.list().filter(p => [1, 2, 16].includes(p.slot)).map(p => p.plant)).toEqual(['Parsley', null, 'Basil'])
    expect(store.plantJournal.active().map(l => [l.plant, l.slot]).sort()).toEqual([['Basil', 16], ['Parsley', 1]])
  })
})

it('migrates legacy plants without guessing past occupancy, and persists events over Core restarts', () => {
  const base = dir()
  const legacy = join(base, 'old-migrations')
  cpSync(defaultMigrationsFolder(), legacy, { recursive: true })
  const journalFile = join(legacy, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
  journal.entries = journal.entries.filter((e: { tag: string }) => !e.tag.startsWith('0031_'))
  writeFileSync(journalFile, JSON.stringify(journal))
  const file = join(base, 'garden.db')
  const old = sqlite(file, legacy)
  old.close()
  gardens.pop()
  const db = new Database(file)
  db.prepare('UPDATE pods SET plant = ?, plantedAt = ?, status = ?, notes = ? WHERE slot = 24').run('Rosemary', '2026-11-16', 'seeded', 'Started from a yCube')
  db.prepare('UPDATE pods SET plant = ? WHERE slot = 2').run('A draft plant')
  db.close()
  const upgraded = sqlite(file)
  const life = upgraded.plantJournal.active()[0]
  if (!life) throw new Error('missing adopted plant')
  expect(upgraded.plantJournal.active()).toMatchObject([{ plant: 'Rosemary', slot: 24, plantedAt: '2026-11-16' }])
  expect(upgraded.plantJournal.events(life.id)).toMatchObject([{ kind: 'recorded', note: 'Started from a yCube' }])
  expect(plantHistory(upgraded, life.id)?.visits[0]?.from).toBe(life.startedAt)
  upgraded.diagnostics.recordCoreStart({ at: life.startedAt, version: 'field-1' })
  upgraded.close()
  gardens.pop()
  const reopened = sqlite(file)
  expect(reopened.plantJournal.active()).toEqual([life])
  expect(reopened.diagnostics.coreStarts(5)).toEqual([{ at: life.startedAt, version: 'field-1' }])
})

describe('Garden Activity', () => {
  it('merges real diagnostics and does not invent a boot time from an unsynced log', () => {
    const store = sqlite()
    enableWater(store)
    const run = { key: 'daily:1', scheduleId: 'daily', firedAt: at(4), result: 'fired' }
    store.schedules.recordRun(run)
    store.diagnostics.recordAttempt({ runKey: run.key, attempt: 1, at: at(4), result: 'refused', reason: 'interlock', reportedStart: null, requestedS: 120 })
    store.diagnostics.recordAttempt({ runKey: run.key, attempt: 2, at: at(3), result: 'accepted', reason: null, reportedStart: at(3), requestedS: 120 })
    store.pumpRuns.open(at(3), 100, [run])
    store.pumpRuns.close(at(3 - 120 / 3_600), null)
    store.diagnostics.recordLight({ at: at(4), target: 65, reported: 40, source: 'schedule', fault: null, outcome: 'not-matched' })
    store.alerts.raise('water_low', 'level warning', at(5))
    store.alerts.clear('water_low', at(1))
    store.captures.add(frame('top', 'upper', 3))
    store.diagnostics.markFrame('top', 'failed')
    store.diagnostics.recordCoreStart({ at: at(9), version: 'field' })
    const log = at(10) + ' clock=synced hub=0\n' + at(11) + ' clock=stale hub=0'
    const got = activity(store, NOW, 1, log, [{ camera: 'upper', ts: at(2), ok: true }])
    expect(got.map(e => e.kind)).toEqual(expect.arrayContaining(['watering', 'lighting', 'tank', 'camera', 'restart']))
    expect(got[0]).toMatchObject({ title: 'water low · cleared' })
    expect(got.filter(e => e.title === 'Gateway boot logged')).toHaveLength(1)
    expect(got.find(e => e.key === 'schedule:daily:1')?.title).toBe('Morning water · completed')
    expect(got.some(e => e.key.startsWith('pump:'))).toBe(false)
    expect(got.find(e => e.key === 'frame:top')?.attention).toBe(true)
    expect(got.some(e => e.key === 'attempt:daily:1:1')).toBe(true)
  })

  it('classifies observer samples without conflating ping loss and device reboots', () => {
    const check = (value: string) => ({ result: value })
    const row = (seconds: number, core: string, hald: string, ssh: string | null) => JSON.stringify({
      ts: new Date(NOW.getTime() + seconds * 1000).toISOString(), host: '10.10.20.202',
      core: check(core), hald: check(hald), ssh: ssh ? check(ssh) : null,
    })
    const a = row(0, 'ok', 'ok', 'ok')
    const b = row(5, 'timeout', 'ok', 'ok')
    const c = row(10, 'timeout', 'timeout', 'timeout')
    const d = row(15, 'ok', 'ok', 'ok')
    const result = parseObserver([a + '\nnot json\n' + b, [b, c, d, row(1200, 'ok', 'ok', 'ok')].join('\n')])
    expect(result).toMatchObject({ sampleCount: 5, ignored: 1 })
    expect(result.entries.map(e => e.title)).toEqual(['Observer coverage gap', 'Apps responding', 'All three probes failed', 'Core unreachable, HAL and SSH responding'])
    expect(() => parseObserver([a, b.replace('10.10.20.202', '10.10.20.201')])).toThrow(/just one target/)
  })
})

function snapshot(quality: Reading['quality'] = 'good', ts = at(0)): HalSnapshot {
  return { online: true, system: null, sensors: { water_level_pct: { quality, ts, unit: '%', value: 76 } }, actuators: {}, devices: null, alerts: {} }
}
function tankHistory(store: Store) {
  const points = Array.from({ length: 13 }, (_, i) => ({ sensor: 'water_level_pct' as const, ts: at((12 - i) * 2), value: 86 - i * (10 / 12) }))
  store.telemetry.add(points)
  store.sensorQuality.add(points.map(p => ({ ts: p.ts, sensor: p.sensor, quality: 'good' })))
}

describe('Trip check', () => {
  it('estimates to the care threshold using trusted readings, and reports the last completed run separately from a later fault', () => {
    const store = sqlite()
    enableWater(store)
    tankHistory(store)
    store.pumpRuns.open(at(3), 100, [])
    store.pumpRuns.close(at(2.98), null)
    store.pumpRuns.open(at(1.5), 100, [])
    store.pumpRuns.close(at(1.499), 'dry-run')
    store.captures.add(frame('top', 'upper', 0.5))
    store.captures.add(frame('bottom', 'lower', 5))
    const r = readiness(store, snapshot(), NOW, through(72))
    expect(r.state).toBe('review')
    expect(r.tank).toMatchObject({ targetPct: 50, levelPct: 76, dropPerDay: 10 })
    expect(r.tank.hoursToTarget).toBeCloseTo(62.4)
    expect(r.watering).toMatchObject({ enabled: true, lastProblem: 'dry-run', lastCompleted: { at: at(2.98), source: 'manual' } })
    expect(r.cameras.map(c => c.state)).toEqual(['recent', 'quiet'])
    expect(r.checks).toContain('Check or top off the tank before leaving.')
  })

  it('has no estimate on a stale, future, or freshly refilled reading and never treats a suspect history as trusted', () => {
    const store = new MemoryStore()
    tankHistory(store)
    expect(readiness(store, snapshot('good', at(0.5)), NOW, through(48)).tank.hoursToTarget).toBeNull()
    expect(readiness(store, snapshot('good', at(-0.5)), NOW, through(48)).tank.reason).toContain('future')
    store.tankActions.add({ ts: at(0.5), kind: 'top_off', amount: null, unit: null, product: null, note: '', source: 'user' }, at(0.5))
    expect(readiness(store, snapshot(), NOW, through(48)).tank.hoursToTarget).toBeNull()
    const noQuality = new MemoryStore()
    noQuality.telemetry.add(store.telemetry.range('water_level_pct', at(90), at(0)))
    expect(readiness(noQuality, snapshot(), NOW, through(48)).tank.hoursToTarget).toBeNull()
  })
})

it('compares the same method versions on a clear still of the same occupant without changing the primary', () => {
  const store = new MemoryStore()
  plant(store, 1, 'Rosemary', 48)
  const score = (c: Capture, fields: Partial<AnalysisRow> = {}): AnalysisRow => ({
    captureId: c.id, ts: c.ts, camera: c.camera, analyzer: 'green-threshold', version: 2, source: 'device', slot: 1, metric: 'green_fraction', value: 0.3, detail: null, artifact: null, ...fields,
  })
  for (const c of [frame('before-plant', 'upper', 50), frame('earlier', 'upper', 15), frame('now', 'upper', 1), frame('dark', 'upper', 0)]) {
    store.captures.add(c)
    store.analyses.add([score(c), score(c, { analyzer: 'local-green', version: 5, source: 'remote', value: 0.7 })])
    store.diagnostics.markFrame(c.id, c.id === 'dark' ? 'dark' : 'scored')
  }
  const before = store.settings.get().primaryAnalyzer
  const got = visionReview(store)
  expect(got.selected).toEqual({ analyzer: 'local-green', version: 5 })
  expect(got.items).toMatchObject([{ slot: 1, plant: 'Rosemary', deviceCover: 0.3, workerCover: 0.7, photo: { id: 'now' }, before: { id: 'earlier' } }])
  expect(store.settings.get().primaryAnalyzer).toBe(before)
  expect(visionReview(store, { analyzer: 'not-a-worker', version: 1 }).items).toEqual([])
})
