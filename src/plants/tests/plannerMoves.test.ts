import { describe, expect, it } from 'vitest'
import { podMoveOptions, type MoveSlot } from '../plannerMoves'

const a = { slot: 1, plant: 'Red Cherry Tomato', status: 'growing' }
const free = (slot: number) => ({ slot, plant: null, status: 'empty' })
const zones: MoveSlot[] = [{ slot: 1, zone: 'low' }, { slot: 2, zone: 'high' }, { slot: 3, zone: 'medium' }, { slot: 4, zone: 'high' }]

describe('podMoveOptions', () => {
  it('offers the preferred open zone and leaves reserved plan slots alone', () => {
    expect(podMoveOptions([a, free(2), free(3), free(4)], zones, [], new Set([2]))).toEqual([
      { from: 1, to: 4, plant: 'Red Cherry Tomato', zone: 'high', swap: null },
    ])
  })

  it('does not second-guess the saved light-zone override', () => {
    expect(podMoveOptions([a, free(2)], zones, [], new Set(), { allowedZones: { 'red-cherry-tomato': ['low', 'high'] } })).toEqual([])
  })

  it('does not displace an unknown or well-placed plant to a worse zone', () => {
    expect(podMoveOptions([a, { slot: 2, plant: 'Unknown plant', status: 'growing' }], zones, [], new Set())).toEqual([])
    expect(podMoveOptions([a, { ...a, slot: 2 }], zones, [], new Set())).toEqual([])
  })

  it('permits an optional swap when the other plant can use the source zone', () => {
    const basil = { slot: 2, plant: 'Basil', status: 'growing' }
    expect(podMoveOptions([a, basil], zones, [], new Set())).toEqual([
      { from: 1, to: 2, plant: 'Red Cherry Tomato', zone: 'high', swap: 'Basil' },
    ])
  })
})
