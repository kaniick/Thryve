import { useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { Stepper } from '@/src/components/ds/forms'
import type { DryGuard, Limits } from '@/src/hardware/contract'
import { trpc } from '@/src/utils/trpc'

const GUARD_WORDS: Record<DryGuard, string> = { level: 'tank level', current: 'pump current', both: 'tank level + pump current' }

/** "Dry-run guard: tank level + pump current (set on the unit)". */
export function dryGuardLine(mode: DryGuard): string {
  return `Dry-run guard: ${GUARD_WORDS[mode]} (set on the unit)`
}

/**
 * "Brown-out guard: stops below 10.8 V for 0.3 s (set on the unit)", or what it
 * watches instead; `null` from a hald too old to have it.
 */
export function brownoutLine(limits: Pick<Limits, 'pumpBrownoutV' | 'pumpBrownoutMs' | 'pumpBrownoutPi'>): string | null {
  const { pumpBrownoutV: v, pumpBrownoutMs: ms, pumpBrownoutPi: pi } = limits
  if (ms === undefined) return null
  const watch = v !== undefined
    ? `stops below ${v} V for ${fmtSeconds(ms)}${pi ? ' or on the Pi\'s under-voltage flag' : ''}`
    : pi ? `stops on the Pi's under-voltage flag for ${fmtSeconds(ms)}` : 'off'
  return `Brown-out guard: ${watch} (set on the unit)`
}

/** Milliseconds as seconds: 1200 → "1.2 s", 5000 → "5 s". */
export function fmtSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`
}

/**
 * Under the pump strip: which dry-run guard the unit runs, read-only (hal.toml
 * sets it, and pump safety outranks the app), and the one guard setting the app
 * may change, the grace before the pump-current check starts. The unit holds
 * that to the bounds in its hal.toml. A hald older than these shows nothing.
 */
export function DryGuardLine({ limits }: { limits: Limits | undefined }) {
  const utils = trpc.useUtils()
  const set = trpc.pump.setDryGrace.useMutation({ onSuccess: () => utils.system.invalidate() })
  const [draft, setDraft] = useState<number | null>(null)
  if (!limits?.pumpDryGuard) return null
  const { pumpDryGraceMs: grace, pumpDryGraceMinMs: min, pumpDryGraceMaxMs: max } = limits
  const brownout = brownoutLine(limits)
  return (
    <div data-testid="dry-guard" className="flex flex-col gap-2 border-b border-line px-[22px] py-2.5 text-[12px] text-fg-3 @min-[620px]:flex-row @min-[620px]:items-center @min-[620px]:justify-between">
      <span className="flex flex-col gap-0.5">
        <span>{dryGuardLine(limits.pumpDryGuard)}</span>
        {brownout && <span data-testid="brownout-guard">{brownout}</span>}
      </span>
      {grace !== undefined && min !== undefined && max !== undefined && (
        <span className="flex flex-wrap items-center gap-2">
          <span>{`Grace before the pump-current check (${fmtSeconds(min)}–${fmtSeconds(max)})`}</span>
          <Stepper label="Grace before the pump-current check" value={draft ?? grace} step={100} min={min} max={max} format={fmtSeconds} onChange={setDraft} />
          {draft !== null && draft !== grace && (
            <Button
              size="sm"
              variant="primary"
              disabled={set.isPending}
              onClick={() => set.mutate({ ms: draft }, { onSuccess: () => setDraft(null) })}
            >
              Save
            </Button>
          )}
        </span>
      )}
      {set.error && <InlineError>{set.error.message}</InlineError>}
    </div>
  )
}
