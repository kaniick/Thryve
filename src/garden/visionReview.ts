import { z } from 'zod'
import type { AnalysisRow, Capture, Store } from '../store/types'
import { cameraOf } from '../vision/regions'
import { CameraEvidence, cameraEvidence, occupancy } from './plantHistory'

const Method = z.object({ analyzer: z.string(), version: z.number() })
export const VisionReview = z.object({
  methods: z.array(Method), selected: Method.nullable(), reference: z.string(),
  items: z.array(z.object({
    slot: z.number(), plant: z.string(), deviceCover: z.number(), workerCover: z.number(),
    difference: z.number(), photo: CameraEvidence, before: CameraEvidence.nullable(),
  })),
})
const reference = 'green-threshold'
const freshEnough = (after: string, before: string) => Date.parse(after) - Date.parse(before) >= 6 * 3_600_000
const same = (a: z.infer<typeof Method>, b: z.infer<typeof Method>) => a.analyzer === b.analyzer && a.version === b.version

/** Rank method disagreement on comparable images only. A difference is not a diagnosis. */
export function visionReview(store: Store, wanted?: z.infer<typeof Method>): z.infer<typeof VisionReview> {
  const seen: Array<{ capture: Capture, rows: AnalysisRow[] }> = []
  const remote = new Map<string, z.infer<typeof Method>>()
  const referenceVersion = store.analyses.latestVersion(reference)
  for (const camera of ['upper', 'lower'] as const) {
    for (const capture of store.captures.list(camera, 24)) {
      const check = store.diagnostics.frame(capture.id)
      if (check && check !== 'scored') continue
      const rows = store.analyses.forCapture(capture.id).filter(r => r.metric === 'green_fraction' && Number.isFinite(r.value) && r.value >= 0 && r.value <= 1)
      for (const r of rows) if (r.source === 'remote') remote.set(r.analyzer + '@' + r.version, { analyzer: r.analyzer, version: r.version })
      seen.push({ capture, rows })
    }
  }
  const methods = [...remote.values()].sort((a, b) => a.analyzer.localeCompare(b.analyzer) || b.version - a.version)
  const selected = wanted ? methods.find(m => same(m, wanted)) ?? null : methods[0] ?? null
  const calibration = store.settings.get().podRegions
  const items: z.infer<typeof VisionReview>['items'] = []
  if (selected) {
    for (const life of store.plantJournal.active()) {
      if (life.slot === null) continue
      const slot = life.slot
      const camera = cameraOf(slot)
      if (!camera) continue
      const start = occupancy(store.plantJournal.events(life.id)).at(-1)?.from
      const atSlot = seen.filter(f => f.capture.camera === camera && start && f.capture.ts >= start)
      const paired = atSlot.flatMap(({ capture, rows }) => {
        const device = rows.find(r => r.slot === slot && r.source === 'device' && r.analyzer === reference && r.version === referenceVersion)
        const worker = rows.find(r => r.slot === slot && r.source === 'remote' && same(r, selected))
        return device && worker && cameraEvidence(capture, slot, calibration).box ? [{ capture, device, worker }] : []
      })
      const latest = paired[0]
      if (!latest) continue
      const before = paired.find(p => freshEnough(latest.capture.ts, p.capture.ts))
      const diff = Math.abs(latest.device.value - latest.worker.value)
      if (diff < 0.05) continue
      items.push({ slot, plant: life.plant, deviceCover: latest.device.value, workerCover: latest.worker.value, difference: diff,
        photo: cameraEvidence(latest.capture, slot, calibration), before: before ? cameraEvidence(before.capture, slot, calibration) : null })
    }
  }
  return { methods, selected, reference, items: items.sort((a, b) => b.difference - a.difference || a.slot - b.slot).slice(0, 12) }
}
