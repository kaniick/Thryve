import { describe, expect, it } from 'vitest'
import { lookup, renderTemplate } from '../template'

describe('notification templates', () => {
  it('fills dotted paths and blanks unknown ones', () => {
    const ctx = { unit: { name: 'Kitchen' }, sensor: { water_level_pct: 18 }, alert: { detail: 'Tank low' } }
    expect(renderTemplate('{{unit.name}}: {{sensor.water_level_pct}}% — {{alert.detail}}', ctx)).toBe('Kitchen: 18% — Tank low')
    expect(renderTemplate('missing {{nope.here}} end', ctx)).toBe('missing  end')
    expect(lookup(ctx, 'sensor.water_level_pct')).toBe(18)
  })
})
