import { describe, expect, it } from 'vitest'
import { PLANTS } from '../../../plants/catalog'
import { CATALOG, lookup, words } from '../plants/catalog'

describe('plant catalog', () => {
  it('covers every built-in catalog plant once', () => {
    expect(new Set(CATALOG.map(e => e.name)).size).toBe(CATALOG.length)
    expect(PLANTS.map(p => p.name).filter(name => !lookup(name))).toEqual([])
  })

  it('normalises names to plain singular words', () => {
    expect(words('Jalapeños')).toEqual(['jalapeno'])
    expect(words('Red Cherry Tomatoes')).toEqual(['red', 'cherry', 'tomato'])
    expect(words('Watercress')).toEqual(['watercress'])
  })

  it.each([
    ['Butterhead Lettuce', 'Butterhead'],
    ['Genovese Basil', 'Basil'],
    ['Red Russian Kale', 'Kale'],
    ['Cherry Tomato', 'Red Cherry Tomatoes'],
    ['Thai Basil', 'Sweet Thai Basil'],
    ['Swiss Chard', 'Red Swiss Chard'],
    ['Bok Choy', 'Green Bok Choy'],
    ['Jalapeño', 'Jalapeños'],
    ['peppers', 'Sweet Peppers'],
    ['beans', 'Green Beans'],
    ['Lavender', 'Lavender'],
    ['Lime Basil', 'Lime Basil'],
    ['Mammoth Basil', 'Mammoth Basil'],
    ['Pink Swiss Chard', 'Pink Swiss Chard'],
    ['Oopsy Daisy', 'Oopsy Daisy'],
    ['Bare Root Strawberries', 'Bare Root Strawberries'],
    ['Purslane', 'Purslane'],
  ])('matches %s to %s', (name, found) => {
    expect(lookup(name)?.name).toBe(found)
  })

  it('finds nothing for an empty or unrelated name, or one made only of qualifiers', () => {
    expect(lookup(null)).toBeNull()
    expect(lookup('')).toBeNull()
    expect(lookup('Mystery seed')).toBeNull()
    expect(lookup('Red lettuce')).toBeNull()
  })
})
