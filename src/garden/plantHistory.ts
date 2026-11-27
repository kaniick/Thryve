import { z } from 'zod'
import { PLANT_EVENT_KINDS, type Capture, type PlantEvent, type Store } from '../store/types'
import { cameraOf, podRegions } from '../vision/regions'

export const PlantLife = z.object({ id: z.number(), plant: z.string(), plantedAt: z.string().nullable(), slot: z.number().nullable(), startedAt: z.string(), endedAt: z.string().nullable() })
export const PlantEventOut = z.object({ id: z.number(), lifeId: z.number(), at: z.string(), kind: z.enum(PLANT_EVENT_KINDS), slot: z.number(), fromSlot: z.number().nullable(), note: z.string().nullable() })
export const CameraEvidence = z.object({
  id: z.string(), ts: z.string(), camera: z.enum(['upper', 'lower']), slot: z.number(), url: z.string(),
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
})
const RetainedVisit = z.object({ slot: z.number(), from: z.string(), to: z.string().nullable(), photos: z.array(CameraEvidence) })
export const PlantHistory = z.object({ life: PlantLife, events: z.array(PlantEventOut), visits: z.array(RetainedVisit), visitsOmitted: z.number() })

export function cameraEvidence(c: Capture, slot: number, calibration: Parameters<typeof podRegions>[1]): z.infer<typeof CameraEvidence> {
  return { id: c.id, ts: c.ts, camera: c.camera, slot, url: '/api/captures/' + encodeURIComponent(c.id) + '.jpg', box: podRegions(c.camera, calibration)[slot] ?? null }
}

export function occupancy(events: PlantEvent[]) {
  const visits: Array<{ slot: number, from: string, to: string | null }> = []
  for (const e of events) {
    if (!['sowed', 'recorded', 'moved', 'removed'].includes(e.kind)) continue
    const last = visits.at(-1)
    if (last) last.to = e.at
    if (e.kind !== 'removed') visits.push({ slot: e.slot, from: e.at, to: null })
  }
  return visits
}

export function plantHistory(store: Store, id: number): z.infer<typeof PlantHistory> | null {
  const life = store.plantJournal.get(id)
  if (!life) return null
  const events = store.plantJournal.events(id)
  const all = occupancy(events)
  const calibration = store.settings.get().podRegions
  const retained = all.slice(-30).reverse().map((visit) => {
    const camera = cameraOf(visit.slot)
    if (camera === null) return { ...visit, photos: [] }
    const first = store.captures.during(camera, visit.from, visit.to, 1, true)[0]
    const latest = store.captures.during(camera, visit.from, visit.to, 2).reverse()
    const frames = first && !latest.some(c => c.id === first.id) ? [first, ...latest] : latest
    return { ...visit, photos: frames.map(c => cameraEvidence(c, visit.slot, calibration)) }
  })
  return { life, events, visits: retained, visitsOmitted: all.length - retained.length }
}
