/**
 * Pods the cameras see empty while their record still holds a plant: the
 * plant was taken out and the record never heard. It reads what the pod-state
 * model already stored, the same results the tagger's suggestions use (#261).
 */
import type { Store } from '../store/types'
import { cameraOf, podRegions } from './regions'
import { POD_STATE_ID } from './podState'
import { SUGGEST_CONFIDENCE } from './suggestLabel'

/** Older than this, the newest result says nothing about the pod now: the cameras stopped, or the light stayed off. */
export const SEEN_MAX_AGE_MS = 2 * 86_400_000

export interface SeenEmpty {
  slot: number
  /** The model's confidence that the pod is empty. */
  confidence: number
  /** The photo's time. */
  ts: string
}

/**
 * Each pod whose newest pod-state result (the newest version's) says `empty`
 * with confidence ≥ SUGGEST_CONFIDENCE, from a photo taken after the pod's
 * record last changed and within SEEN_MAX_AGE_MS. Dark stills are never
 * scored, so they never count. Seeded pods are left out: the model has no
 * `seeded` class, so a sown yCube looks empty to it.
 */
export function seenEmpty(store: Pick<Store, 'pods' | 'analyses' | 'settings'>, now: Date): SeenEmpty[] {
  const planted = store.pods.list().filter(p => p.status !== 'empty' && p.status !== 'seeded')
  if (!planted.length) return []
  const calibration = store.settings.get().podRegions
  const boxes = { upper: podRegions('upper', calibration), lower: podRegions('lower', calibration) }
  const since = now.getTime() - SEEN_MAX_AGE_MS
  const version = Math.max(0, ...store.analyses.stats().filter(s => s.analyzer === POD_STATE_ID).map(s => s.version))
  if (!version) return []
  const byCapture = new Map<string, ReturnType<Store['analyses']['forCapture']>>()
  const out: SeenEmpty[] = []
  for (const pod of planted) {
    const camera = cameraOf(pod.slot)
    if (!camera || !boxes[camera][pod.slot]) continue
    const last = store.analyses.series({ analyzer: POD_STATE_ID, version, slot: pod.slot, metric: 'pod_state', limit: 1 }).at(-1)
    const t = last ? Date.parse(last.ts) : Number.NaN
    if (!last || !(t >= since) || t > now.getTime() || t <= Date.parse(pod.updatedAt)) continue
    let frame = byCapture.get(last.captureId)
    if (!frame) {
      frame = store.analyses.forCapture(last.captureId).filter(r => r.analyzer === POD_STATE_ID && r.version === version && r.metric === 'pod_state')
      byCapture.set(last.captureId, frame)
    }
    const d = frame.find(r => r.slot === pod.slot)?.detail
    if (d?.state === 'empty' && typeof d.confidence === 'number' && d.confidence >= SUGGEST_CONFIDENCE) out.push({ slot: pod.slot, confidence: d.confidence, ts: last.ts })
  }
  return out
}
