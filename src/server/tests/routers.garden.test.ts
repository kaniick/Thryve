import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createApp } from '../../../server/app'
import { runWorker, workerOptions } from '../../../scripts/analysis-worker.mjs'
import { MemorySink } from '../../camera/captures'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { jpeg } from '../../vision/tests/fixtures'
import { createCore } from '../bootstrap'

const now = new Date('2026-11-26T16:00:00.000Z')
const at = now.toISOString()

function setup() {
  const store = new MemoryStore()
  const sink = new MemorySink()
  const core = createCore({ store, sink, hal: new SimHal({ tickMs: 0 }), version: 'test', now: () => now, startServices: false })
  return { store, sink, core, app: createApp({ ctx: core.ctx }).app }
}

it('serves the journal and the same bounded trip check to REST and MCP', async () => {
  const { app, store, core } = setup()
  store.pods.update(24, { plant: 'Rosemary', status: 'seeded', plantedAt: '2026-11-26' }, at)
  const lives = await (await app.request('/api/garden/plants')).json()
  expect(lives.active).toMatchObject([{ plant: 'Rosemary', slot: 24 }])
  const id = lives.active[0].id
  expect(await (await app.request('/api/garden/plants/' + id)).json()).toMatchObject({ life: { id }, events: [{ kind: 'sowed' }] })
  expect((await app.request('/api/garden/plants/9999')).status).toBe(404)
  const activity = await (await app.request('/api/garden/activity')).json()
  expect(activity).toMatchObject({ days: 2, checkedAt: at, entries: [] })
  const a = await (await app.request('/api/garden/readiness')).json()
  expect(a).toMatchObject({ checkedAt: at, until: '2026-11-29T16:00:00.000Z', tank: { hoursToTarget: null } })
  expect((await app.request('/api/garden/readiness?until=' + encodeURIComponent('2026-12-10T16:00:00Z'))).status).toBe(400)

  const [ct, st] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(core.ctx)
  const client = new Client({ name: 'test', version: '1' })
  await server.connect(st)
  await client.connect(ct)
  try {
    const result = await client.callTool({ name: 'garden_readiness', arguments: {} })
    const content = result.content as Array<{ type: string, text: string }>
    expect(JSON.parse(content[0]?.text ?? '{}')).toEqual(a)
  }
  finally {
    await client.close()
    await server.close()
  }
})

it('checks on-device ingest credentials and resumes a local worker from disk without rescoring', async () => {
  const { app, store, sink } = setup()
  const root = mkdtempSync(join(tmpdir(), 'thryve-worker-'))
  const env = { THRYVE_URL: 'http://thryve.test:3000', THRYVE_INGEST_TOKEN: 'test-token', THRYVE_WORKER_STATE: join(root, 'state.json') }
  store.settings.update({ analysisIngestToken: 'test-token' })
  const photo = { id: 'upper-test', camera: 'upper' as const, ts: at, path: 'upper-test.jpg', bytes: 1 }
  store.captures.add(photo)
  await sink.put(photo.path, jpeg(120, 90, true))
  const req: typeof fetch = (input, options) => Promise.resolve(app.request(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, options))
  const primary = store.settings.get().primaryAnalyzer
  try {
    const options = workerOptions(['--watch', '--id', 'homelab-review', '--version', '2'], env)
    await expect(runWorker({ ...options, token: 'wrong' }, req)).rejects.toThrow(/401/)
    expect(store.analyses.forCapture(photo.id)).toEqual([])
    const good = await runWorker(options, req)
    expect(good).toMatchObject({ stored: 15, processed: 1, remaining: 0 })
    expect(store.analyses.forCapture(photo.id)).toHaveLength(15)
    expect(store.analyses.forCapture(photo.id)[0]).toMatchObject({ analyzer: 'homelab-review', source: 'remote', version: 2 })
    const resumed = await runWorker(options, req, () => {
      throw new Error('checkpoint ignored')
    })
    expect(resumed).toMatchObject({ processed: 0 })
    store.settings.update({ podRegions: { upper: { 1: null } } })
    expect(await runWorker(options, req)).toMatchObject({ stored: 14 })
    expect(store.settings.get().primaryAnalyzer).toBe(primary)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
