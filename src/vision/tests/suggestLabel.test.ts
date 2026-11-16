import { describe, expect, it } from 'vitest'
import type { PodLabelValue } from '../../store/types'
import { suggestLabel, type SuggestInput } from '../suggestLabel'

const SOWN = '2026-11-01'
const last = (label: PodLabelValue, plantedAt: string | null = SOWN, day = '2026-11-13') => ({ label, ts: `${day}T09:00:00.000Z`, day, plantedAt })
const model = (state: string, confidence: number) => ({ state, confidence, by: 'pod-state@1' })
const at = (o: Partial<SuggestInput>): SuggestInput => ({ plantedAt: SOWN, status: 'growing', last: null, model: null, ...o })

describe('suggestLabel', () => {
  it('carries the last label forward, saying when it was', () => {
    expect(suggestLabel(at({ last: last('sprouted') }))).toEqual({ label: 'sprouted', by: 'carry', confidence: null, from: '2026-11-13T09:00:00.000Z' })
  })

  it('lets the model override only with a later stage at 0.8 or more', () => {
    expect(suggestLabel(at({ last: last('sprouted'), model: model('growing', 0.86) }))).toEqual({ label: 'growing', by: 'pod-state@1', confidence: 0.86, from: null })
    expect(suggestLabel(at({ last: last('sprouted'), model: model('growing', 0.8) }))?.label).toBe('growing')
    // Not confident enough.
    expect(suggestLabel(at({ last: last('sprouted'), model: model('growing', 0.79) }))?.by).toBe('carry')
    // An earlier stage, or the same one, never overrides.
    expect(suggestLabel(at({ last: last('growing'), model: model('empty', 0.99) }))?.label).toBe('growing')
    expect(suggestLabel(at({ last: last('growing'), model: model('growing', 0.99) }))?.by).toBe('carry')
    // Unhealthy is not a later stage, nor is any stage later than unhealthy.
    expect(suggestLabel(at({ last: last('growing'), model: model('unhealthy', 0.99) }))?.label).toBe('growing')
    expect(suggestLabel(at({ last: last('unhealthy'), model: model('ready', 0.99) }))?.label).toBe('unhealthy')
  })

  it('falls back to a confident model alone, then to nothing', () => {
    expect(suggestLabel(at({ model: model('sprouted', 0.9) }))).toEqual({ label: 'sprouted', by: 'pod-state@1', confidence: 0.9, from: null })
    expect(suggestLabel(at({ model: model('sprouted', 0.5) }))).toBeNull()
    // A class the tagger doesn't know is no suggestion.
    expect(suggestLabel(at({ model: model('wilted', 0.95) }))).toBeNull()
    expect(suggestLabel(at({}))).toBeNull()
  })

  it('never carries across a replant', () => {
    // Saved with the planting before this one.
    expect(suggestLabel(at({ last: last('ready', '2026-09-20') }))).toBeNull()
    // Saved with no planting, before the sowing day.
    expect(suggestLabel(at({ last: last('empty', null, '2026-10-31') }))).toBeNull()
    // With none, on or after the sowing day, it is this planting.
    expect(suggestLabel(at({ last: last('seeded', null, '2026-11-01') }))?.label).toBe('seeded')
    // A pod with no sowing date carries only labels saved without one.
    expect(suggestLabel(at({ plantedAt: null, last: last('ready') }))).toBeNull()
    expect(suggestLabel(at({ plantedAt: null, last: last('empty', null) }))?.label).toBe('empty')
    // The model still speaks after a replant.
    expect(suggestLabel(at({ last: last('ready', '2026-09-20'), model: model('empty', 0.9) }))?.by).toBe('pod-state@1')
  })

  it('takes a seeded record over an empty suggestion, since the model has no seeded class', () => {
    expect(suggestLabel(at({ status: 'seeded', model: model('empty', 0.95) }))).toEqual({ label: 'seeded', by: 'record', confidence: null, from: null })
    expect(suggestLabel(at({ status: 'seeded', last: last('empty') }))?.label).toBe('seeded')
    // Only a tie-break: the record alone suggests nothing, and doesn't touch other labels.
    expect(suggestLabel(at({ status: 'seeded' }))).toBeNull()
    expect(suggestLabel(at({ status: 'seeded', last: last('sprouted') }))?.label).toBe('sprouted')
    expect(suggestLabel(at({ status: 'growing', model: model('empty', 0.95) }))?.label).toBe('empty')
  })
})
