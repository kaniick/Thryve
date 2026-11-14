/**
 * The shared code → plant table (#259): pairs owners confirmed on their own
 * units, merged from their submissions by the pod-codes bot. Gardyn's codes
 * are the same on every unit, so one owner's confirmation can help the next.
 * The table is bundled with core and reaches a unit only through a release;
 * a unit never fetches it (the LAN-only invariant).
 *
 * The owner's own confirmed pair always comes first, then a `confirmed`
 * shared entry, then the pod record. A `pending` or `ambiguous` entry is
 * never suggested.
 */
import { POD_CODE, profileKey } from '../store/types'
import table from './podCodes.json'

/** `confirmed`: 2+ units agree, or a maintainer checked a crop. `pending`: one unit so far. `ambiguous`: units name different plants. */
export type SharedStatus = 'confirmed' | 'pending' | 'ambiguous'

export interface SharedPodCode {
  code: string
  /** The plant most units named for this code: a `CATALOG` name. */
  plant: string
  /** Distinct units that named `plant`. */
  units: number
  status: SharedStatus
  /** A maintainer checked a crop (the `pod-codes-verified` label), so one unit is enough. */
  verified?: boolean
  /** Every plant named for this code, with the fingerprints of the units that named it. */
  votes: Record<string, string[]>
}

export interface SharedPodCodes { version: number, codes: SharedPodCode[] }

/** The table this release shipped with. */
export const SHARED_POD_CODES: SharedPodCodes = table as SharedPodCodes

/** Confirmed entries as code → plant. */
export function sharedPairs(t: SharedPodCodes = SHARED_POD_CODES): Map<string, string> {
  return new Map(t.codes.filter(c => c.status === 'confirmed').map(c => [c.code, c.plant]))
}

/** The status an entry's votes give it: ambiguous on any disagreement, confirmed with 2+ units or a maintainer's check. */
export function statusOf(votes: Record<string, string[]>, verified = false): SharedStatus {
  if (Object.keys(votes).length > 1) return 'ambiguous'
  const units = Object.values(votes)[0]?.length ?? 0
  return units >= 2 || verified ? 'confirmed' : 'pending'
}

/** What is wrong with a table, one line per problem; empty when every entry is sound. `plants` are the `CATALOG` names. */
export function tableProblems(t: SharedPodCodes, plants: string[]): string[] {
  const known = new Set(plants)
  const seen = new Set<string>()
  return t.codes.flatMap((c) => {
    const out: string[] = []
    if (!POD_CODE.test(c.code)) out.push(`${c.code}: not a code`)
    if (seen.has(c.code)) out.push(`${c.code}: listed twice`)
    seen.add(c.code)
    for (const p of [c.plant, ...Object.keys(c.votes)]) if (!known.has(p)) out.push(`${c.code}: ${p} is not in the catalog`)
    const by = c.votes[c.plant] ?? []
    if (new Set(by).size !== by.length) out.push(`${c.code}: a unit is counted twice`)
    if (c.units !== by.length) out.push(`${c.code}: ${c.units} units, but ${by.length} named ${c.plant}`)
    if (c.status !== statusOf(c.votes, c.verified)) out.push(`${c.code}: ${c.status}, but its votes make it ${statusOf(c.votes, c.verified)}`)
    return out
  })
}

/** Where a code's plant came from: the owner's pair, the shared table, or the pod record. */
export type CodeSource = 'own' | 'shared' | 'record'

export interface CodeLookup {
  plant: string | null
  from: CodeSource | null
  /** The shared table's confirmed plant, whether or not it was used. */
  shared: string | null
  /** The owner's pair names another plant than the shared table; the owner's wins. */
  disagrees: boolean
}

/** What a code is: the owner's pair, else a confirmed shared entry, else the pod record. */
export function lookupCode(own: string | null, shared: string | null, recorded: string | null): CodeLookup {
  const disagrees = own !== null && shared !== null && profileKey(own) !== profileKey(shared)
  if (own !== null) return { plant: own, from: 'own', shared, disagrees }
  if (shared !== null) return { plant: shared, from: 'shared', shared, disagrees }
  return { plant: recorded, from: recorded === null ? null : 'record', shared, disagrees }
}
