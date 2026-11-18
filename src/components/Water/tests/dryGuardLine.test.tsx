// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brownoutLine, DryGuardLine, dryGuardLine, fmtSeconds } from '../DryGuardLine'

const { calls, state } = vi.hoisted(() => ({
  calls: { setDryGrace: vi.fn(), invalidate: vi.fn() },
  state: { error: null as null | { message: string }, pending: false },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ system: { invalidate: calls.invalidate } }),
    pump: {
      setDryGrace: {
        useMutation: (o: { onSuccess: () => void }) => ({
          error: state.error,
          isPending: state.pending,
          mutate: (i: unknown, m?: { onSuccess?: () => void }) => {
            calls.setDryGrace(i)
            o.onSuccess()
            m?.onSuccess?.()
          },
        }),
      },
    },
  },
}))

const limits = { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16, pumpDryGuard: 'both' as const, pumpDryGraceMs: 1200, pumpDryGraceMinMs: 300, pumpDryGraceMaxMs: 5000 }

beforeEach(() => {
  for (const f of Object.values(calls)) f.mockReset()
  state.error = null
  state.pending = false
})
afterEach(cleanup)

describe('dry-run guard words', () => {
  it('names each guard and says where it is set', () => {
    expect(dryGuardLine('both')).toBe('Dry-run guard: tank level + pump current — change in Settings')
    expect(dryGuardLine('level')).toBe('Dry-run guard: tank level — change in Settings')
    expect(dryGuardLine('current')).toBe('Dry-run guard: pump current — change in Settings')
    expect([fmtSeconds(1200), fmtSeconds(300), fmtSeconds(5000), fmtSeconds(1250)]).toEqual(['1.2 s', '0.3 s', '5 s', '1.3 s'])
  })
})

describe('brown-out guard words', () => {
  it('says what the guard watches, or that it is off, and nothing from an older hald', () => {
    expect(brownoutLine({ pumpBrownoutV: 10.8, pumpBrownoutMs: 300, pumpBrownoutPi: true })).toBe('Brown-out guard: stops below 10.8 V for 0.3 s or on the Pi\'s under-voltage flag (set on the unit)')
    expect(brownoutLine({ pumpBrownoutV: 10.8, pumpBrownoutMs: 300, pumpBrownoutPi: false })).toBe('Brown-out guard: stops below 10.8 V for 0.3 s (set on the unit)')
    expect(brownoutLine({ pumpBrownoutMs: 300, pumpBrownoutPi: true })).toBe('Brown-out guard: stops on the Pi\'s under-voltage flag for 0.3 s (set on the unit)')
    expect(brownoutLine({ pumpBrownoutMs: 300, pumpBrownoutPi: false })).toBe('Brown-out guard: off (set on the unit)')
    expect(brownoutLine({})).toBeNull()
  })
})

describe('DryGuardLine', () => {
  it('shows the brown-out guard read-only beside the dry-run guard', () => {
    render(<DryGuardLine limits={{ ...limits, pumpBrownoutV: 10.8, pumpBrownoutMs: 300, pumpBrownoutPi: false }} />)
    expect(screen.getByTestId('brownout-guard').textContent).toBe('Brown-out guard: stops below 10.8 V for 0.3 s (set on the unit)')
    render(<DryGuardLine limits={limits} />)
    expect(screen.getAllByTestId('brownout-guard')).toHaveLength(1)
  })

  it('shows the guard read-only and the grace with its bounds', () => {
    render(<DryGuardLine limits={limits} />)
    expect(screen.getByText('Dry-run guard: tank level + pump current — change in Settings')).toBeTruthy()
    expect(screen.getByText('Grace before the pump-current check (0.3 s–5 s)')).toBeTruthy()
    expect(screen.getByText('1.2 s')).toBeTruthy()
    // Nothing on the line can change the guard itself.
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('saves a new grace and only once it differs', () => {
    render(<DryGuardLine limits={limits} />)
    fireEvent.click(screen.getByRole('button', { name: 'Increase Grace before the pump-current check' }))
    expect(screen.getByText('1.3 s')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.setDryGrace).toHaveBeenCalledWith({ ms: 1300 })
    expect(calls.invalidate).toHaveBeenCalledTimes(1)
    // Saved: the line goes back to what the unit reports.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Grace before the pump-current check' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Grace before the pump-current check' }))
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('holds the stepper to the unit\'s bounds', () => {
    render(<DryGuardLine limits={{ ...limits, pumpDryGraceMs: 5000 }} />)
    expect((screen.getByRole('button', { name: 'Increase Grace before the pump-current check' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    render(<DryGuardLine limits={{ ...limits, pumpDryGraceMs: 300 }} />)
    expect((screen.getByRole('button', { name: 'Decrease Grace before the pump-current check' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says why a save failed and holds Save while one is on its way', () => {
    state.error = { message: 'this hald can\'t set the dry-run grace; update it' }
    state.pending = true
    render(<DryGuardLine limits={limits} />)
    expect(screen.getByText('this hald can\'t set the dry-run grace; update it')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Increase Grace before the pump-current check' }))
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows nothing for a hald that reports no guard, and no control without bounds', () => {
    const { container } = render(<DryGuardLine limits={undefined} />)
    expect(container.innerHTML).toBe('')
    render(<DryGuardLine limits={{ pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 }} />)
    expect(screen.queryByTestId('dry-guard')).toBeNull()
    render(<DryGuardLine limits={{ pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16, pumpDryGuard: 'level' }} />)
    expect(screen.getByText('Dry-run guard: tank level — change in Settings')).toBeTruthy()
    expect(screen.queryByText(/Grace before/)).toBeNull()
    cleanup()
    for (const partial of [{ pumpDryGraceMinMs: undefined }, { pumpDryGraceMaxMs: undefined }]) {
      render(<DryGuardLine limits={{ ...limits, ...partial }} />)
      expect(screen.queryByText(/Grace before/)).toBeNull()
      cleanup()
    }
  })
})
