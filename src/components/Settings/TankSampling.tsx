import { InlineError } from '@/src/components/ds/core'
import { Stepper } from '@/src/components/ds/forms'
import { Row } from '@/src/components/Settings/Section'
import { trpc } from '@/src/utils/trpc'

/**
 * Settings → Tank: how the ranger is sampled, and how many of the last hour's
 * readings were trusted. Hidden on a hald too old to report the bounds.
 */
export function TankSampling() {
  const utils = trpc.useUtils()
  const info = trpc.system.info.useQuery()
  const trusted = trpc.tank.trustedShare.useQuery(undefined, { refetchInterval: 30_000 })
  const set = trpc.tank.setSampling.useMutation({
    onSuccess: () => {
      void utils.system.invalidate()
      void utils.tank.invalidate()
    },
  })
  const limits = info.data?.system?.limits
  if (!limits || limits.distanceSamples === undefined || limits.distanceSamplesMin === undefined || limits.distanceSamplesMax === undefined) return null
  const gapMin = limits.distanceGapMinMs ?? 30
  const gapMax = limits.distanceGapMaxMs ?? 250
  const toMin = limits.distanceTimeoutMinMs ?? 30
  const toMax = limits.distanceTimeoutMaxMs ?? 250
  const pct = trusted.data?.trustedPct
  const samples = trusted.data?.samples ?? 0
  return (
    <div data-testid="tank-sampling">
      <Row
        label="Sensor sampling"
        sub="How many pings the ranger takes, and how long it waits between them and for an echo. The unit holds these to the bounds in its hal.toml."
      >
        <div className="flex flex-col items-end gap-2">
          <Stepper
            label="Samples"
            value={limits.distanceSamples}
            min={limits.distanceSamplesMin}
            max={limits.distanceSamplesMax}
            step={1}
            format={v => `${v} pings`}
            disabled={set.isPending}
            onChange={v => set.mutate({ distanceSamples: v })}
          />
          {limits.distanceGapMs !== undefined && (
            <Stepper
              label="Gap between pings"
              value={limits.distanceGapMs}
              min={gapMin}
              max={gapMax}
              step={10}
              format={v => `${v} ms`}
              disabled={set.isPending}
              onChange={v => set.mutate({ distanceGapMs: v })}
            />
          )}
          {limits.distanceTimeoutMs !== undefined && (
            <Stepper
              label="Echo timeout"
              value={limits.distanceTimeoutMs}
              min={toMin}
              max={toMax}
              step={10}
              format={v => `${v} ms`}
              disabled={set.isPending}
              onChange={v => set.mutate({ distanceTimeoutMs: v })}
            />
          )}
        </div>
      </Row>
      <div className="border-t border-line py-3 text-xs text-fg-2" data-testid="tank-trusted">
        {pct === null || pct === undefined
          ? 'Readings trusted — last hour: nothing recorded yet.'
          : `Readings trusted ${pct}% last hour (${trusted.data?.trusted ?? 0} of ${samples}).`}
      </div>
      {set.error && <InlineError className="mb-3">{set.error.message}</InlineError>}
    </div>
  )
}
