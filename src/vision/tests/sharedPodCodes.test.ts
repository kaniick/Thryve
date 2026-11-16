import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../../components/Grow/plants/catalog'
import { lookupCode, SHARED_POD_CODES, sharedPairs, statusOf, tableProblems, type SharedPodCode, type SharedPodCodes } from '../sharedPodCodes'

const PLANTS = CATALOG.map(c => c.name)
const entry = (code: string, votes: Record<string, string[]>, o: Partial<SharedPodCode> = {}): SharedPodCode => {
  const [plant, by] = Object.entries(votes).sort((a, b) => b[1].length - a[1].length)[0] as [string, string[]]
  return { code, plant, units: by.length, status: statusOf(votes, o.verified), votes, ...o }
}
const table = (...codes: SharedPodCode[]): SharedPodCodes => ({ version: 1, codes })

describe('the shipped pod-code table (#259)', () => {
  it('is sound: every code a code, every plant in CATALOG, no code twice, statuses from the votes', () => {
    expect(SHARED_POD_CODES.version).toBe(1)
    expect(tableProblems(SHARED_POD_CODES, PLANTS)).toEqual([])
  })

  it('is bundled, never fetched: nothing in core reads it except by a static import', () => {
    const root = resolve(import.meta.dirname, '../../..')
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) return f === 'tests' || f === 'node_modules' || f === 'dist' ? [] : files(p)
      return /\.tsx?$/.test(f) ? [p] : []
    })
    const mentions = [...files(join(root, 'src')), ...files(join(root, 'server'))].flatMap(p => readFileSync(p, 'utf8').split('\n').filter(l => l.includes('podCodes.json')).map(l => [p.slice(root.length + 1), l.trim()]))
    expect(mentions).toEqual([['src/vision/sharedPodCodes.ts', 'import table from \'./podCodes.json\'']])
    expect(readFileSync(join(root, 'src/vision/sharedPodCodes.ts'), 'utf8')).not.toMatch(/fetch\(|https?:/)
  })
})

describe('tableProblems', () => {
  it('names each problem with its code', () => {
    const bad = table(
      { code: 'oooo', plant: 'Basil', units: 1, status: 'confirmed', votes: { Basil: ['a'] } },
      entry('oooo', { Basil: ['a', 'b'] }),
      entry('ooo', { Basil: ['a'] }),
      { code: 'o|o|', plant: 'Moon Lettuce', units: 2, status: 'confirmed', votes: { 'Moon Lettuce': ['a', 'a'] } },
      { code: 'hhhh', plant: 'Basil', units: 1, status: 'pending', votes: { Basil: ['a'], Thyme: ['b'] } },
      { code: '////', plant: 'Basil', units: 3, status: 'pending', votes: {} },
    )
    expect(tableProblems(bad, PLANTS)).toEqual([
      'oooo: confirmed, but its votes make it pending',
      'oooo: listed twice',
      'ooo: not a code',
      'o|o|: Moon Lettuce is not in the catalog',
      'o|o|: Moon Lettuce is not in the catalog',
      'o|o|: a unit is counted twice',
      'hhhh: pending, but its votes make it ambiguous',
      '////: 3 units, but 0 named Basil',
    ])
  })
})

describe('statusOf', () => {
  it('confirms with two units or a maintainer\'s check, and calls any disagreement ambiguous', () => {
    expect(statusOf({ Basil: ['a'] })).toBe('pending')
    expect(statusOf({ Basil: ['a', 'b'] })).toBe('confirmed')
    expect(statusOf({ Basil: ['a'] }, true)).toBe('confirmed')
    expect(statusOf({ Basil: ['a', 'b'], Thyme: ['c'] }, true)).toBe('ambiguous')
    expect(statusOf({})).toBe('pending')
  })
})

describe('sharedPairs', () => {
  it('keeps only confirmed codes: a pending or ambiguous one is never suggested', () => {
    const t = table(entry('oo||', { 'Green Bok Choy': ['a', 'b'] }), entry('o|hh', { Thyme: ['a'] }), entry('ooh|', { Chives: ['a', 'b'], Basil: ['c'] }), entry('hhhh', { Basil: ['a'] }, { verified: true, status: 'confirmed' }))
    expect([...sharedPairs(t)]).toEqual([['oo||', 'Green Bok Choy'], ['hhhh', 'Basil']])
    expect(sharedPairs().size).toBe(SHARED_POD_CODES.codes.filter(c => c.status === 'confirmed').length)
  })
})

describe('lookupCode: own pair, then shared, then record', () => {
  it('takes the owner\'s pair over the shared table and the record', () => {
    expect(lookupCode('Basil', 'Basil', 'Cilantro')).toEqual({ plant: 'Basil', from: 'own', shared: 'Basil', disagrees: false })
  })

  it('takes a shared entry over the record', () => {
    expect(lookupCode(null, 'Green Bok Choy', 'Cilantro')).toEqual({ plant: 'Green Bok Choy', from: 'shared', shared: 'Green Bok Choy', disagrees: false })
  })

  it('falls back to the record, or nothing', () => {
    expect(lookupCode(null, null, 'Cilantro')).toEqual({ plant: 'Cilantro', from: 'record', shared: null, disagrees: false })
    expect(lookupCode(null, null, null)).toEqual({ plant: null, from: null, shared: null, disagrees: false })
  })

  it('keeps the owner\'s pair when it disagrees with the shared table, and flags it', () => {
    expect(lookupCode('Cilantro', 'Green Bok Choy', null)).toEqual({ plant: 'Cilantro', from: 'own', shared: 'Green Bok Choy', disagrees: true })
    // Only a different plant disagrees, not different letter case.
    expect(lookupCode('green bok choy', 'Green Bok Choy', null).disagrees).toBe(false)
  })
})
