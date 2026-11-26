import type Database from 'better-sqlite3'
import type { SensorId } from '../hardware/contract'
import type { TelemetryPoint } from './types'

type PointRow = TelemetryPoint & { id: number }

/** Like the old stable timestamp sort: equal timestamps from disk precede held rows. */
function* merge(rows: Iterable<TelemetryPoint>, held: TelemetryPoint[]) {
  let i = 0
  for (const row of rows) {
    for (let queued = held[i]; queued && queued.ts < row.ts; queued = held[++i]) yield queued
    yield row
  }
  while (i < held.length) yield held[i++] as TelemetryPoint
}

const windowSql = 'sensor = @sensor AND ts BETWEEN @from AND @to'

export class SqliteTelemetryReader {
  private readonly countRows
  private readonly all
  private readonly newestTime
  private readonly sampled
  private readonly sampledWithHeld
  private readonly lastId
  private readonly firstPage
  private readonly nextPage

  constructor(db: Database.Database) {
    this.countRows = db.prepare<unknown[], { n: number }>(`SELECT count(*) AS n FROM telemetry WHERE ${windowSql}`)
    this.all = db.prepare<unknown[], TelemetryPoint>(`SELECT ts, sensor, value FROM telemetry WHERE ${windowSql} ORDER BY ts, id`)
    this.newestTime = db.prepare<unknown[], { ts: string }>(`SELECT ts FROM telemetry WHERE ${windowSql} ORDER BY ts DESC LIMIT 1`)
    // Rank only the covering-index columns and fetch values for selected IDs.
    // The selected positions are the same as downsample(), including when timestamps repeat.
    this.sampled = db.prepare<unknown[], TelemetryPoint>(`
      WITH ranks AS (
        SELECT id, row_number() OVER (ORDER BY ts, id) - 1 AS pos
        FROM telemetry WHERE ${windowSql}
      )
      SELECT t.ts, t.sensor, t.value
      FROM ranks JOIN telemetry t USING (id)
      WHERE ranks.pos IN (SELECT value FROM json_each(@positions))
      ORDER BY ranks.pos
    `)
    this.sampledWithHeld = db.prepare<unknown[], TelemetryPoint>(`
      WITH ranks AS (
        SELECT id, is_held, row_number() OVER (ORDER BY ts, is_held, id) - 1 AS pos
        FROM (
          SELECT id, ts, 0 AS is_held FROM telemetry WHERE ${windowSql}
          UNION ALL
          SELECT key, value ->> '$.ts', 1 FROM json_each(@held)
        )
      )
      SELECT coalesce(t.ts, @held ->> ('$[' || ranks.id || '].ts')) AS ts,
        @sensor AS sensor,
        coalesce(t.value, @held ->> ('$[' || ranks.id || '].value')) AS value
      FROM ranks LEFT JOIN telemetry t ON ranks.is_held = 0 AND ranks.id = t.id
      WHERE ranks.pos IN (SELECT value FROM json_each(@positions))
      ORDER BY ranks.pos
    `)
    this.lastId = db.prepare<[], { id: number }>('SELECT coalesce(max(id), 0) AS id FROM telemetry')
    this.firstPage = db.prepare<unknown[], PointRow>(`
      SELECT id, ts, sensor, value FROM telemetry
      WHERE ${windowSql} AND id <= @lastId ORDER BY ts, id LIMIT 256
    `)
    this.nextPage = db.prepare<unknown[], PointRow>(`
      SELECT id, ts, sensor, value FROM telemetry
      WHERE ${windowSql} AND id <= @lastId AND (ts, id) > (@afterTs, @afterId)
      ORDER BY ts, id LIMIT 256
    `)
  }

  count(sensor: SensorId, from: string, to: string, held: TelemetryPoint[]): number {
    let n = this.countRows.get({ sensor, from, to })?.n ?? 0
    for (const p of held) if (p.sensor === sensor && p.ts >= from && p.ts <= to) n++
    return n
  }

  private inWindow(sensor: SensorId, from: string, to: string, held: TelemetryPoint[]) {
    return held.filter(p => p.sensor === sensor && p.ts >= from && p.ts <= to)
  }

  range(sensor: SensorId, from: string, to: string, max: number, buffer: TelemetryPoint[]): TelemetryPoint[] {
    if (max === 0) return []
    const key = { sensor, from, to }
    const held = this.inWindow(sensor, from, to, buffer)
    if (max > 0 && max < Number.MAX_SAFE_INTEGER) {
      const onDisk = this.countRows.get(key)?.n ?? 0
      const total = onDisk + held.length
      if (total > max) {
        const stride = total / max
        const positions = Array.from({ length: Math.ceil(max) }, (_, i) => Math.floor(i * stride))
        if (!held.length) return this.sampled.all({ ...key, positions: JSON.stringify(positions) })
        const last = onDisk > 0 ? this.newestTime.get(key)?.ts : undefined
        // Usually all pending samples follow the card's newest one. Rank the
        // card's rows in index order and append the chosen pending samples
        // without making SQLite sort the entire history and buffer together.
        // Equal timestamps still keep the stored rows before pending rows.
        if (!onDisk || (last !== undefined && held.every(p => p.ts >= last))) {
          held.sort((a, b) => a.ts.localeCompare(b.ts))
          const diskPositions: number[] = []
          const tail: TelemetryPoint[] = []
          for (const pos of positions) {
            if (pos < onDisk) diskPositions.push(pos)
            else {
              const row = held[pos - onDisk]
              if (row) tail.push(row)
            }
          }
          return diskPositions.length
            ? [...this.sampled.all({ ...key, positions: JSON.stringify(diskPositions) }), ...tail]
            : tail
        }
        // Keep exact sampling when a reconnect or clock correction inserts
        // readings between the stored timestamps.
        return this.sampledWithHeld.all({ ...key, positions: JSON.stringify(positions), held: JSON.stringify(held) })
      }
    }
    const stored = this.all.all(key)
    return held.length ? [...merge(stored, held.sort((a, b) => a.ts.localeCompare(b.ts)))] : stored
  }

  scan(sensor: SensorId, from: string, to: string, buffer: TelemetryPoint[]): Iterable<TelemetryPoint> {
    // Capture the cutoff and held rows immediately. If they flush mid-stream, the
    // new IDs are excluded so each buffered row is still returned exactly once.
    const opts = { sensor, from, to, lastId: this.lastId.get()?.id ?? 0 }
    const held = this.inWindow(sensor, from, to, buffer).sort((a, b) => a.ts.localeCompare(b.ts))
    const firstPage = this.firstPage
    const nextPage = this.nextPage
    function* persisted() {
      let page = firstPage.all(opts)
      while (page.length) {
        for (const { ts, sensor, value } of page) yield { ts, sensor, value }
        if (page.length < 256) return
        const last = page.at(-1)
        if (!last) return
        page = nextPage.all({ ...opts, afterTs: last.ts, afterId: last.id })
      }
    }
    // Each page releases its read transaction before yielding to the caller.
    return merge(persisted(), held)
  }
}
