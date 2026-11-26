import { randomUUID } from 'node:crypto'
import { datasetEntries, datasetName, type ExportWindow } from '../src/datasets/export'
import type { DatasetProgress } from '../src/datasets/progress'
import { tarStream, type TarEntry } from '../src/datasets/tar'
import type { Context } from '../src/server/context'
import { datasetSpool } from './datasetSpool'

const KEEP_MS = 5 * 60_000

export function datasetError(error: unknown): { detail: string, status: 507 | 500 } {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return { detail: 'Not enough free space to prepare this export. Choose a shorter window or free disk space, then try again.', status: 507 }
  return { detail: 'The dataset could not be prepared or sent. Try again and check Core’s logs if it persists.', status: 500 }
}

interface Job {
  info: DatasetProgress
  abort: AbortController
  entries: AsyncGenerator<TarEntry>
  first?: TarEntry
  name: string
  expires?: ReturnType<typeof setTimeout>
}

const removeTimer = (job: Job) => {
  if (job.expires) clearTimeout(job.expires)
  job.expires = undefined
}

export async function* includeFirst(first: TarEntry, generator: AsyncGenerator<TarEntry>): AsyncGenerator<TarEntry> {
  try {
    yield first
    yield* generator
  }
  finally {
    await generator.return(undefined)
  }
}

export function datasetDownloads(ctx: Context, root?: string) {
  const jobs = new Map<string, Job>()
  const active = (j: Job) => ['preparing', 'ready', 'downloading'].includes(j.info.state)
  const readyExpiry = (j: Job, fn: () => void) => {
    removeTimer(j)
    j.expires = setTimeout(fn, KEEP_MS)
    j.expires.unref?.()
  }
  const finish = (j: Job, state: 'sent' | 'cancelled' | 'error', error: string | null = null) => {
    j.info.state = state
    j.info.error = error
    readyExpiry(j, () => {
      jobs.delete(j.info.id)
    })
    // Bound retained terminal statuses if several small exports finish quickly.
    while (jobs.size > 16) {
      const old = [...jobs.values()].find(k => !active(k) && k !== j)
      if (!old) break
      removeTimer(old)
      jobs.delete(old.info.id)
    }
  }
  const cancel = (j: Job) => {
    if (!active(j)) return
    finish(j, 'cancelled')
    j.abort.abort()
    // Abort the response before ending the iterator, so a partial TAR never
    // looks like a successful download.
    void j.entries.return(undefined).catch(() => undefined)
  }
  return {
    start(w: ExportWindow): DatasetProgress | null {
      if ([...jobs.values()].some(active)) return null
      const id = randomUUID()
      const info: DatasetProgress = { id, state: 'preparing', analyses: 0, telemetry: 0, bytes: 0, error: null }
      const abort = new AbortController()
      const spool = datasetSpool(abort.signal, root, (name, n) => {
        if (name === 'analyses.jsonl') info.analyses = n
        else if (name === 'telemetry.jsonl') info.telemetry = n
      })
      const j: Job = { info, abort, entries: datasetEntries(ctx, w, spool), name: datasetName(ctx.store.settings.get().unitName, w) }
      jobs.set(id, j)
      void j.entries.next().then(async (entry) => {
        if (!active(j) || entry.done) {
          await j.entries.return(undefined)
          if (active(j)) finish(j, 'error', 'No archive was produced.')
          return
        }
        j.first = entry.value
        info.state = 'ready'
        readyExpiry(j, () => cancel(j))
      }).catch((e: unknown) => {
        if (active(j)) finish(j, 'error', datasetError(e).detail)
      })
      return { ...info }
    },
    status(id: string): DatasetProgress | null {
      const j = jobs.get(id)
      return j ? { ...j.info } : null
    },
    cancel(id: string): boolean {
      const j = jobs.get(id)
      if (!j) return false
      cancel(j)
      return true
    },
    download(id: string, disconnected: AbortSignal) {
      const j = jobs.get(id)
      if (j?.info.state !== 'ready' || !j.first) return null
      removeTimer(j)
      j.info.state = 'downloading'
      const signal = AbortSignal.any([j.abort.signal, disconnected])
      const listener = () => cancel(j)
      disconnected.addEventListener('abort', listener, { once: true })
      const detach = () => {
        disconnected.removeEventListener('abort', listener)
        j.abort.signal.removeEventListener('abort', detach)
      }
      j.abort.signal.addEventListener('abort', detach, { once: true })
      const stream = tarStream(includeFirst(j.first, j.entries), {
        signal,
        onCancel: () => {
          detach()
          cancel(j)
        },
        onProgress: (bytes) => { j.info.bytes += bytes },
        onComplete: () => {
          detach()
          if (active(j)) finish(j, 'sent')
        },
        onError: (e) => {
          detach()
          if (active(j)) finish(j, 'error', datasetError(e).detail)
        },
      })
      if (disconnected.aborted) {
        detach()
        cancel(j)
        // The stream was aborted before its wrapper could enter its finally.
        void j.entries.return(undefined).catch(() => undefined)
      }
      return { stream, name: j.name }
    },
  }
}
