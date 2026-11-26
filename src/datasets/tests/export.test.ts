import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../server/app'
import { MemorySink } from '../../camera/captures'
import { SimHal } from '../../hardware/sim'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import { SqliteStore } from '../../store/sqlite'
import type { PodLabel, Store } from '../../store/types'
import { cropPixels } from '../../vision/regions'
import { jpeg } from '../../vision/tests/fixtures'
import { datasetName, resolveWindow } from '../export'
import { entryChunks, header, tarStream } from '../tar'

const now = new Date('2026-10-31T12:00:00Z')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function unit(store: Store = new MemoryStore()) {
  const sink = new MemorySink()
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', sink, now: () => now })
  store.settings.update({ unitName: 'Kitchen Gardyn' })
  for (const [i, ts] of ['2026-09-01T00:00:00Z', '2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z'].entries()) {
    const c = { id: `upper-${i}`, camera: 'upper' as const, ts, path: `upper-${i}.jpg`, bytes: 0 }
    const bytes = jpeg(80, 60, true)
    c.bytes = bytes.byteLength
    store.captures.add(c)
    await sink.put(c.path, bytes)
    core.ctx.analysis.enqueue(c, bytes)
    await core.ctx.analysis.idle()
  }
  store.captures.add({ id: 'demo-svg', camera: 'lower', ts: '2026-10-29T00:00:00Z', path: 'data:image/svg+xml;utf8,<svg/>', bytes: 10 })
  store.telemetry.add([{ ts: '2026-10-25T00:00:00Z', sensor: 'air_temp', value: 22.5 }, { ts: '2026-08-01T00:00:00Z', sensor: 'ph', value: 6 }])
  // Pod 1's box is calibrated; the rest keep the measured defaults.
  store.settings.update({ podRegions: { upper: { 1: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } } } })
  const label = (captureId: string, ts: string, slot: number, label: 'empty' | 'seeded' | 'growing' | 'ready', plant: string | null = null, plantedAt: string | null = null, s: Partial<PodLabel> = {}) =>
    store.podLabels.set({ captureId, ts, camera: slot > 15 ? 'lower' : 'upper', slot, label, labelledAt: '2026-10-31T09:00:00.000Z', plant, plantedAt, ...s })
  label('upper-0', '2026-09-01T00:00:00Z', 1, 'empty')
  label('upper-1', '2026-10-20T00:00:00Z', 1, 'growing', 'Basil', '2026-10-06')
  // The grower corrected pod-state's guess.
  label('upper-1', '2026-10-20T00:00:00Z', 2, 'seeded', 'Kale', null, { source: 'corrected', suggested: 'empty', suggestedBy: 'pod-state@1', suggestedConfidence: 0.84 })
  label('upper-2', '2026-10-30T00:00:00Z', 1, 'ready', null, null, { source: 'accepted', suggested: 'ready', suggestedBy: 'carry' })
  label('demo-svg', '2026-10-29T00:00:00Z', 16, 'empty')
  // A still pruned since it was labelled: the label stays, without a crop.
  label('upper-gone', '2026-10-25T00:00:00Z', 3, 'growing')
  // A pair confirmed before the window still goes with the archive.
  store.podCodes.confirm('oo||', 'Green Bok Choy', '2026-08-01T00:00:00.000Z')
  // Suggestions dismissed on a photo in the window and on one before it (#261).
  store.dismissals.dismiss({ captureId: 'upper-2', ts: '2026-10-30T00:00:00Z', slot: 4, dismissedAt: '2026-10-31T09:05:00.000Z' })
  store.dismissals.dismiss({ captureId: 'upper-0', ts: '2026-09-01T00:00:00Z', slot: 5, dismissedAt: '2026-10-31T09:06:00.000Z' })
  return core.ctx
}

function untar(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'dataset-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'a.tar'), bytes)
  const r = spawnSync('tar', ['-xf', 'a.tar'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return dir
}

describe('tar writer', () => {
  it('writes headers the system tar accepts, padded to 512-byte blocks', async () => {
    const chunks = entryChunks({ name: 'x/hello.txt', bytes: new TextEncoder().encode('hi\n'), mtime: 0 })
    expect(chunks.reduce((n, c) => n + c.length, 0) % 512).toBe(0)
    expect(() => header('n'.repeat(101), 0, 0)).toThrow(/over 100 bytes/)
    const stream = tarStream((async function* () {
      yield { name: 'x/hello.txt', bytes: new TextEncoder().encode('hi\n') }
      yield { name: 'x/empty', bytes: new Uint8Array(0) }
    })())
    const dir = untar(new Uint8Array(await new Response(stream).arrayBuffer()))
    expect(readFileSync(join(dir, 'x/hello.txt'), 'utf8')).toBe('hi\n')
    expect(readFileSync(join(dir, 'x/empty'), 'utf8')).toBe('')
  })

  it('streams one chunk at a time and unwinds the entry producer on cancellation', async () => {
    const closed = vi.fn()
    const delivered = vi.fn()
    async function* rows() {
      for (let i = 0; i < 300; i++) {
        delivered()
        yield new Uint8Array([i])
      }
    }
    const readable = tarStream((async function* () {
      try {
        yield { name: 'rows.jsonl', size: 300, chunks: rows() }
      }
      finally {
        closed()
      }
    })())
    const reader = readable.getReader()
    expect((await reader.read()).value?.length).toBe(512)
    expect((await reader.read()).value?.length).toBe(1)
    await reader.cancel()
    expect(delivered.mock.calls.length).toBeLessThan(5)
    expect(closed).toHaveBeenCalledOnce()
  })
})

describe('dataset export', () => {
  it('defaults to the last 30 days and validates the window', () => {
    expect(resolveWindow(now, {})).toEqual({ from: '2026-10-01T12:00:00.000Z', to: '2026-10-31T12:00:00.000Z', images: true })
    expect(() => resolveWindow(now, { from: 'yesterday' })).toThrow(/ISO/)
    expect(() => resolveWindow(now, { from: '2026-10-31T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toThrow(/after/)
    expect(datasetName('Kitchen Gardyn!', resolveWindow(now, {}))).toBe('thryve-kitchen-gardyn-20261001-20261031')
    expect(datasetName('***', resolveWindow(now, {}))).toBe('thryve-unit-20261001-20261031')
  })

  it('summarises what an export would contain', async () => {
    const c = createCallerFactory(appRouter)(await unit())
    expect(await c.datasets.summary()).toMatchObject({ captures: 3, analyses: 60, telemetry: 1, labels: 5, images: true })
    expect((await c.datasets.summary({ from: '2026-01-01T00:00:00Z' })).captures).toBe(4)
    await expect(c.datasets.summary({ from: 'nope' })).rejects.toThrow(/ISO/)
  })

  it('previews counts and image sizes without loading capture, analysis or label rows', async () => {
    const ctx = await unit()
    const fail = () => {
      throw new Error('preview loaded full records')
    }
    const spies = [
      vi.spyOn(ctx.store.captures, 'list').mockImplementation(fail),
      vi.spyOn(ctx.store.analyses, 'range').mockImplementation(fail),
      vi.spyOn(ctx.store.podLabels, 'range').mockImplementation(fail),
    ]
    try {
      const c = createCallerFactory(appRouter)(ctx)
      const from = '2026-10-29T00:00:00.000Z'
      const to = '2026-10-29T01:00:00.000Z'
      // Inline preview images keep their recorded byte count, even if the archive omits images.
      expect(await c.datasets.summary({ from, to, images: false })).toEqual({
        from, to, images: false, captures: 1, analyses: 0, telemetry: 0, labels: 1, imageBytes: 10,
      })
    }
    finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('streams a tar of manifest, JSONL tables, metadata and stills over HTTP', async () => {
    const { app } = createApp({ ctx: await unit() })
    const res = await app.request('/api/datasets/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-tar')
    expect(res.headers.get('content-disposition')).toContain('thryve-kitchen-gardyn-20261001-20261031.tar')
    const root = join(untar(new Uint8Array(await res.arrayBuffer())), 'thryve-kitchen-gardyn-20261001-20261031')
    expect(readdirSync(root).sort()).toEqual(['README.md', 'analyses.jsonl', 'captures.jsonl', 'grow_cycles.json', 'images', 'labels.jsonl', 'manifest.json', 'pod_codes.json', 'pods.json', 'regions.json', 'suggestion_dismissals.json', 'telemetry.jsonl'])
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ format: { name: 'thryve-dataset', version: 4 }, unit: { name: 'Kitchen Gardyn' }, core: 'test', primaryAnalyzer: 'green-threshold', counts: { captures: 3, analyses: 60, telemetry: 1, labels: 5, podCodes: 1, dismissals: 1 } })
    // The owner's confirmed dot code → plant pairs (#259).
    expect(JSON.parse(readFileSync(join(root, 'pod_codes.json'), 'utf8'))).toEqual([{ code: 'oo||', plant: 'Green Bok Choy', confirmedAt: '2026-08-01T00:00:00.000Z' }])
    // Dismissed suggestions in the window, apart from the labels: never a label row (#261).
    expect(JSON.parse(readFileSync(join(root, 'suggestion_dismissals.json'), 'utf8'))).toEqual([{ captureId: 'upper-2', ts: '2026-10-30T00:00:00Z', slot: 4, dismissedAt: '2026-10-31T09:05:00.000Z' }])
    const captures = readFileSync(join(root, 'captures.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string, image: string | null })
    expect(captures.map(c => [c.id, c.image])).toEqual([['upper-1', 'images/upper-1.jpg'], ['demo-svg', null], ['upper-2', 'images/upper-2.jpg']])
    expect(readdirSync(join(root, 'images')).sort()).toEqual(['upper-1.jpg', 'upper-2.jpg'])
    expect(readFileSync(join(root, 'images/upper-1.jpg'))[0]).toBe(0xFF)
    const rows = readFileSync(join(root, 'analyses.jsonl'), 'utf8').trim().split('\n')
    expect(rows).toHaveLength(60)
    expect(JSON.parse(rows[0] ?? '{}')).toMatchObject({ captureId: 'upper-1', source: 'device', metric: 'green_fraction' })
    expect(readFileSync(join(root, 'telemetry.jsonl'), 'utf8')).toContain('"air_temp"')
    expect(JSON.parse(readFileSync(join(root, 'pods.json'), 'utf8'))).toHaveLength(30)

    // Labels, each with its pod's crop in the still's pixels: what a classifier trains on.
    const labels = readFileSync(join(root, 'labels.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(labels.map(l => [l.captureId, l.slot, l.label])).toEqual([['upper-1', 1, 'growing'], ['upper-1', 2, 'seeded'], ['upper-gone', 3, 'growing'], ['demo-svg', 16, 'empty'], ['upper-2', 1, 'ready']])
    // The plant and its age when the photo was taken, so a replant later doesn't relabel the history.
    expect(labels[0]).toEqual({
      captureId: 'upper-1', ts: '2026-10-20T00:00:00Z', camera: 'upper', slot: 1, label: 'growing', labelledAt: '2026-10-31T09:00:00.000Z',
      plant: 'Basil', plantedAt: '2026-10-06', daysSinceSowing: 14, source: 'picked', suggested: null, suggestedBy: null, suggestedConfidence: null,
      image: 'images/upper-1.jpg', width: 80, height: 60, region: { x: 8, y: 12, w: 40, h: 30 }, box: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 },
    })
    const regions = JSON.parse(readFileSync(join(root, 'regions.json'), 'utf8')) as Record<'upper' | 'lower', Record<string, { x: number, y: number, w: number, h: number }>>
    expect(Object.keys(regions.upper)).toHaveLength(15)
    expect(Object.keys(regions.lower)).toHaveLength(15)
    expect(regions.upper['1']).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 })
    expect(labels[1]).toMatchObject({ plant: 'Kale', plantedAt: null, daysSinceSowing: null })
    // How each label was saved, so training can weight corrections and drop a model's own accepted guesses (#261).
    expect(labels[1]).toMatchObject({ source: 'corrected', suggested: 'empty', suggestedBy: 'pod-state@1', suggestedConfidence: 0.84 })
    expect(labels[4]).toMatchObject({ source: 'accepted', suggested: 'ready', suggestedBy: 'carry', suggestedConfidence: null })
    expect(labels[3]).toMatchObject({ plant: null, plantedAt: null, daysSinceSowing: null })
    expect(labels[1]?.box).toEqual(regions.upper['2'])
    expect(labels[1]?.region).toEqual(cropPixels(regions.upper['2'] as { x: number, y: number, w: number, h: number }, 80, 60))
    for (const gone of [labels[2], labels[3]]) expect(gone).toMatchObject({ image: null, width: null, height: null, region: null })
    expect(labels[3]?.box).toEqual(regions.lower['16'])
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('labels.jsonl')
    expect(readme).toContain('`daysSinceSowing`')
    expect(readme).toContain('`pod_codes.json`')
    expect(readme).toContain('`suggestion_dismissals.json`')
    expect(readme).toContain('`suggestedBy`')
    expect(readme).toMatch(/`seeded` \(a yCube in, nothing\s+visible yet\)/)
    expect(readme).toMatch(/map `seeded` to `empty`/)
  })

  it('exports large JSONL entries and counts without materializing entire tables', async () => {
    const store = new SqliteStore({ url: ':memory:' })
    try {
      const ctx = await unit(store)
      const dir = mkdtempSync(join(tmpdir(), 'dataset-stage-'))
      dirs.push(dir)
      const rows = Array.from({ length: 1200 }, (_, i) => ({ ts: '2026-10-30T12:00:00.000Z', sensor: 'humidity' as const, value: i }))
      store.telemetry.add(rows.slice(0, 1000))
      store.telemetry.flush()
      store.telemetry.add(rows.slice(1000))
      const fail = () => {
        throw new Error('export read an entire table')
      }
      vi.spyOn(store.analyses, 'range').mockImplementation(fail)
      vi.spyOn(store.telemetry, 'range').mockImplementation(fail)
      const { app } = createApp({ ctx, datasetSpoolDir: dir })
      const res = await app.request('/api/datasets/export?images=0')
      const packed = join(untar(new Uint8Array(await res.arrayBuffer())), 'thryve-kitchen-gardyn-20261001-20261031')
      const raw = readFileSync(join(packed, 'telemetry.jsonl'), 'utf8')
      expect(Buffer.byteLength(raw)).toBeGreaterThan(65_536)
      expect(raw.trimEnd().split('\n').map(line => JSON.parse(line)).filter(p => p.sensor === 'humidity')).toEqual(rows)
      expect(JSON.parse(readFileSync(join(packed, 'manifest.json'), 'utf8')).counts).toMatchObject({ analyses: 60, telemetry: 1201 })
      expect(readdirSync(dir)).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('leaves the stills out on request and rejects a bad window', async () => {
    const { app } = createApp({ ctx: await unit() })
    const res = await app.request('/api/datasets/export?images=0&from=2026-01-01T00:00:00Z')
    const dir = untar(new Uint8Array(await res.arrayBuffer()))
    const [root] = readdirSync(dir).filter(d => d.startsWith('thryve-'))
    expect(readdirSync(join(dir, root ?? ''))).not.toContain('images')
    const captures = readFileSync(join(dir, root ?? '', 'captures.jsonl'), 'utf8')
    expect(captures).toContain('upper-0')
    expect(captures).not.toContain('images/')
    // Without the stills a label still says where the crop is in them.
    const labels = readFileSync(join(dir, root ?? '', 'labels.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(labels[0]).toMatchObject({ captureId: 'upper-0', image: null, width: 80, height: 60, region: { x: 8, y: 12, w: 40, h: 30 } })
    expect((await app.request('/api/datasets/export?from=bad')).status).toBe(400)
  })
})
