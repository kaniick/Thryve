/**
 * Minimal streaming ustar writer: enough for a dataset bundle (regular files,
 * names under 100 bytes) without holding the archive in memory. A unit has
 * hundreds of megabytes of stills and a Pi has 512 MB of RAM.
 */

export interface BufferedTarEntry {
  name: string
  bytes: Uint8Array
  /** Seconds since the epoch. */
  mtime?: number
}

export interface StreamedTarEntry {
  name: string
  size: number
  chunks: AsyncIterable<Uint8Array>
  mtime?: number
}

export type TarEntry = BufferedTarEntry | StreamedTarEntry

const BLOCK = 512
const enc = new TextEncoder()

function field(buf: Uint8Array, offset: number, length: number, value: string) {
  const b = enc.encode(value)
  if (b.length > length) throw new Error(`tar field too long: ${value}`)
  buf.set(b, offset)
}

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, '0')}\0`

export function header(name: string, size: number, mtime: number): Uint8Array {
  if (enc.encode(name).length > 100) throw new Error(`tar name over 100 bytes: ${name}`)
  const h = new Uint8Array(BLOCK)
  field(h, 0, 100, name)
  field(h, 100, 8, octal(0o644, 8))
  field(h, 108, 8, octal(0, 8))
  field(h, 116, 8, octal(0, 8))
  field(h, 124, 12, octal(size, 12))
  field(h, 136, 12, octal(Math.floor(mtime), 12))
  field(h, 148, 8, '        ')
  field(h, 156, 1, '0')
  field(h, 257, 6, 'ustar\0')
  field(h, 263, 2, '00')
  let sum = 0
  for (const b of h) sum += b
  field(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return h
}

/** Header, data and padding for one file. */
export function entryChunks(e: BufferedTarEntry): Uint8Array[] {
  const pad = (BLOCK - (e.bytes.length % BLOCK)) % BLOCK
  return [header(e.name, e.bytes.length, e.mtime ?? Date.now() / 1000), e.bytes, new Uint8Array(pad)]
}

async function* archiveChunks(entries: AsyncIterable<TarEntry>): AsyncGenerator<Uint8Array> {
  for await (const entry of entries) {
    if ('bytes' in entry) {
      yield* entryChunks(entry).filter(c => c.length)
      continue
    }
    yield header(entry.name, entry.size, entry.mtime ?? Date.now() / 1000)
    let written = 0
    for await (const chunk of entry.chunks) {
      written += chunk.length
      if (written > entry.size) throw new Error(`tar entry grew: ${entry.name}`)
      if (chunk.length) yield chunk
    }
    if (written !== entry.size) throw new Error(`tar entry truncated: ${entry.name}`)
    const padding = (BLOCK - (written % BLOCK)) % BLOCK
    if (padding) yield new Uint8Array(padding)
  }
  yield new Uint8Array(BLOCK * 2)
}

/** A tar stream over lazily produced entries, ending with the two zero blocks. */
export function tarStream(entries: AsyncIterable<TarEntry>, onCancel?: () => void): ReadableStream<Uint8Array> {
  const it = archiveChunks(entries)
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      onCancel?.()
      await it.return(undefined)
    },
  })
}
