import { describe, expect, it } from 'vitest'
import { cardPlace, stateGuess } from '../PodCard'

describe('stateGuess', () => {
  it('names the likeliest state, and the runner-up when it is close enough to matter', () => {
    expect(stateGuess({ value: 1, detail: { probabilities: { empty: 0, sprouted: 0.901, unhealthy: 0.061 } } })).toBe('sprouted 90%')
    expect(stateGuess({ value: 0, detail: { probabilities: { empty: 0.492, sprouted: 0.445, growing: 0.007 } } })).toBe('empty 49% · sprouted 45%')
  })

  it('falls back to the state and confidence, or the class index', () => {
    expect(stateGuess({ value: 2, detail: { state: 'growing', confidence: 0.87 } })).toBe('growing 87%')
    expect(stateGuess({ value: 2, detail: { probabilities: { growing: 'high' } } })).toBe('growing')
    expect(stateGuess({ value: 9, detail: null })).toBe('class 9')
  })
})

describe('cardPlace', () => {
  it('puts the card under a pod in the top half and over one in the bottom half, on the side that keeps it in the photo', () => {
    const high = cardPlace({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
    expect(Object.keys(high).sort()).toEqual(['left', 'top'])
    expect(parseFloat(high.top as string)).toBeCloseTo(30)
    expect(parseFloat(high.left as string)).toBeCloseTo(10)
    const low = cardPlace({ x: 0.6, y: 0.6, w: 0.2, h: 0.2 })
    expect(Object.keys(low).sort()).toEqual(['bottom', 'right'])
    expect(parseFloat(low.bottom as string)).toBeCloseTo(40)
    expect(parseFloat(low.right as string)).toBeCloseTo(20)
  })
})
