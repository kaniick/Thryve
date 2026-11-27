import { profileKey, type PlantEvent, type PlantLife, type Pod, type PodChange } from '../store/types'

export type NewLife = Omit<PlantLife, 'id'>
export type NewPlantEvent = Omit<PlantEvent, 'id'>

interface JournalWriter {
  create(life: NewLife): PlantLife
  save(life: PlantLife): void
  append(event: NewPlantEvent): void
}

/** Whole-batch identities come from the pre-move snapshot, including chains and swaps. */
export function applyPodChanges(pods: Pod[], active: PlantLife[], changes: PodChange[], at: string, write: JournalWriter): Pod[] {
  const originals = new Map(pods.map(p => [p.slot, p]))
  const current = new Map(active.map(p => [p.slot, p]))
  const targets = new Set(changes.map(c => c.slot))
  if (targets.size !== changes.length) throw new Error('a pod cannot be updated twice in a move')
  const links = new Set<number>()
  const movedSources = new Set(changes.flatMap(c => c.fromSlot !== undefined && c.fromSlot !== c.slot ? [c.fromSlot] : []))
  const prepared = changes.map(({ slot, patch, fromSlot }) => {
    const prev = originals.get(slot)
    if (!prev) throw new Error(`no pod ${slot}`)
    if (fromSlot !== undefined && !targets.has(fromSlot)) throw new Error('a move must update the source and destination together')
    const row: Pod = { ...prev, ...patch, updatedAt: at, statusSince: patch.status !== undefined && patch.status !== prev.status ? at : prev.statusSince }
    const planted = row.status !== 'empty' && !!row.plant?.trim()
    const old = fromSlot === undefined && movedSources.has(slot) ? undefined : current.get(fromSlot ?? slot)
    const same = planted && old && (fromSlot !== undefined || (
      profileKey(old.plant) === profileKey(row.plant ?? '') && (!old.plantedAt || !row.plantedAt || old.plantedAt === row.plantedAt)
    ))
    const life = same ? old : undefined
    if (life && links.has(life.id)) throw new Error('a plant cannot move to two destinations')
    if (life) links.add(life.id)
    return { prev, row, planted, life }
  })

  const event = (lifeId: number, slot: number, kind: NewPlantEvent['kind'], fromSlot: number | null = null, note: string | null = null) =>
    write.append({ lifeId, at, kind, slot, fromSlot, note })
  for (const life of active) {
    if (life.slot !== null && targets.has(life.slot) && !links.has(life.id)) {
      write.save({ ...life, slot: null, endedAt: at })
      event(life.id, life.slot, 'removed')
    }
  }
  for (const { prev, row, planted, life } of prepared) {
    if (!planted || !row.plant) continue
    if (!life) {
      const fresh = write.create({ plant: row.plant, plantedAt: row.plantedAt, slot: row.slot, startedAt: at, endedAt: null })
      event(fresh.id, row.slot, row.plantedAt ? 'sowed' : 'recorded', null, row.notes || null)
      // Never carry a previous occupant's harvest into a new plant's record.
      if (prev.plant?.trim() && row.lastHarvestAt === prev.lastHarvestAt) row.lastHarvestAt = null
      if (row.lastHarvestAt) write.append({ lifeId: fresh.id, at: row.lastHarvestAt, slot: row.slot, kind: 'harvested', fromSlot: null, note: null })
      continue
    }
    const moved = life.slot !== row.slot
    if (moved || life.plantedAt !== row.plantedAt || life.plant !== row.plant) {
      write.save({ ...life, slot: row.slot, plant: row.plant, plantedAt: row.plantedAt })
    }
    if (moved) event(life.id, row.slot, 'moved', life.slot)
    else {
      if (row.notes !== prev.notes) event(life.id, row.slot, 'note', null, row.notes || null)
      if (row.lastHarvestAt && row.lastHarvestAt !== prev.lastHarvestAt) event(life.id, row.slot, 'harvested')
    }
  }
  return prepared.map(({ row }) => row)
}
