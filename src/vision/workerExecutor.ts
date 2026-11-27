/**
 * Node-only executor that runs analysis on a worker thread. A JPEG decode
 * takes ~1 s on a Pi Zero 2 W; on the main thread that pauses the API, live
 * events and MQTT for the duration.
 */
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { AnalysisJob, Executor, JobResult } from './execute'
import type { LearnedSpec } from './podState'

// Leave room for several learned revisions on a first-gen Pi Zero. One
// revision in TypeScript took ~33 s there (ADR-0019).
const JOB_TIMEOUT_MS = 180_000

interface Pending {
  resolve: (out: JobResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ActiveWorker {
  thread: Worker
  pending: Map<number, Pending>
}

export interface WorkerExecutor {
  run: Executor
  /** Change the learned analysers the worker runs (#186); jobs sent after this use them. */
  configure(learned: LearnedSpec[]): void
  close(): Promise<void>
}

/** `learned`: the learned analysers to run, as weights files' text. A worker that restarts gets the latest. */
export function createWorkerExecutor(script: URL, options?: WorkerOptions, learned: LearnedSpec[] = [], timeoutMs = JOB_TIMEOUT_MS): WorkerExecutor {
  let config = learned
  let active: ActiveWorker | null = null
  let retiring: Promise<void> | null = null
  let closed = false
  let seq = 0

  const retire = (worker: ActiveWorker, error: Error, exited = false) => {
    if (active !== worker) return
    active = null
    // Don't let a new worker contend for the Pi's CPU or memory until the
    // timed-out worker has stopped. Late events belong to the retired worker.
    if (!exited) {
      retiring = worker.thread.terminate().then(() => {}).finally(() => {
        retiring = null
      })
      // The next job or close will await retirement, but neither is guaranteed.
      void retiring.catch(() => {})
    }
    for (const p of worker.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    worker.pending.clear()
  }
  const ensure = (): ActiveWorker => {
    if (active) return active
    const thread = new Worker(script, { ...options, workerData: { learned: config } })
    const worker: ActiveWorker = { thread, pending: new Map() }
    thread.on('message', (m: { id: number, out?: JobResult, error?: string }) => {
      const p = worker.pending.get(m.id)
      if (!p) return
      worker.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error !== undefined) p.reject(new Error(m.error))
      else p.resolve(m.out ?? null)
    })
    // A crashed worker fails its in-flight jobs; the next job starts a fresh one.
    thread.on('error', error => retire(worker, error))
    thread.on('exit', code => retire(worker, new Error(`vision worker exited with code ${code}`), true))
    thread.unref()
    active = worker
    return worker
  }

  return {
    async run(job: AnalysisJob) {
      if (retiring) await retiring
      if (closed) throw new Error('vision worker is closed')
      const worker = ensure()
      return new Promise<JobResult>((resolve, reject) => {
        const id = ++seq
        // Copy so the caller's buffer (also written to the sink) is not detached by the transfer.
        const bytes = job.bytes.slice()
        const timer = setTimeout(() => {
          const error = new Error(`vision worker timed out after ${timeoutMs} ms`)
          console.warn(`${error.message}; discarding the analysis job and replacing the worker on the next job`)
          retire(worker, error)
        }, timeoutMs).unref()
        worker.pending.set(id, { resolve, reject, timer })
        try {
          worker.thread.postMessage({ id, job: { ...job, bytes } }, [bytes.buffer as ArrayBuffer])
        }
        catch (error) {
          clearTimeout(timer)
          worker.pending.delete(id)
          reject(error)
        }
      })
    },
    configure(next: LearnedSpec[]) {
      config = next
      active?.thread.postMessage({ configure: next })
    },
    async close() {
      closed = true
      if (active) retire(active, new Error('vision worker is closed'))
      await retiring
    },
  }
}
