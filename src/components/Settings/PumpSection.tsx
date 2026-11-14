import { Play, Square } from 'lucide-react'
import { useState } from 'react'
import { Button, InlineError, StatusDot } from '@/src/components/ds/core'
import { Slider, Stepper, Toggle } from '@/src/components/ds/forms'
import { Row, Section } from '@/src/components/Settings/Section'
import { trpc } from '@/src/utils/trpc'

/** How long the test button runs the pump: long enough to see water reach the top of the tower. */
export const TEST_RUN_S = 30

const stepper = 'border-line bg-field [&>span]:min-w-16 [&>span]:font-medium [&>span]:text-[13px]'

/**
 * Settings → Pump: the pump's duty cycle, its soft start, and a short
 * supervised test run. Each control saves as it's set, as the light's slider
 * does. The test run goes through the same guard as every run, so it's refused
 * on a low tank or a latched fault, and never runs dry (ADR-0009).
 */
export function PumpSection() {
  const utils = trpc.useUtils()
  const q = trpc.pump.power.useQuery()
  const pump = trpc.pump.get.useQuery(undefined, { refetchInterval: query => (query.state.data?.on ? 2000 : false) })
  // Not settings: that would reset the page's unsaved edits. The page leaves the pump fields out of its Save.
  const refresh = () => void utils.pump.invalidate()
  const setPower = trpc.pump.setPower.useMutation({ onSuccess: refresh })
  const test = trpc.pump.runOnce.useMutation({ onSuccess: refresh })
  const stop = trpc.pump.stop.useMutation({ onSuccess: refresh })
  const [draft, setDraft] = useState<number | null>(null)
  const title = 'Pump'
  const sub = 'How hard the pump pushes water up the tower, as % duty cycle. Thryve starts at 30%. The stock Gardyn software runs it at 100%: if water doesn\'t reach the top, raise it.'
  const p = q.data
  if (!p) return <Section id="pump" title={title} sub={sub} />
  const max = p.halMaxDuty ?? 100
  const value = Math.min(draft ?? p.power, Math.max(max, 10))
  const capped = p.halMaxDuty !== null && p.halMaxDuty < p.power
  const running = !!pump.data?.on
  const busy = setPower.isPending
  const error = setPower.error?.message ?? test.error?.message ?? stop.error?.message ?? null
  return (
    <Section id="pump" title={title} sub={sub} right={running ? <StatusDot tone="ok" label={`running at ${pump.data?.level ?? value}%`} /> : undefined}>
      <Row
        label="Duty cycle"
        sub={capped
          ? `The hardware daemon caps it at ${p.halMaxDuty}% (limits.pump_max_duty in hal.toml).`
          : `Up to ${max}%. If the unit restarts when the pump starts, turn on or lengthen the soft start, or lower this.`}
      >
        <div className="flex w-60 items-center gap-3">
          <Slider
            value={value}
            min={10}
            max={Math.max(max, 10)}
            step={5}
            marks={[30, 100].filter(m => m <= max)}
            label="Pump duty cycle"
            disabled={busy}
            onChange={setDraft}
            onCommit={(v) => {
              setDraft(null)
              if (v !== p.power) setPower.mutate({ power: v })
            }}
          />
          <span className="w-11 text-right font-mono text-[13px]" data-testid="pump-power">{`${value}%`}</span>
        </div>
      </Row>
      <Row label="Soft start" sub={p.softStart ? 'Each start ramps up gently, so the pump\'s inrush doesn\'t brown out the board. A stop is always immediate.' : 'Off: the pump switches straight on, as the stock software does.'}>
        <Toggle label="Soft start" on={p.softStart} disabled={busy} onChange={v => setPower.mutate({ softStart: v })} />
      </Row>
      {p.softStart && (
        <Row label="Ramp time" sub="How long a start takes to reach full duty">
          <Stepper label="Ramp time" className={stepper} value={p.softStartMs} min={500} max={10_000} step={500} disabled={busy} format={v => `${(v / 1000).toFixed(1)} s`} onChange={v => setPower.mutate({ softStartMs: v })} />
        </Row>
      )}
      <Row label="Test run" sub={`Runs the pump for ${TEST_RUN_S} s at this duty, with water in the tank. Refused on a low tank or a fault, so it never runs dry.`}>
        {running
          ? <Button icon={Square} disabled={stop.isPending} onClick={() => stop.mutate()}>Stop</Button>
          : <Button icon={Play} disabled={test.isPending} onClick={() => test.mutate({ durationS: TEST_RUN_S })}>{`Run for ${TEST_RUN_S} s`}</Button>}
      </Row>
      {error && <InlineError className="mb-3">{error}</InlineError>}
    </Section>
  )
}
