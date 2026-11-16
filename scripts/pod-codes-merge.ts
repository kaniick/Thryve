#!/usr/bin/env -S pnpm exec tsx
// The pod-codes bot (#259): merges one `pod-codes` issue form into
// src/vision/podCodes.json and writes the comment for the issue.
// .github/workflows/pod-codes.yml runs it, then opens a pull request; it never
// commits to dev or main.
//
//   ISSUE_BODY=… ISSUE_AUTHOR=… ISSUE_LABELS='["pod-codes"]' ISSUE_NUMBER=12 \
//     pnpm exec tsx scripts/pod-codes-merge.ts [table.json] [comment.md]
//
// Prints `changed=true|false` (for $GITHUB_OUTPUT).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CATALOG } from '../src/components/Grow/plants/catalog'
import { statusOf, tableProblems, type SharedPodCode, type SharedPodCodes } from '../src/vision/sharedPodCodes'
import { FINGERPRINT, formFields, parsePairs, type CodePlant } from '../src/vision/shareCodes'

export const VERIFIED_LABEL = 'pod-codes-verified'
const PLANTS = CATALOG.map(c => c.name)

/** Who submitted: the form's unit fingerprint, else a hash of the GitHub login (so one account counts once). */
export function submitter(fingerprint: string, author: string): string {
  const f = fingerprint.trim().toLowerCase()
  return FINGERPRINT.test(f) ? f : `gh-${createHash('sha256').update(`thryve-pod-codes:${author}`).digest('hex').slice(0, 16)}`
}

export type Outcome = 'pending' | 'confirmed' | 'ambiguous'

/**
 * One unit's pairs merged into the table. A unit counts once per code: naming
 * the same plant again changes nothing, and naming another plant moves its
 * vote. A code is confirmed with 2+ units, or with `verified` (a maintainer
 * checked a crop); units naming different plants make it ambiguous.
 */
export function merge(table: SharedPodCodes, pairs: CodePlant[], by: string, verified: boolean): { table: SharedPodCodes, outcomes: Array<CodePlant & { status: Outcome }> } {
  const codes = new Map(table.codes.map(c => [c.code, c]))
  const outcomes: Array<CodePlant & { status: Outcome }> = []
  for (const { code, plant } of pairs) {
    const was = codes.get(code)
    const votes: Record<string, string[]> = Object.fromEntries(Object.entries(was?.votes ?? {})
      .map(([p, v]) => [p, p === plant ? v : v.filter(f => f !== by)] as const)
      .filter(([, v]) => v.length > 0))
    if (!(votes[plant] ?? []).includes(by)) votes[plant] = [...(votes[plant] ?? []), by]
    const isVerified = (was?.verified ?? false) || verified
    // The plant most units named; on a tie the one already in the table stays.
    const lead = Object.entries(votes).sort((a, b) => b[1].length - a[1].length || Number(b[0] === was?.plant) - Number(a[0] === was?.plant))[0] as [string, string[]]
    const entry: SharedPodCode = { code, plant: lead[0], units: lead[1].length, status: statusOf(votes, isVerified), votes }
    if (isVerified) entry.verified = true
    codes.set(code, entry)
    outcomes.push({ code, plant, status: entry.status })
  }
  return { table: { version: table.version, codes: [...codes.values()].sort((a, b) => a.code.localeCompare(b.code)) }, outcomes }
}

export interface Issue { body: string, author: string, labels: string[], number: number }

/** What the bot does with one issue: the new table (null when nothing changes) and the comment. */
export function run(table: SharedPodCodes, issue: Issue): { table: SharedPodCodes | null, comment: string } {
  const form = formFields(issue.body)
  const { pairs, problems } = parsePairs(form.pairs, PLANTS)
  const fingerprint = form.fingerprint.trim().toLowerCase()
  if (fingerprint && !FINGERPRINT.test(fingerprint)) problems.push(`The unit fingerprint \`${form.fingerprint.trim()}\` isn't 16 hex digits, so this submission counts as your GitHub account instead.`)
  const rejected = problems.length ? `\n\nRejected:\n${problems.map(p => `- ${p}`).join('\n')}` : ''
  if (!pairs.length) return { table: null, comment: `Thanks! No pair here could be merged.${rejected}\n\nEach line of **Pairs** should be \`code → plant\`, with a code of four of \`o | / h\` and a plant from the catalog.` }
  const verified = issue.labels.includes(VERIFIED_LABEL)
  const out = merge(table, pairs, submitter(form.fingerprint, issue.author), verified)
  const bad = tableProblems(out.table, PLANTS)
  if (bad.length) throw new Error(`the merged table is unsound:\n${bad.join('\n')}`)
  const changed = JSON.stringify(out.table) !== JSON.stringify(table)
  const lines = out.outcomes.map(o => `- \`${o.code}\` → ${o.plant}: ${o.status === 'confirmed' ? 'confirmed' : o.status === 'ambiguous' ? 'ambiguous (units name different plants, so it is never suggested)' : 'pending (one unit so far; confirmed once another unit agrees, or a maintainer checks a crop)'}`)
  return {
    table: changed ? out.table : null,
    comment: `Thanks! ${changed ? 'Merged' : 'Already in the table, unchanged'}:\n${lines.join('\n')}${rejected}`,
  }
}

const stringify = (t: SharedPodCodes) => `${JSON.stringify(t, null, 2)}\n`

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tablePath = process.argv[2] ?? fileURLToPath(new URL('../src/vision/podCodes.json', import.meta.url))
  const commentPath = process.argv[3] ?? 'pod-codes-comment.md'
  const table = JSON.parse(readFileSync(tablePath, 'utf8')) as SharedPodCodes
  const issue: Issue = { body: process.env.ISSUE_BODY ?? '', author: process.env.ISSUE_AUTHOR ?? '', labels: JSON.parse(process.env.ISSUE_LABELS ?? '[]') as string[], number: Number(process.env.ISSUE_NUMBER ?? 0) }
  const out = run(table, issue)
  if (out.table) writeFileSync(tablePath, stringify(out.table))
  writeFileSync(commentPath, `${out.comment}\n`)
  console.log(`changed=${out.table ? 'true' : 'false'}`)
}
