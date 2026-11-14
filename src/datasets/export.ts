/**
 * Dataset export (ADR-0019 phase 2): the photos, every analyser's results,
 * pod and grow-cycle metadata and the sensor telemetry for one time window,
 * as a tar of JSON/JSONL files. It is the thing you pull to a laptop to
 * measure, recalibrate or train — seedypod's counterpart of sleepypod's
 * sleep-stage dataset script. The grower's pod labels (#184) ride along with
 * each pod's crop, so a trainer sees exactly what the analysers see, and the
 * owner's confirmed dot code → plant pairs (#259) go with the archive whole.
 * Suggestions the grower dismissed (#261) go in their own file, never as labels.
 */
import { SensorId } from '../hardware/contract'
import { daysSinceSowing } from '../scheduler/pumpPlan'
import type { Context } from '../server/context'
import type { PodLabel } from '../store/types'
import { jpegSize } from '../vision/jpegSize'
import { CAMERAS, cropPixels, podRegions, type Camera, type PodRegions } from '../vision/regions'
import type { TarEntry } from './tar'

export interface ExportWindow {
  from: string
  to: string
  /** Include the JPEGs (the bulk of the size). */
  images: boolean
}

export interface DatasetSummary extends ExportWindow {
  captures: number
  analyses: number
  telemetry: number
  labels: number
  /** Bytes of stills in the window, a lower bound on the archive size when images are included. */
  imageBytes: number
}

/**
 * Version 2: `labels.jsonl` gained the `seeded` label and `plant`, `plantedAt` and `daysSinceSowing`.
 * Version 3: `labels.jsonl` gained `source`, `suggested`, `suggestedBy` and `suggestedConfidence` (#261), and `pod_codes.json` came in (#259).
 * Version 4: `suggestion_dismissals.json` came in (#261).
 */
export const DATASET_FORMAT = { name: 'seedypod-dataset', version: 4 }

const DAY = 86_400_000
const enc = new TextEncoder()
const json = (v: unknown) => enc.encode(`${JSON.stringify(v, null, 2)}\n`)
const jsonl = (rows: unknown[]) => enc.encode(rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))

/** Default window: the last 30 days, which is also the on-device retention for stills. */
export function resolveWindow(now: Date, q: { from?: string, to?: string, images?: boolean }): ExportWindow {
  const to = q.to ? new Date(q.to) : now
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('from and to must be ISO timestamps')
  if (from > to) throw new Error('from is after to')
  return { from: from.toISOString(), to: to.toISOString(), images: q.images ?? true }
}

function capturesIn(ctx: Context, w: ExportWindow) {
  return ctx.store.captures.list(undefined, Number.MAX_SAFE_INTEGER).filter(c => c.ts >= w.from && c.ts <= w.to).reverse()
}

function telemetryIn(ctx: Context, w: ExportWindow) {
  return SensorId.options.flatMap(s => ctx.store.telemetry.range(s, w.from, w.to, Number.MAX_SAFE_INTEGER))
}

export function summarize(ctx: Context, w: ExportWindow): DatasetSummary {
  const captures = capturesIn(ctx, w)
  return {
    ...w,
    captures: captures.length,
    analyses: ctx.store.analyses.range(w.from, w.to).length,
    telemetry: telemetryIn(ctx, w).length,
    labels: ctx.store.podLabels.range(w.from, w.to).length,
    imageBytes: captures.reduce((n, c) => n + c.bytes, 0),
  }
}

/** One line of `labels.jsonl`: the label, the pod's plant then, and where its pod's crop is in the still. */
export interface LabelRow extends PodLabel {
  /** Whole days from `plantedAt` to the photo; null without a sowing date. */
  daysSinceSowing: number | null
  /** The still's path in this archive, or null when it isn't in it. */
  image: string | null
  /** The still's size in pixels, null when it can't be read. */
  width: number | null
  height: number | null
  /** The pod's crop in the still's pixels, exactly the window the analysers read; null without the still. */
  region: { x: number, y: number, w: number, h: number } | null
  /** The pod's box as fractions of the frame (`regions.json`), whatever the still's size. */
  box: { x: number, y: number, w: number, h: number }
}

/** Every camera's pod boxes as fractions of the frame: the owner's calibration where there is one, the measured defaults elsewhere. */
function regionsOf(ctx: Context): Record<Camera, PodRegions> {
  const calibration = ctx.store.settings.get().podRegions
  return Object.fromEntries(CAMERAS.map(c => [c, podRegions(c, calibration)])) as Record<Camera, PodRegions>
}

/** Labels in the window, each with its pod's crop. Reads only the header of each labelled still. */
async function labelRows(ctx: Context, w: ExportWindow, labels: PodLabel[], regions: Record<Camera, PodRegions>, inArchive: Set<string>): Promise<LabelRow[]> {
  const sizes = new Map<string, { width: number, height: number } | null>()
  for (const id of new Set(labels.map(l => l.captureId))) {
    const got = await ctx.captures.bytes(id).catch(() => null)
    sizes.set(id, got ? jpegSize(got.bytes) : null)
  }
  return labels.map((l) => {
    const box = regions[l.camera][l.slot] ?? { x: 0, y: 0, w: 1, h: 1 }
    const size = sizes.get(l.captureId) ?? null
    return {
      ...l,
      // Counted on the UTC calendar, as it always has been for labels.
      daysSinceSowing: daysSinceSowing(null, [l.plantedAt], new Date(l.ts), 'UTC'),
      image: w.images && size && inArchive.has(l.captureId) ? `images/${l.captureId}.jpg` : null,
      width: size?.width ?? null,
      height: size?.height ?? null,
      region: size ? cropPixels(box, size.width, size.height) : null,
      box,
    }
  })
}

/** Archive-safe folder name, e.g. `seedypod-kitchen-20261001-20261031`. */
export function datasetName(unit: string, w: ExportWindow): string {
  const day = (ts: string) => ts.slice(0, 10).replace(/-/g, '')
  const slug = unit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'unit'
  return `seedypod-${slug}-${day(w.from)}-${day(w.to)}`
}

/** The archive's files, produced lazily so stills are read one at a time. */
export async function* datasetEntries(ctx: Context, w: ExportWindow): AsyncGenerator<TarEntry> {
  const settings = ctx.store.settings.get()
  const root = datasetName(settings.unitName, w)
  const mtime = (ctx.now?.() ?? new Date()).getTime() / 1000
  const file = (name: string, bytes: Uint8Array): TarEntry => ({ name: `${root}/${name}`, bytes, mtime })

  const captures = capturesIn(ctx, w)
  const analyses = ctx.store.analyses.range(w.from, w.to)
  const telemetry = telemetryIn(ctx, w)
  const labels = ctx.store.podLabels.range(w.from, w.to)
  const regions = regionsOf(ctx)
  const podCodes = ctx.store.podCodes.pairs()
  const dismissals = ctx.store.dismissals.range(w.from, w.to)
  const system = ctx.hal.snapshot().system

  yield file('manifest.json', json({
    format: DATASET_FORMAT,
    exportedAt: new Date(mtime * 1000).toISOString(),
    window: { from: w.from, to: w.to },
    unit: { name: settings.unitName, id: system?.unitId ?? null, model: system?.model ?? null, timezone: settings.timezone },
    core: ctx.version,
    primaryAnalyzer: settings.primaryAnalyzer,
    analyzers: ctx.analysis.list().map(({ primary, ...a }) => ({ ...a, primary })),
    counts: { captures: captures.length, analyses: analyses.length, telemetry: telemetry.length, labels: labels.length, podCodes: podCodes.length, dismissals: dismissals.length },
    images: w.images,
  }))
  yield file('README.md', enc.encode(README))
  yield file('captures.jsonl', jsonl(captures.map(c => ({ id: c.id, camera: c.camera, ts: c.ts, bytes: c.bytes, image: w.images && !c.path.startsWith('data:') ? `images/${c.id}.jpg` : null }))))
  yield file('analyses.jsonl', jsonl(analyses))
  yield file('telemetry.jsonl', jsonl(telemetry))
  const stills = new Set(captures.filter(c => !c.path.startsWith('data:')).map(c => c.id))
  yield file('labels.jsonl', jsonl(await labelRows(ctx, w, labels, regions, stills)))
  yield file('regions.json', json(regions))
  yield file('pods.json', json(ctx.store.pods.list()))
  yield file('grow_cycles.json', json(ctx.store.grow.history()))
  yield file('pod_codes.json', json(podCodes))
  yield file('suggestion_dismissals.json', json(dismissals))

  if (!w.images) return
  for (const c of captures) {
    if (c.path.startsWith('data:')) continue
    const got = await ctx.captures.bytes(c.id)
    if (got) yield file(`images/${c.id}.jpg`, got.bytes)
  }
}

const README = `# seedypod dataset

Exported from a seedypod unit (ADR-0019). Every file covers the window in
\`manifest.json\`.

| File | Contents |
|---|---|
| \`manifest.json\` | Format version, window, unit, core version, analysers and which one is primary, row counts |
| \`captures.jsonl\` | One still per line: \`id\`, \`camera\` (upper/lower), \`ts\`, \`bytes\`, \`image\` (path in this archive, or null) |
| \`analyses.jsonl\` | One result per line: \`captureId\`, \`ts\`, \`camera\`, \`analyzer\`, \`version\`, \`source\` (device/remote), \`slot\`, \`metric\`, \`value\`, \`detail\`, \`artifact\` |
| \`labels.jsonl\` | One labelled pod per line: \`captureId\`, \`ts\`, \`camera\`, \`slot\`, \`label\` (see below), \`labelledAt\`, \`plant\` and \`plantedAt\` (the pod's plant and sowing date when it was labelled, or null), \`daysSinceSowing\` (whole days from \`plantedAt\` to \`ts\`, or null), \`source\`, \`suggested\`, \`suggestedBy\` and \`suggestedConfidence\` (how the label was saved, see below), \`image\` (path in this archive, or null), \`width\` and \`height\` of the still, \`region\` (the pod's crop in the still's pixels: \`x\`, \`y\`, \`w\`, \`h\`; null without the still), \`box\` (the same box as fractions of the frame) |
| \`regions.json\` | Every pod's box per camera as fractions of the frame, \`{"upper": {"1": {"x", "y", "w", "h"}, …}, "lower": {…}}\`: the boxes the analysers score on |
| \`telemetry.jsonl\` | One reading per line, thinned to one per 15 minutes past 90 days: \`ts\`, \`sensor\`, \`value\` (canonical units, see the HAL contract) |
| \`pods.json\` | The 30 pods: plant, planted date, status, notes |
| \`grow_cycles.json\` | Grow cycles with start/end and stage |
| \`pod_codes.json\` | The yCube dot codes the owner confirmed: \`code\`, \`plant\`, \`confirmedAt\`, whenever they were confirmed |
| \`suggestion_dismissals.json\` | Pods whose suggestion the grower dismissed on a photo, because the pod can't be seen there or its box isn't on a pod: \`captureId\`, \`ts\` (the photo's time), \`slot\`, \`dismissedAt\`. Not labels: nothing in \`labels.jsonl\` comes from them |
| \`images/<id>.jpg\` | The stills, when exported with images |

Labels are \`empty\` (capped, no yCube), \`seeded\` (a yCube in, nothing
visible yet), \`sprouted\`, \`growing\`, \`ready\` and \`unhealthy\`. The
pod-state model's classes are the same minus \`seeded\`, which came later:
to train the current model, map \`seeded\` to \`empty\` (nothing visible
yet). A six-class model needs the unit's model loader extended first, since
it only accepts the five.

The tagger suggests a label for each pod: the pod's last label on an
earlier photo (\`suggestedBy\` \`carry\`), pod-state when it names a later
stage with confidence 0.8 or more (\`pod-state@<version>\`, with its
\`suggestedConfidence\`), or \`seeded\` from a seeded pod record where the
suggestion was \`empty\` (\`record\`). \`source\` says what the grower did:
\`picked\` a label with no suggestion, \`accepted\` the suggestion (then
\`label\` equals \`suggested\`) or \`corrected\` it. Accepted and corrected
labels were reviewed; score a model only on those. A model trained on
labels accepted from its own suggestions can learn its mistakes back, so
drop or down-weight those when training it, and weight corrected labels
up.

Pods 1–15 are seen by the upper camera, 16–30 by the lower. A pod's crop is
\`image[region.y : region.y + region.h, region.x : region.x + region.w]\`,
the same pixels the analysers score; for a still of another size, scale
\`box\` by its width and height and round outwards. Results from an
off-device worker can be posted back with \`POST /api/analyses/results\`
under a new analyser id; they then show up on the unit's Analysis screen
next to the on-device analysers.
`
