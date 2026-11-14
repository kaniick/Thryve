// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PumpSection, TEST_RUN_S } from '../PumpSection'

const { state, calls } = vi.hoisted(() => ({
  state: { power: undefined as unknown, pump: undefined as unknown, runError: null as null | { message: string } },
  calls: { setPower: vi.fn(), runOnce: vi.fn(), stop: vi.fn(), invalidate: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (name: 'setPower' | 'runOnce' | 'stop') => ({
    useMutation: (o: { onSuccess: () => void }) => ({
      isPending: false,
      error: name === 'runOnce' ? state.runError : null,
      mutate: (i: unknown) => {
        calls[name](i)
        o.onSuccess()
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ pump: { invalidate: calls.invalidate } }),
      pump: {
        power: { useQuery: () => ({ data: state.power }) },
        get: { useQuery: () => ({ data: state.pump }) },
        setPower: mutation('setPower'),
        runOnce: mutation('runOnce'),
        stop: mutation('stop'),
      },
    },
  }
})

const idle = { on: false, level: 0, since: '2026-11-14T00:00:00Z', fault: null, remainingS: null }

beforeEach(() => {
  state.power = { power: 100, halMaxDuty: 100, effective: 100 }
  state.pump = idle
  state.runError = null
  for (const f of Object.values(calls)) f.mockReset()
})
afterEach(cleanup)

const slider = () => screen.getByRole('slider', { name: 'Pump power' }) as HTMLInputElement

describe('Settings → Pump', () => {
  it('keeps its anchor while loading', () => {
    state.power = undefined
    render(<PumpSection />)
    expect(document.getElementById('pump')).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('shows full power by default and says what it is for', () => {
    render(<PumpSection />)
    expect(slider().value).toBe('100')
    expect(screen.getByTestId('pump-power').textContent).toBe('100%')
    expect(screen.getByText(/how the stock Gardyn software runs it/)).toBeTruthy()
    expect(screen.getByText(/only if the unit restarts when the pump starts/)).toBeTruthy()
  })

  it('saves a new power when the slider lets go, and not for no change', () => {
    render(<PumpSection />)
    fireEvent.change(slider(), { target: { value: '70' } })
    expect(screen.getByTestId('pump-power').textContent).toBe('70%')
    fireEvent.keyUp(slider(), { key: 'ArrowLeft' })
    expect(calls.setPower).toHaveBeenCalledWith({ power: 70 })
    expect(calls.invalidate).toHaveBeenCalled()
  })

  it('says when hald caps it below the setting', () => {
    state.power = { power: 100, halMaxDuty: 30, effective: 30 }
    render(<PumpSection />)
    expect(screen.getByText(/caps it at 30% \(limits\.pump_max_duty in hal\.toml\)/)).toBeTruthy()
  })

  it('runs a bounded test through the guard, stops it, and shows a refusal', () => {
    render(<PumpSection />)
    fireEvent.click(screen.getByRole('button', { name: `Run for ${TEST_RUN_S} s` }))
    expect(calls.runOnce).toHaveBeenCalledWith({ durationS: TEST_RUN_S })
    cleanup()
    state.pump = { ...idle, on: true, level: 100, remainingS: 20 }
    render(<PumpSection />)
    expect(screen.getByText('running at 100%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(calls.stop).toHaveBeenCalled()
    cleanup()
    state.pump = idle
    state.runError = { message: 'refused: water level low (dry-run interlock)' }
    render(<PumpSection />)
    expect(screen.getByText('refused: water level low (dry-run interlock)')).toBeTruthy()
  })
})
