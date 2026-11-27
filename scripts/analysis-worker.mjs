#!/usr/bin/env node
// Optional LAN worker. Reads captures and the unit's geometry, then writes only
// versioned analysis results under its own id (ADR-0019).
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { decode } from 'jpeg-js'

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const CHECKPOINT_SIZE = 4_000
const digest = text => createHash('sha256').update(text).digest('hex')

function integer(value, defaultValue, min, max, name) {
  const n = value === undefined ? defaultValue : Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(name + ' must be between ' + min + ' and ' + max)
  return n
}

export function workerOptions(argv, env) {
  const { values } = parseArgs({ args: argv, options: {
    id: { type: 'string' },
    version: { type: 'string' },
    limit: { type: 'string' },
    batch: { type: 'string' },
    interval: { type: 'string' },
    state: { type: 'string' },
    scorer: { type: 'string' },
    watch: { type: 'boolean' },
    rescore: { type: 'boolean' },
  } })
  const url = new URL(env.THRYVE_URL ?? 'http://127.0.0.1:3000')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.hash || url.search) {
    throw new Error('THRYVE_URL must be a LAN HTTP(S) origin, without credentials, a path or a query')
  }
  if (!env.THRYVE_INGEST_TOKEN) throw new Error('THRYVE_INGEST_TOKEN is required (Settings → Off-device storage and analysis)')
  const analyzer = values.id ?? env.THRYVE_ANALYZER_ID ?? 'exg-strict'
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(analyzer) || analyzer.startsWith('pod-state')) throw new Error('Choose a valid off-device analyser id')
  const stateFile = values.state ?? env.THRYVE_WORKER_STATE
  if (values.watch && !stateFile) throw new Error('--watch needs a --state path or THRYVE_WORKER_STATE')
  if (values.watch && values.rescore) throw new Error('Use --rescore only for a one-shot run')
  const limit = integer(values.limit, 48, 1, 1_000, '--limit')
  return {
    origin: url.origin, token: env.THRYVE_INGEST_TOKEN, apiKey: env.THRYVE_API_KEY, analyzer, limit,
    version: integer(values.version ?? env.THRYVE_ANALYZER_VERSION, 1, 1, 2 ** 31 - 1, '--version'),
    batch: integer(values.batch, values.watch ? Math.min(limit, 8) : limit, 1, 1_000, '--batch'),
    interval: integer(values.interval, 180, 15, 3_600, '--interval'),
    stateFile, watch: Boolean(values.watch), rescore: Boolean(values.rescore), scorerFile: values.scorer ?? env.THRYVE_SCORER_FILE,
  }
}

function readHeaders(o) {
  return o.apiKey ? { 'x-api-key': o.apiKey } : {}
}

function request(fetcher, o, path, options = {}) {
  const endpoint = new URL(path, o.origin)
  if (endpoint.origin !== o.origin) throw new Error('Unit returned a path outside its origin')
  return fetcher(endpoint, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) })
}

async function jsonGet(fetcher, o, path) {
  const response = await request(fetcher, o, path, { headers: readHeaders(o) })
  if (!response.ok) throw new Error('Unit read failed (HTTP ' + response.status + ')')
  return response.json()
}

function crop(box, img) {
  if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return null
  const x = Math.max(0, Math.floor(box.x * img.width))
  const y = Math.max(0, Math.floor(box.y * img.height))
  const right = Math.min(img.width, Math.ceil((box.x + box.w) * img.width))
  const bottom = Math.min(img.height, Math.ceil((box.y + box.h) * img.height))
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null
}

/** Built-in second opinion; a local scorer module can export its own score function. */
export function score(img, rect) {
  let green = 0
  let total = 0
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.width + x) * 4
      if (2 * img.data[i + 1] - img.data[i] - img.data[i + 2] > 40) green++
      total++
    }
  }
  return Math.round((green / total) * 1_000) / 1_000
}

async function photo(fetcher, o, capture) {
  const response = await request(fetcher, o, '/api/captures/' + encodeURIComponent(capture.id) + '.jpg', { headers: readHeaders(o) })
  if (response.status === 404 || response.status === 410) return null
  if (!response.ok) throw new Error('Photo read failed (HTTP ' + response.status + ')')
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('image/jpeg') || !response.body || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel()
    return null
  }
  const chunks = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  }
  finally {
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks, size)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null
  try {
    const img = decode(bytes, { useTArray: true, maxResolutionInMP: 16, maxMemoryUsageInMB: 128, tolerantDecoding: false })
    // Very dark frames are not meaningful plant-cover measurements.
    let light = 0
    let n = 0
    for (let i = 0; i < img.data.length; i += 4 * 127) {
      light += Math.max(img.data[i], img.data[i + 1], img.data[i + 2])
      n++
    }
    return light / n >= 25 ? img : null
  }
  catch {
    return null
  }
}

async function loadState(file, key) {
  if (!file) return new Set()
  let saved
  try {
    saved = JSON.parse(await readFile(file, 'utf8'))
  }
  catch (error) {
    if (error.code === 'ENOENT') return new Set()
    throw new Error('Could not read saved worker progress')
  }
  return new Set(saved.key === key && Array.isArray(saved.ids) ? saved.ids.filter(id => typeof id === 'string').slice(-CHECKPOINT_SIZE) : [])
}

async function saveState(file, key, done) {
  if (!file) return
  await mkdir(dirname(file), { recursive: true })
  const temp = file + '.tmp'
  await writeFile(temp, JSON.stringify({ key, ids: [...done].slice(-CHECKPOINT_SIZE) }) + '\n', { mode: 0o600 })
  await rename(temp, file)
}

export async function runWorker(o, fetcher = fetch, scorer = score) {
  const [regions, captures] = await Promise.all([
    jsonGet(fetcher, o, '/api/vision/regions'),
    jsonGet(fetcher, o, '/api/captures?limit=' + o.limit),
  ])
  if (!Array.isArray(regions) || !Array.isArray(captures)) throw new Error('Unexpected response from the unit')
  const boxes = new Map(regions.map(r => [r.camera, Array.isArray(r.regions) ? [...r.regions].sort((a, b) => a.slot - b.slot) : []]))
  const geometry = JSON.stringify([...boxes].sort(([a], [b]) => a.localeCompare(b)))
  const key = digest(JSON.stringify([o.origin, o.analyzer, o.version, geometry]))
  const done = await loadState(o.stateFile, key)
  const pending = captures.filter(c => typeof c.id === 'string' && c.id.length <= 120 && typeof c.ts === 'string' && Number.isFinite(Date.parse(c.ts)) && boxes.has(c.camera) && (o.rescore || !done.has(c.id)))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
  let stored = 0
  let skipped = 0
  let processed = 0
  try {
    for (const capture of pending.slice(0, o.batch)) {
      const img = await photo(fetcher, o, capture)
      const results = []
      if (img) {
        for (const box of boxes.get(capture.camera) ?? []) {
          if (!Number.isInteger(box.slot) || box.slot < 1 || box.slot > 60) continue
          const rect = crop(box, img)
          if (!rect) continue
          const value = await scorer(img, rect, { captureId: capture.id, slot: box.slot, camera: capture.camera, ts: capture.ts })
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
            results.push({ captureId: capture.id, slot: box.slot, metric: 'green_fraction', value, ts: capture.ts, camera: capture.camera })
          }
        }
      }
      if (results.length) {
        const posted = await request(fetcher, o, '/api/analyses/results', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + o.token },
          body: JSON.stringify({ analyzer: o.analyzer, version: o.version, results }),
        })
        if (!posted.ok) throw new Error('Result ingest refused (HTTP ' + posted.status + ')')
        const out = await posted.json()
        if (!Number.isSafeInteger(out.stored) || out.stored < 0) throw new Error('Unexpected ingest response')
        stored += out.stored
      }
      else skipped++
      done.delete(capture.id)
      done.add(capture.id)
      processed++
    }
  }
  finally {
    if (processed > 0) await saveState(o.stateFile, key, done)
  }
  return { stored, skipped, processed, remaining: Math.max(0, pending.length - processed) }
}

async function main() {
  const o = workerOptions(process.argv.slice(2), process.env)
  const scorer = o.scorerFile ? (await import(pathToFileURL(resolve(o.scorerFile)).href)).score : score
  if (typeof scorer !== 'function') throw new Error('Local scorer must export a score function')
  let retry = o.interval
  for (;;) {
    let wait = o.interval
    try {
      const result = await runWorker(o, fetch, scorer)
      if (!o.watch || result.processed) console.log(o.analyzer + '@' + o.version + ': ' + result.stored + ' scores, ' + result.skipped + ' skipped photos, ' + result.remaining + ' remaining in the scan')
      if (!o.watch) return
      retry = o.interval
    }
    catch (error) {
      if (!o.watch) throw error
      console.error('Vision poll failed: ' + (error instanceof Error ? error.message : 'unknown error'))
      wait = retry
      retry = Math.min(Math.max(o.interval, 900), retry * 2)
    }
    await delay(wait * 1_000)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Worker failed')
    process.exitCode = 1
  })
}
