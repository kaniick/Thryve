import { mkdtemp, open, rm, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatasetSpool } from '../src/datasets/export'

const CHUNK_BYTES = 64 * 1024

/**
 * TAR needs the length before each entry. Spool JSONL in bounded writes, then
 * read it back under stream backpressure. On the unit, use the data volume
 * rather than /tmp, which may share the Pi's RAM.
 */
export function datasetSpool(signal: AbortSignal, root = tmpdir(), progress?: (name: string, rows: number) => void): DatasetSpool {
  const handles: FileHandle[] = []
  let dir: string | undefined
  const check = () => signal.throwIfAborted()
  return {
    async stage(name, rows) {
      check()
      dir ??= await mkdtemp(join(root, '.thryve-export-'))
      const path = join(dir, name)
      const handle = await open(path, 'wx+', 0o600)
      handles.push(handle)
      // An open, unlinked file is reclaimed even if Core is killed. Some
      // local development hosts don't allow this; close() removes those too.
      try {
        await unlink(path)
        await rmdir(dir)
        dir = undefined
      }
      catch {
        // Continue with the private scratch directory.
      }
      let pending = ''
      let pendingBytes = 0
      let size = 0
      let count = 0
      const flush = async () => {
        check()
        if (pendingBytes === 0) return
        await handle.writeFile(pending, 'utf8')
        size += pendingBytes
        progress?.(name, count)
        pending = ''
        pendingBytes = 0
      }
      for (const row of rows) {
        const line = `${JSON.stringify(row)}\n`
        pending += line
        pendingBytes += Buffer.byteLength(line)
        count++
        if (pendingBytes >= CHUNK_BYTES || count % 128 === 0) await flush()
      }
      await flush()
      async function* chunks() {
        for (let pos = 0; pos < size;) {
          check()
          const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - pos))
          const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
          if (bytesRead === 0) throw new Error('dataset staging file was truncated')
          pos += bytesRead
          yield buf.subarray(0, bytesRead)
        }
      }
      return { count, size, chunks: chunks() }
    },
    async close() {
      await Promise.allSettled(handles.splice(0).map(h => h.close()))
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    },
  }
}
