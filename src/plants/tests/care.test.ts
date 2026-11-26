import { describe, expect, it } from 'vitest'
import { careNotes } from '../care'
import raw from '../care.json'
import { PLANTS } from '../catalog'

describe('careNotes', () => {
  it('has notes keyed by catalog id, and none for a page without them or an unknown plant', () => {
    const catalogIds = PLANTS.map(p => p.id)
    expect(Object.keys(raw.plants).every(id => catalogIds.includes(id))).toBe(true)
    expect(catalogIds.filter(id => !Object.hasOwn(raw.plants, id)).sort()).toEqual(['oopsy-daisy', 'pink-swiss-chard'])
    expect(careNotes('pink-swiss-chard')).toBeNull()
    expect(careNotes('cucumber')?.prune).toMatch(/no more than 5 cucumbers/)
    expect(careNotes('white-petunia')).toBeNull()
    expect(careNotes('okra')).toBeNull()
  })
})
