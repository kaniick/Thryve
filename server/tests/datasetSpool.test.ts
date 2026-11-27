import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { datasetSpool } from '../datasetSpool'

describe('dataset spool', () => {
  it('reports UTF-8 size and returns at most one 64 KiB block per read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'thryve-spool-'))
    const spool = datasetSpool(new AbortController().signal, root)
    try {
      const row = { detail: 'é水'.repeat(500) }
      const rows = Array.from({ length: 128 }, () => row)
      const staged = await spool.stage('rows.jsonl', rows)
      const expected = (`${JSON.stringify(row)}\n`).repeat(rows.length)
      const pieces: Buffer[] = []
      for await (const bytes of staged.chunks) {
        expect(bytes.length).toBeLessThanOrEqual(65_536)
        pieces.push(Buffer.from(bytes))
      }
      expect(staged.count).toBe(128)
      expect(staged.size).toBe(Buffer.byteLength(expected))
      expect(Buffer.concat(pieces).toString('utf8')).toBe(expected)
      await spool.close()
      expect(await readdir(root)).toEqual([])
    }
    finally {
      await spool.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops reading rows once the export is aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'thryve-spool-'))
    const abort = new AbortController()
    const spool = datasetSpool(abort.signal, root)
    function* rows() {
      yield { first: 1 }
      abort.abort()
      // The serializer sees the abort at its next bounded flush.
      for (let i = 0; i < 500; i++) {
        if (i >= 128) throw new Error('read too far after cancellation')
        yield { i }
      }
    }
    try {
      await expect(spool.stage('rows.jsonl', rows())).rejects.toHaveProperty('name', 'AbortError')
      await spool.close()
      expect(await readdir(root)).toEqual([])
    }
    finally {
      await spool.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
