import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { dueReminders } from '../grow'

describe('thinning reminder', () => {
  it('explains that the number of sprouts to keep varies by plant', () => {
    const store = new MemoryStore()
    const cycle = store.grow.start('2026-01-01T00:00:00Z')
    const due = dueReminders(cycle, store.settings.get(), new Date('2026-01-15T12:00:00Z'))
    expect(due.find(d => d.kind === 'reminder_thinning')?.detail).toContain('3 for herbs and small flowers')
  })
})
