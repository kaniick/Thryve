/**
 * Runs the on-device analysers over captures (ADR-0019): one job at a time,
 * at most one waiting per camera (a newer still replaces an older one that
 * hasn't started), results upserted into the shared table, large outputs
 * written to the blob sink.
 */
import type { BlobSink } from '../camera/captures'
import type { EventBus } from '../lib/eventBus'
import type { AnalysisRow, Capture, Store } from '../store/types'
import { deviceAnalyzers, info, type AnalyzerInfo } from './analyzer'
import { DAMAGED, inlineExecutor, type Executor, type JobOutput } from './execute'
import { cameraSlots, podRegions } from './regions'

export interface AnalysisServiceOptions {
  store: Store
  sink: BlobSink
  events?: EventBus
  executor?: Executor
}

export interface AnalysisStatus {
  running: string | null
  runningKind: 'live' | 'backfill' | null
  waiting: string[]
  /** Stills skipped because a newer one from the same camera arrived first. */
  dropped: number
  failed: number
  backfill: { analyzer: string, done: number, total: number } | null
}

export interface AnalyzerListing extends AnalyzerInfo {
  source: 'device' | 'remote'
  primary: boolean
  rows: number
  captures: number
  firstTs: string | null
  lastTs: string | null
}

interface Job { capture: Capture, bytes: Uint8Array }
interface Backfill { analyzer: string, captures: Capture[], done: number }

export class AnalysisService {
  private readonly executor: Executor
  private readonly waiting = new Map<'upper' | 'lower', Job>()
  private running: { capture: Capture, kind: 'live' | 'backfill' } | null = null
  private task: Promise<void> | null = null
  private dropped = 0
  private failed = 0
  private backfill: Backfill | null = null

  constructor(private readonly o: AnalysisServiceOptions) {
    this.executor = o.executor ?? inlineExecutor
  }

  /** Queue a fresh capture for every on-device analyser. Never throws. */
  enqueue(capture: Capture, bytes: Uint8Array): void {
    // Reinsert a replaced job at the tail, so a busy camera can't monopolize
    // the waiting slot ahead of a frame from the other camera.
    if (this.waiting.delete(capture.camera)) this.dropped++
    this.waiting.set(capture.camera, { capture, bytes })
    this.kick()
  }

  /** Resolves when everything queued so far has finished. */
  async idle(): Promise<void> {
    while (this.task) await this.task
  }

  status(): AnalysisStatus {
    const b = this.backfill
    return {
      running: this.running?.capture.id ?? null, runningKind: this.running?.kind ?? null,
      waiting: [...this.waiting.values()].map(j => j.capture.id), dropped: this.dropped, failed: this.failed,
      backfill: b ? { analyzer: b.analyzer, done: b.done, total: b.captures.length } : null,
    }
  }

  /**
   * Re-score stored captures with one analyser, newest first, in the
   * background. Returns how many captures it will visit.
   */
  rerun(analyzerId: string, limit = 2000): number {
    const analyzer = deviceAnalyzers().find(a => a.id === analyzerId)
    if (!analyzer) throw new Error(`${analyzerId} is not an on-device analyser`)
    if (analyzer.disabled) throw new Error(`${analyzerId} is off: ${analyzer.disabled}`)
    if (this.backfill) throw new Error(`already re-running ${this.backfill.analyzer}`)
    const captures = this.o.store.captures.list(undefined, limit)
    this.backfill = { analyzer: analyzerId, captures, done: 0 }
    this.kick()
    return captures.length
  }

  /** Every analyser that is registered here or has results in the table. */
  list(): AnalyzerListing[] {
    const primary = this.o.store.settings.get().primaryAnalyzer
    const stats = this.o.store.analyses.stats()
    const device = deviceAnalyzers()
    const out: AnalyzerListing[] = device.map((a) => {
      const s = stats.filter(x => x.analyzer === a.id && x.version === a.version)
      return { ...info(a), source: 'device', primary: a.id === primary, ...totals(s) }
    })
    const seen = new Set(out.map(a => `${a.id}@${a.version}`))
    for (const s of stats) {
      const key = `${s.analyzer}@${s.version}`
      if (seen.has(key)) continue
      seen.add(key)
      const known = device.find(a => a.id === s.analyzer)
      out.push({
        id: s.analyzer,
        version: s.version,
        label: known?.label ?? s.analyzer,
        description: known ? `Older version of ${known.label}.` : s.source === 'device' ? 'A model revision that no longer runs here; enable it again under GET /api/models.' : 'Results posted by an off-device worker.',
        metrics: known?.metrics ?? [],
        runsOn: [s.source],
        source: s.source,
        primary: s.analyzer === primary && !known,
        ...totals(stats.filter(x => x.analyzer === s.analyzer && x.version === s.version)),
      })
    }
    return out
  }

  /** Remove a capture's artifacts from the sink (called when the capture is pruned). */
  async removeArtifacts(captureId: string): Promise<void> {
    for (const r of this.o.store.analyses.forCapture(captureId)) {
      if (r.artifact) await this.o.sink.remove(r.artifact)
    }
  }

  private kick(): void {
    if (this.task) return
    this.task = Promise.resolve().then(() => this.drain()).finally(() => {
      this.task = null
      if (this.waiting.size || this.backfill) this.kick()
    })
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.waiting.entries().next().value
      if (next) {
        const [camera, job] = next
        this.waiting.delete(camera)
        await this.analyse(job.capture, job.bytes, deviceAnalyzers().filter(a => !a.disabled).map(a => a.id), 'live')
        continue
      }
      const b = this.backfill
      if (!b) return
      const capture = b.captures[b.done]
      if (!capture) {
        this.backfill = null
        this.o.events?.emit({ kind: 'mutation', path: 'analyses' })
        continue
      }
      // Yield a turn between old frames, even when neither the sink nor the
      // executor is doing I/O. This gives health checks/MQTT and captures time.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (this.waiting.size) continue
      try {
        const bytes = await this.o.sink.get(capture.path)
        if (bytes) {
          // If a live frame arrived while reading the file, put it first and
          // revisit this stored frame next time. No second JPEG is retained.
          if (this.waiting.size) continue
          await this.analyse(capture, bytes, [b.analyzer], 'backfill')
        }
      }
      catch {
        this.failed++
      }
      b.done++
    }
  }

  private async analyse(capture: Capture, bytes: Uint8Array, analyzers: string[], kind: 'live' | 'backfill'): Promise<void> {
    this.running = { capture, kind }
    try {
      const settings = this.o.store.settings.get()
      const opts = { artifacts: settings.analysisArtifacts }
      const regions = podRegions(capture.camera, settings.podRegions)
      const out = await this.executor({ bytes, camera: capture.camera, regions, analyzers, opts })
      if (out === DAMAGED) {
        await this.forget(capture)
      }
      else if (out) {
        const slots = cameraSlots(capture.camera).filter(slot => !regions[slot])
        const omitted = slots.length ? { captureId: capture.id, slots, runs: out.map(({ analyzer, version }) => ({ analyzer, version })) } : undefined
        this.o.store.analyses.add(await this.toRows(capture, out), omitted)
        this.o.events?.emit({ kind: 'mutation', path: 'analyses' })
      }
    }
    catch {
      // Analysis is best-effort: a bad frame or a crashed worker never fails a capture.
      this.failed++
    }
    finally {
      this.running = null
    }
  }

  /**
   * Drop what this unit scored from a damaged still, which a re-run finds among
   * stills taken before hald could refuse them. Left in, those scores keep
   * pulling the pod trends. A remote worker's results stay: they aren't ours to redo.
   */
  private async forget(capture: Capture): Promise<void> {
    const rows = this.o.store.analyses.forCapture(capture.id).filter(r => r.source === 'device')
    if (rows.length === 0) return
    for (const r of rows) {
      if (r.artifact) await this.o.sink.remove(r.artifact)
    }
    this.o.store.analyses.removeDevice(capture.id)
    this.o.events?.emit({ kind: 'mutation', path: 'analyses' })
  }

  private async toRows(capture: Capture, out: JobOutput): Promise<AnalysisRow[]> {
    const rows: AnalysisRow[] = []
    for (const o of out) {
      let artifact: string | null = null
      for (const a of o.artifacts ?? []) {
        artifact = await this.o.sink.put(artifactKey(capture.id, o.analyzer, o.version, a.name), a.bytes)
      }
      for (const r of o.results) {
        rows.push({ captureId: capture.id, ts: capture.ts, camera: capture.camera, analyzer: o.analyzer, version: o.version, source: 'device', slot: r.slot, metric: r.metric, value: r.value, detail: r.detail ?? null, artifact })
      }
    }
    return rows
  }
}

/** Blob key for an analyser's large output, e.g. `analysis/upper-…/exg-otsu@1/mask.pbm`. */
export function artifactKey(captureId: string, analyzer: string, version: number, name: string): string {
  return `analysis/${captureId}/${analyzer}@${version}/${name}`
}

function totals(s: Array<{ rows: number, captures: number, firstTs: string, lastTs: string }>) {
  return {
    rows: s.reduce((n, x) => n + x.rows, 0),
    captures: s.reduce((n, x) => n + x.captures, 0),
    firstTs: s.map(x => x.firstTs).sort()[0] ?? null,
    lastTs: s.map(x => x.lastTs).sort().at(-1) ?? null,
  }
}
