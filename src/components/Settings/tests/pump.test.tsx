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
const base = { power: 30, halMaxDuty: 100, effective: 30, softStart: true, softStartMs: 1500 }

beforeEach(() => {
  state.power = base
  state.pump = idle
  state.runError = null
  for (const f of Object.values(calls)) f.mockReset()
})
afterEach(cleanup)

const slider = () => screen.getByRole('slider', { name: 'Pump duty cycle' }) as HTMLInputElement

describe('Settings → Pump', () => {
  it('keeps its anchor while loading', () => {
    state.power = undefined
    render(<PumpSection />)
    expect(document.getElementById('pump')).toBeTruthy()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('starts at 30 %, goes up to the HAL cap, and says what stock runs', () => {
    render(<PumpSection />)
    expect(slider().value).toBe('30')
    expect(slider().max).toBe('100')
    expect(screen.getByTestId('pump-power').textContent).toBe('30%')
    expect(screen.getByText(/stock Gardyn software runs it at 100%/)).toBeTruthy()
    expect(screen.getByText(/Up to 100%\. If the unit restarts when the pump starts/)).toBeTruthy()
  })

  it('saves a new duty when the slider lets go', () => {
    render(<PumpSection />)
    fireEvent.change(slider(), { target: { value: '100' } })
    expect(screen.getByTestId('pump-power').textContent).toBe('100%')
    fireEvent.keyUp(slider(), { key: 'ArrowRight' })
    expect(calls.setPower).toHaveBeenCalledWith({ power: 100 })
    expect(calls.invalidate).toHaveBeenCalled()
  })

  it('says when hald caps it below the setting, and stops the slider at the cap', () => {
    state.power = { ...base, power: 60, halMaxDuty: 30, effective: 30 }
    render(<PumpSection />)
    expect(screen.getByText(/caps it at 30% \(limits\.pump_max_duty in hal\.toml\)/)).toBeTruthy()
    expect(slider().max).toBe('30')
  })

  it('turns the soft start off and on, and lengthens its ramp', () => {
    render(<PumpSection />)
    const toggle = screen.getByRole('switch', { name: 'Soft start' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('1.5 s')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Increase Ramp time' }))
    expect(calls.setPower).toHaveBeenCalledWith({ softStartMs: 2000 })
    fireEvent.click(toggle)
    expect(calls.setPower).toHaveBeenCalledWith({ softStart: false })
    cleanup()
    state.power = { ...base, softStart: false }
    render(<PumpSection />)
    expect(screen.getByText(/switches straight on/)).toBeTruthy()
    expect(screen.queryByText('Ramp time')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Soft start' }))
    expect(calls.setPower).toHaveBeenCalledWith({ softStart: true })
  })

  it('runs a bounded test through the guard, stops it, and shows a refusal', () => {
    render(<PumpSection />)
    fireEvent.click(screen.getByRole('button', { name: `Run for ${TEST_RUN_S} s` }))
    expect(calls.runOnce).toHaveBeenCalledWith({ durationS: TEST_RUN_S })
    cleanup()
    state.pump = { ...idle, on: true, level: 30, remainingS: 20 }
    render(<PumpSection />)
    expect(screen.getByText('running at 30%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(calls.stop).toHaveBeenCalled()
    cleanup()
    state.pump = idle
    state.runError = { message: 'refused: water level low (dry-run interlock)' }
    render(<PumpSection />)
    expect(screen.getByText('refused: water level low (dry-run interlock)')).toBeTruthy()
  })
})
