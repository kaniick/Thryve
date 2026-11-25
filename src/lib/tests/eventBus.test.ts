import { expect, it, vi } from 'vitest'
import { createEventBus } from '../eventBus'

it('keeps delivering events when a subscriber fails and bounds repeated warnings', () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const events = createEventBus()
    const bad = vi.fn(() => {
      throw new Error('database is locked')
    })
    const other = vi.fn()
    events.subscribe(bad)
    events.subscribe(other)
    const event = { kind: 'mutation', path: 'tank' } as const
    events.emit(event)
    events.emit(event)
    expect(bad).toHaveBeenCalledTimes(2)
    expect(other).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledExactlyOnceWith('core event subscriber failed (mutation): database is locked')
    vi.advanceTimersByTime(60_000)
    events.emit(event)
    expect(other).toHaveBeenLastCalledWith(event)
    expect(warn).toHaveBeenCalledTimes(2)
  }
  finally {
    warn.mockRestore()
    vi.useRealTimers()
  }
})
