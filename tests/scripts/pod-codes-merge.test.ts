import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { merge, run, submitter, VERIFIED_LABEL, type Issue } from '../../scripts/pod-codes-merge'
import { CATALOG } from '../../src/components/Grow/plants/catalog'
import { tableProblems, type SharedPodCodes } from '../../src/vision/sharedPodCodes'

const EMPTY: SharedPodCodes = { version: 1, codes: [] }
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccc'
const body = (pairs: string, fingerprint = '') => `### Pairs\n\n${pairs}\n\n### App version\n\n1.4.0\n\n### Unit fingerprint\n\n${fingerprint || '_No response_'}\n\n### Crops\n\n_No response_`
const issue = (pairs: string, fingerprint = '', o: Partial<Issue> = {}): Issue => ({ body: body(pairs, fingerprint), author: 'grower', labels: ['pod-codes'], number: 7, ...o })
const sound = (t: SharedPodCodes) => expect(tableProblems(t, CATALOG.map(c => c.name))).toEqual([])

describe('pod-codes bot merge (#259)', () => {
  it('gives a pending entry for one unit, and confirms it when a second unit agrees', () => {
    const one = merge(EMPTY, [{ code: 'oo||', plant: 'Green Bok Choy' }], A, false)
    expect(one.table.codes).toEqual([{ code: 'oo||', plant: 'Green Bok Choy', units: 1, status: 'pending', votes: { 'Green Bok Choy': [A] } }])
    expect(one.outcomes).toEqual([{ code: 'oo||', plant: 'Green Bok Choy', status: 'pending' }])
    const two = merge(one.table, [{ code: 'oo||', plant: 'Green Bok Choy' }], B, false)
    expect(two.table.codes).toEqual([{ code: 'oo||', plant: 'Green Bok Choy', units: 2, status: 'confirmed', votes: { 'Green Bok Choy': [A, B] } }])
    sound(two.table)
    // The input table is left as it was.
    expect(one.table.codes[0]?.units).toBe(1)
  })

  it('counts the same unit once, however often it submits', () => {
    let t = merge(EMPTY, [{ code: 'oo||', plant: 'Basil' }], A, false).table
    t = merge(t, [{ code: 'oo||', plant: 'Basil' }], A, false).table
    expect(t.codes[0]).toMatchObject({ units: 1, status: 'pending', votes: { Basil: [A] } })
  })

  it('marks a code ambiguous when units name different plants, and keeps the plant more units named', () => {
    let t = merge(EMPTY, [{ code: 'oo||', plant: 'Green Bok Choy' }], A, false).table
    t = merge(t, [{ code: 'oo||', plant: 'Green Bok Choy' }], B, false).table
    const out = merge(t, [{ code: 'oo||', plant: 'Cilantro' }], C, true)
    expect(out.table.codes[0]).toEqual({ code: 'oo||', plant: 'Green Bok Choy', units: 2, status: 'ambiguous', verified: true, votes: { 'Green Bok Choy': [A, B], 'Cilantro': [C] } })
    expect(out.outcomes[0]?.status).toBe('ambiguous')
    sound(out.table)
  })

  it('moves a unit\'s vote when it corrects itself, and keeps the table\'s plant on a tie', () => {
    let t = merge(EMPTY, [{ code: 'oo||', plant: 'Cilantro' }], A, false).table
    t = merge(t, [{ code: 'oo||', plant: 'Green Bok Choy' }], A, false).table
    expect(t.codes[0]).toMatchObject({ plant: 'Green Bok Choy', units: 1, status: 'pending', votes: { 'Green Bok Choy': [A] } })
    t = merge(t, [{ code: 'oo||', plant: 'Basil' }], B, false).table
    expect(t.codes[0]).toMatchObject({ plant: 'Green Bok Choy', status: 'ambiguous' })
    sound(t)
  })

  it('confirms one unit\'s pair once a maintainer has checked a crop, and keeps codes in order', () => {
    const t = merge(EMPTY, [{ code: 'o|hh', plant: 'Thyme' }, { code: 'hhhh', plant: 'Basil' }], A, true).table
    expect(t.codes.map(c => [c.code, c.status, c.verified])).toEqual([['hhhh', 'confirmed', true], ['o|hh', 'confirmed', true]])
    // A later unverified submission keeps the check.
    expect(merge(t, [{ code: 'hhhh', plant: 'Basil' }], B, false).table.codes[0]).toMatchObject({ units: 2, verified: true, status: 'confirmed' })
    sound(t)
  })

  it('tells units apart by fingerprint, else by a hash of the GitHub login', () => {
    expect(submitter(` ${A.toUpperCase()} `, 'grower')).toBe(A)
    const gh = submitter('', 'grower')
    expect(gh).toMatch(/^gh-[0-9a-f]{16}$/)
    expect(gh).not.toContain('grower')
    expect(submitter('not-a-hash', 'grower')).toBe(gh)
    expect(submitter('', 'someone')).not.toBe(gh)
  })
})

describe('pod-codes bot run (#259)', () => {
  it('merges a form and says what each pair became', () => {
    const out = run(EMPTY, issue('```\noo|| → Green Bok Choy\no|hh → Thyme\n```', A))
    expect(out.table?.codes.map(c => [c.code, c.status])).toEqual([['o|hh', 'pending'], ['oo||', 'pending']])
    expect(out.comment).toContain('Merged:')
    expect(out.comment).toContain('- `oo||` → Green Bok Choy: pending (one unit so far')
    expect(out.comment).not.toContain('Rejected')
  })

  it('rejects malformed lines and unknown plants with a comment, and merges the rest', () => {
    const out = run(EMPTY, issue('oo|| → Green Bok Choy\nooo → Basil\nhhhh → Moon Lettuce', 'zz'))
    expect(out.table?.codes.map(c => c.code)).toEqual(['oo||'])
    expect(out.comment).toContain('Rejected:\n- `ooo → Basil`: not `code → plant`')
    expect(out.comment).toContain('- `hhhh → Moon Lettuce`: Moon Lettuce isn\'t a plant in the catalog')
    expect(out.comment).toContain('The unit fingerprint `zz` isn\'t 16 hex digits')
    // An unusable fingerprint counts as the GitHub account instead.
    expect(out.table?.codes[0]?.votes['Green Bok Choy']).toEqual([submitter('', 'grower')])
  })

  it('changes nothing and says why when no pair can be merged', () => {
    const out = run(EMPTY, issue('Basil is oo||'))
    expect(out.table).toBeNull()
    expect(out.comment).toContain('No pair here could be merged')
    expect(out.comment).toContain('- `Basil is oo||`')
  })

  it('confirms a pair when the issue carries the verified label, and says so when nothing changes', () => {
    const first = run(EMPTY, issue('oo|| → Green Bok Choy', A))
    const verified = run(first.table as SharedPodCodes, issue('oo|| → Green Bok Choy', A, { labels: ['pod-codes', VERIFIED_LABEL] }))
    expect(verified.table?.codes[0]).toMatchObject({ status: 'confirmed', verified: true, units: 1 })
    expect(verified.comment).toContain('`oo||` → Green Bok Choy: confirmed')
    const again = run(verified.table as SharedPodCodes, issue('oo|| → Green Bok Choy', A))
    expect(again.table).toBeNull()
    expect(again.comment).toContain('Already in the table, unchanged')
  })

  it('says ambiguous in the comment when units disagree', () => {
    const first = run(EMPTY, issue('oo|| → Green Bok Choy', A))
    expect(run(first.table as SharedPodCodes, issue('oo|| → Cilantro', B)).comment).toContain('ambiguous (units name different plants')
  })

  it('refuses to write a table that fails the schema check', () => {
    const broken: SharedPodCodes = { version: 1, codes: [{ code: 'hhhh', plant: 'Moon Lettuce', units: 1, status: 'pending', votes: { 'Moon Lettuce': [C] } }] }
    expect(() => run(broken, issue('oo|| → Basil', A))).toThrow(/unsound/)
  })
})

describe('pod-codes bot CLI (#259)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('writes the table and the comment, and prints changed= for $GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-codes-'))
    dirs.push(dir)
    const table = join(dir, 'podCodes.json')
    writeFileSync(table, `${JSON.stringify(EMPTY, null, 2)}\n`)
    const script = resolve(import.meta.dirname, '../../scripts/pod-codes-merge.ts')
    const tsx = resolve(import.meta.dirname, '../../node_modules/.bin/tsx')
    const env = { ...process.env, ISSUE_BODY: body('oo|| → Green Bok Choy', A), ISSUE_AUTHOR: 'grower', ISSUE_LABELS: '["pod-codes"]', ISSUE_NUMBER: '7' }
    const r = spawnSync(tsx, [script, table, join(dir, 'comment.md')], { env, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('changed=true\n')
    expect(JSON.parse(readFileSync(table, 'utf8'))).toMatchObject({ version: 1, codes: [{ code: 'oo||', status: 'pending' }] })
    expect(readFileSync(join(dir, 'comment.md'), 'utf8')).toContain('Merged:')
    const again = spawnSync(tsx, [script, table, join(dir, 'comment.md')], { env, encoding: 'utf8' })
    expect(again.stdout).toBe('changed=false\n')
  })
})
