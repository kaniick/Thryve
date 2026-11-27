import { z } from 'zod'
import { latestFirst, type ActivityEntry } from './activity'

const probe = z.object({ result: z.string().min(1).max(40) })
const sample = z.object({
  ts: z.iso.datetime({ offset: true }),
  host: z.ipv4(),
  core: probe,
  hald: probe,
  ssh: probe.nullable(),
})
type Sample = z.infer<typeof sample>
export const MAX_OBSERVER_FILE_BYTES = 8 << 20
// Enough for seven days at the supported minimum five-second cadence.
const MAX_SAMPLES = 125_000
const COVERAGE_GAP_MS = 15 * 60_000

export function parseObserver(files: string[]): { entries: ActivityEntry[], sampleCount: number, ignored: number } {
  const rows = new Map<string, Sample>()
  let ignored = 0
  let host: string | null = null
  for (const source of files) {
    for (const line of source.split('\n')) {
      if (!line.trim()) continue
      if (line.length > 2_048) {
        ignored++
        continue
      }
      let row: unknown
      try {
        row = JSON.parse(line)
      }
      catch {
        ignored++
        continue
      }
      const parsed = sample.safeParse(row)
      if (!parsed.success || rows.size >= MAX_SAMPLES) {
        ignored++
        continue
      }
      const { data } = parsed
      if (host && host !== data.host) throw new Error('Choose observer logs for just one target at a time.')
      host = data.host
      const ts = new Date(data.ts).toISOString()
      rows.set(ts, { ...data, ts })
    }
  }
  if (!rows.size) throw new Error('No valid observer samples were found.')
  const entries: ActivityEntry[] = []
  let previous: Sample | undefined
  let previousState: string | null = null
  let ssh: { at: number, ok: boolean } | null = null
  for (const row of [...rows.values()].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const time = Date.parse(row.ts)
    if (previous && time - Date.parse(previous.ts) > COVERAGE_GAP_MS) {
      entries.push({ key: 'observer-gap:' + row.ts, at: row.ts, kind: 'observer', title: 'Observer coverage gap',
        detail: 'No samples between ' + previous.ts + ' and ' + row.ts + '. Gateway availability in that interval is unknown.', attention: true })
      previousState = null
      ssh = null
    }
    if (row.ssh !== null) ssh = { at: time, ok: row.ssh.result === 'ok' }
    const sshOK = ssh && time - ssh.at <= 65_000 ? ssh.ok : null
    const core = row.core.result === 'ok'
    const hald = row.hald.result === 'ok'
    const state = core && hald
      ? (sshOK === false ? 'SSH probe failed' : 'Apps responding')
      : !core && !hald
          ? (sshOK === false ? 'All three probes failed' : sshOK ? 'Core and HAL unreachable, SSH responding' : 'Core and HAL unreachable, SSH not verified')
          : core
            ? 'HAL probe failed, Core responding'
            : sshOK === true ? 'Core unreachable, HAL and SSH responding' : 'Core unreachable, HAL responding'
    if (state !== previousState && (state !== 'Apps responding' || previousState !== null)) {
      entries.push({ key: 'observer:' + row.ts, at: row.ts, kind: 'observer', title: state,
        detail: 'External probes. Core: ' + row.core.result + ' · HAL: ' + row.hald.result + ' · SSH: ' + (row.ssh?.result ?? 'not sampled this round'),
        attention: state !== 'Apps responding' })
    }
    previous = row
    previousState = state
  }
  return { entries: entries.sort(latestFirst), sampleCount: rows.size, ignored }
}
