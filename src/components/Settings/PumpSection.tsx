import { Play, Square } from 'lucide-react'
import { useState } from 'react'
import { Button, InlineError, StatusDot } from '@/src/components/ds/core'
import { Slider } from '@/src/components/ds/forms'
import { Row, Section } from '@/src/components/Settings/Section'
import { trpc } from '@/src/utils/trpc'

/** How long the test button runs the pump: long enough to see water reach the top of the tower. */
export const TEST_RUN_S = 30

/**
 * Settings → Pump: how hard the pump runs, and a short supervised test run.
 * The power saves on release, as the light's slider does; the test run goes
 * through the same guard as every run, so it's refused on a low tank or a
 * latched fault, and never runs dry (ADR-0009).
 */
export function PumpSection() {
  const utils = trpc.useUtils()
  const q = trpc.pump.power.useQuery()
  const pump = trpc.pump.get.useQuery(undefined, { refetchInterval: query => (query.state.data?.on ? 2000 : false) })
  // Not settings: that would reset the page's unsaved edits. The page leaves pumpPower out of its Save.
  const refresh = () => void utils.pump.invalidate()
  const setPower = trpc.pump.setPower.useMutation({ onSuccess: refresh })
  const test = trpc.pump.runOnce.useMutation({ onSuccess: refresh })
  const stop = trpc.pump.stop.useMutation({ onSuccess: refresh })
  const [draft, setDraft] = useState<number | null>(null)
  const title = 'Pump'
  const sub = 'How hard the pump pushes water up the tower. 100% is how the stock Gardyn software runs it. Each start ramps up over a moment, so the board isn\'t jolted.'
  const p = q.data
  if (!p) return <Section id="pump" title={title} sub={sub} />
  const value = draft ?? p.power
  const capped = p.halMaxDuty !== null && p.halMaxDuty < value
  const running = !!pump.data?.on
  const error = setPower.error?.message ?? test.error?.message ?? stop.error?.message ?? null
  return (
    <Section id="pump" title={title} sub={sub} right={running ? <StatusDot tone="ok" label={`running at ${pump.data?.level ?? value}%`} /> : undefined}>
      <Row
        label="Pump power"
        sub={capped
          ? `The hardware daemon caps it at ${p.halMaxDuty}% (limits.pump_max_duty in hal.toml).`
          : 'Lower it only if the unit restarts when the pump starts. Water not reaching the top wants it higher.'}
      >
        <div className="flex w-60 items-center gap-3">
          <Slider
            value={value}
            min={10}
            max={100}
            step={5}
            marks={[100]}
            label="Pump power"
            disabled={setPower.isPending}
            onChange={setDraft}
            onCommit={(v) => {
              setDraft(null)
              if (v !== p.power) setPower.mutate({ power: v })
            }}
          />
          <span className="w-11 text-right font-mono text-[13px]" data-testid="pump-power">{`${value}%`}</span>
        </div>
      </Row>
      <Row label="Test run" sub={`Runs the pump for ${TEST_RUN_S} s at this power, with water in the tank. Refused on a low tank or a fault, so it never runs dry.`}>
        {running
          ? <Button icon={Square} disabled={stop.isPending} onClick={() => stop.mutate()}>Stop</Button>
          : <Button icon={Play} disabled={test.isPending} onClick={() => test.mutate({ durationS: TEST_RUN_S })}>{`Run for ${TEST_RUN_S} s`}</Button>}
      </Row>
      {error && <InlineError className="mb-3">{error}</InlineError>}
    </Section>
  )
}
