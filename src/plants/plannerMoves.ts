import { makeCatalog, type Plant, type Zone } from './catalog'
import { toleratedZones, type PlanOverrides } from './planner'

export interface MovePod { slot: number, plant: string | null, status: string }
export interface MoveSlot { slot: number, zone: Zone | null }
export interface PodMoveOption { from: number, to: number, plant: string, zone: Zone, swap: string | null }

/**
 * Show at most three independent light-placement improvements. Keep a plant
 * in its current spot when the owner has allowed that zone, and never take a
 * slot reserved by this plan. Work from the current records, not the camera.
 */
export function podMoveOptions(pods: MovePod[], slots: MoveSlot[], catalog: Plant[], reserved: ReadonlySet<number>, overrides?: PlanOverrides): PodMoveOption[] {
  const plants = makeCatalog(catalog.filter(p => p.custom))
  const zoneAt = new Map(slots.map(s => [s.slot, s.zone]))
  const eligible = pods.filter(p => zoneAt.get(p.slot) && !reserved.has(p.slot)).sort((a, b) => a.slot - b.slot)
  const fit = new Map(eligible.flatMap((p) => {
    const plant = p.plant && p.status !== 'empty' ? plants.find(p.plant) : undefined
    return plant ? [[p.slot, toleratedZones(plant, overrides)] as const] : []
  }))
  const candidates: Array<PodMoveOption & { score: number }> = []
  for (const from of eligible) {
    const origin = zoneAt.get(from.slot)
    const places = fit.get(from.slot)
    if (!from.plant || !places || !origin || places.includes(origin)) continue
    for (const to of eligible) {
      const destination = zoneAt.get(to.slot)
      if (!destination || from.slot === to.slot || !places.includes(destination)) continue
      const other = fit.get(to.slot)
      if (to.status !== 'empty' && (!other || !other.includes(origin) || (other.includes(destination) && other.indexOf(origin) > other.indexOf(destination)))) continue
      candidates.push({ from: from.slot, to: to.slot, plant: from.plant, zone: destination, swap: to.status === 'empty' ? null : to.plant, score: places.indexOf(destination) * 2 + (to.status === 'empty' ? 0 : 1) })
    }
  }
  const used = new Set<number>()
  const result: PodMoveOption[] = []
  for (const move of candidates.sort((a, b) => a.score - b.score || a.from - b.from || a.to - b.to)) {
    if (used.has(move.from) || used.has(move.to)) continue
    const { from, to, plant, zone, swap } = move
    result.push({ from, to, plant, zone, swap })
    used.add(move.from)
    used.add(move.to)
    if (result.length === 3) break
  }
  return result
}
