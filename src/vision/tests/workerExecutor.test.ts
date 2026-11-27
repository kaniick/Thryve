import { readFileSync } from 'node:fs'
import { encode } from 'jpeg-js'
import { describe, expect, it, vi } from 'vitest'
import { MemorySink } from '../../camera/captures'
import { MemoryStore } from '../../store/memory'
import type { Capture } from '../../store/types'
import type { AnalysisJob } from '../execute'
import { AnalysisService } from '../service'
import { createWorkerExecutor } from '../workerExecutor'
import { jpeg } from './fixtures'

// Runs the real worker entry through tsx, the way `node server/dist/visionWorker.js` runs it on a unit.
const script = new URL('../visionWorker.ts', import.meta.url)
const lifecycleScript = new URL('./fixtures/worker-lifecycle.mjs', import.meta.url)
const lifecycleJob = (action: number): AnalysisJob => ({ bytes: new Uint8Array([action]), camera: 'upper', analyzers: [], opts: { artifacts: false } })

describe('worker executor', () => {
  it('scores stills off the main thread and leaves the caller\'s buffer intact', async () => {
    const w = createWorkerExecutor(script, { execArgv: ['--import', 'tsx'] })
    try {
      const bytes = jpeg(90, 75, true)
      const out = await w.run({ bytes, camera: 'upper', analyzers: ['green-threshold', 'exg-otsu'], opts: { artifacts: true } })
      if (!Array.isArray(out)) throw new Error('should have scored it')
      expect(out.map(o => o.analyzer)).toEqual(['green-threshold', 'exg-otsu'])
      expect(out[1]?.artifacts?.[0]?.bytes.byteLength).toBeGreaterThan(0)
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(await w.run({ bytes: new Uint8Array([1]), camera: 'lower', analyzers: ['exg-otsu'], opts: { artifacts: false } })).toBeNull()
      const data = new Uint8Array(64 * 64 * 4)
      for (let i = 0; i < data.length; i += 4) data.set([0, 135, 0, 255], i)
      const torn = new Uint8Array(encode({ data, width: 64, height: 64 }, 85).data)
      expect(await w.run({ bytes: torn, camera: 'upper', analyzers: ['exg-otsu'], opts: { artifacts: false } })).toBe('damaged')
    }
    finally {
      await w.close()
    }
  }, 20_000)

  it('runs the learned analyser from the weights core passes it', async () => {
    const text = readFileSync(new URL('../../../models/pod-state.json', import.meta.url), 'utf8')
    const w = createWorkerExecutor(script, { execArgv: ['--import', 'tsx'] }, [{ id: 'pod-state', label: 'Pod state', text }])
    const job = (analyzers: string[]) => ({ bytes: jpeg(320, 240, true), camera: 'lower' as const, analyzers, opts: { artifacts: false } })
    try {
      const out = await w.run(job(['pod-state']))
      if (!Array.isArray(out)) throw new Error('should have scored it')
      expect(out[0]?.analyzer).toBe('pod-state')
      expect(out[0]?.results.filter(r => r.metric === 'pod_state').map(r => r.slot)).toEqual(Array.from({ length: 15 }, (_, i) => 16 + i))
      // A revision enabled later runs as its own analyser; one switched off stops.
      w.configure([{ id: 'pod-state-v2', label: 'Pod state: v2', text }])
      const next = await w.run(job(['pod-state', 'pod-state-v2']))
      expect(Array.isArray(next) && next.map(o => o.analyzer)).toEqual(['pod-state-v2'])
      w.configure([{ id: 'pod-state', label: 'Pod state', text: null }])
      expect(await w.run(job(['pod-state']))).toEqual([])
    }
    finally {
      await w.close()
    }
  }, 20_000)

  it('fails in-flight jobs when the worker cannot start', async () => {
    const broken = createWorkerExecutor(new URL('./does-not-exist.js', import.meta.url))
    await expect(broken.run({ bytes: jpeg(10, 10, false), camera: 'upper', analyzers: [], opts: { artifacts: false } })).rejects.toThrow()
    await broken.close()
  }, 20_000)

  it('times out a stalled worker, then scores the next frame with the latest configuration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = createWorkerExecutor(lifecycleScript, undefined, [], 1_000)
    try {
      const stalled = w.run(lifecycleJob(1))
      const queued = w.run(lifecycleJob(0))
      await Promise.all([
        expect(stalled).rejects.toThrow('vision worker timed out after 1000 ms'),
        expect(queued).rejects.toThrow('vision worker timed out after 1000 ms'),
      ])
      expect(warn).toHaveBeenCalledTimes(1)
      w.configure([{ id: 'pod-state-v2', label: 'Updated model', text: null }])
      expect(await w.run(lifecycleJob(0))).toEqual([{ analyzer: 'pod-state-v2', version: 1, results: [] }])
      expect(await w.run(lifecycleJob(0))).toEqual([{ analyzer: 'pod-state-v2', version: 1, results: [] }])
    }
    finally {
      await w.close()
      warn.mockRestore()
    }
  }, 10_000)

  it('recovers from a crash without its exit taking down the replacement', async () => {
    const w = createWorkerExecutor(lifecycleScript)
    try {
      await expect(w.run(lifecycleJob(2))).rejects.toThrow('fixture worker crashed')
      expect(await w.run(lifecycleJob(0))).toEqual([])
      expect(await w.run(lifecycleJob(0))).toEqual([])
    }
    finally {
      await w.close()
    }
  })

  it('lets Analysis score the next camera frame after a timeout without deleting the earlier still', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = createWorkerExecutor(lifecycleScript, undefined, [], 1_000)
    const store = new MemoryStore()
    const sink = new MemorySink()
    const service = new AnalysisService({ store, sink, executor: w.run })
    const capture = (id: string, camera: Capture['camera']): Capture => ({ id, camera, ts: '2026-01-01T00:00:00Z', path: `${id}.jpg`, bytes: 1 })
    const upper = capture('stalled', 'upper')
    const lower = capture('live', 'lower')
    try {
      const stalled = new Uint8Array([1])
      store.captures.add(upper)
      await sink.put(upper.path, stalled)
      store.analyses.add([{ captureId: upper.id, ts: upper.ts, camera: upper.camera, analyzer: 'green-threshold', version: 2, source: 'device', slot: 1, metric: 'green_fraction', value: 0.3, detail: null, artifact: null }])
      service.enqueue(upper, stalled)
      service.enqueue(lower, new Uint8Array([3]))
      await service.idle()
      expect(service.status()).toMatchObject({ running: null, waiting: [], failed: 1 })
      expect(await sink.get(upper.path)).toEqual(stalled)
      expect(store.analyses.forCapture(upper.id)).toMatchObject([{ value: 0.3 }])
      expect(store.analyses.forCapture(lower.id)).toMatchObject([{ slot: 16, value: 0.5 }])
    }
    finally {
      await w.close()
      warn.mockRestore()
    }
  }, 10_000)

  it('rejects in-flight requests on close and cannot reopen during teardown', async () => {
    const w = createWorkerExecutor(lifecycleScript)
    const pending = expect(w.run(lifecycleJob(1))).rejects.toThrow('vision worker is closed')
    const stopped = w.close()
    await Promise.all([stopped, pending, expect(w.run(lifecycleJob(0))).rejects.toThrow('vision worker is closed')])
    await w.close()
  })
})
