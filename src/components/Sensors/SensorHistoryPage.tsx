import { Link, useParams } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { SegmentedControl } from '@/src/components/ds/forms'
import { TimeChart } from '@/src/components/charts/TimeChart'
import { SensorId } from '@/src/hardware/contract'
import { formatReading, SENSOR_META } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'

const RANGES = [
  { value: '24', label: '24h' },
  { value: '168', label: '7d' },
  { value: '720', label: '30d' },
] as const
type Hours = typeof RANGES[number]['value']

export function SensorHistoryPage() {
  const raw = useParams({ from: '/sensors/$id' }).id
  const parsed = SensorId.safeParse(raw)
  const id = parsed.success ? parsed.data : null
  const [hours, setHours] = useState<Hours>('24')
  const latest = trpc.sensors.latest.useQuery()
  const hist = trpc.telemetry.history.useQuery(
    { sensor: id ?? 'air_temp', hours: Number(hours), maxPoints: 2000 },
    { enabled: !!id, refetchInterval: 60_000 },
  )
  const series = useMemo(() => {
    const pts = hist.data ?? []
    return [{ name: id ? SENSOR_META[id].label : 'Sensor', points: pts.map(p => ({ x: Date.parse(p.ts), y: p.value })) }]
  }, [id, hist.data])
  if (!id) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <InlineError>Unknown sensor.</InlineError>
        <Link to="/sensors" className="text-sm text-fg hover:underline">Back to Sensors</Link>
      </div>
    )
  }
  const reading = latest.data?.[id]
  const unit = reading?.unit ?? ''
  const href = (format: 'csv' | 'json', all = false) => {
    const to = new Date().toISOString()
    const from = new Date(Date.now() - Number(hours) * 3_600_000).toISOString()
    const params = new URLSearchParams({ from, to, format })
    if (!all) params.set('sensor', id)
    return `/api/telemetry/export?${params}`
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-5" data-testid="sensor-history">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link to="/sensors" className="text-xs text-fg-3 hover:underline">Sensors</Link>
          <h1 className="text-xl font-medium">{SENSOR_META[id].label}</h1>
          <p className="font-mono text-2xl" data-testid="sensor-history-value">{formatReading(reading)}</p>
        </div>
        <SegmentedControl size="sm" ariaLabel="Range" value={hours} options={[...RANGES]} onChange={v => setHours(v as Hours)} />
      </div>
      {hist.error && <InlineError>{hist.error.message}</InlineError>}
      <TimeChart
        series={series}
        height={220}
        fill
        label={SENSOR_META[id].label}
        formatY={v => `${Math.round(v * 10) / 10}${unit ? ` ${unit}` : ''}`}
        formatX={x => new Date(x).toLocaleString()}
        empty="Nothing recorded in this window."
      />
      <div className="flex flex-wrap gap-2" data-testid="sensor-export">
        <Button size="sm" onClick={() => { window.location.href = href('csv') }}>Download CSV</Button>
        <Button size="sm" onClick={() => { window.location.href = href('json') }}>Download JSON</Button>
        <Button size="sm" variant="ghost" onClick={() => { window.location.href = href('csv', true) }}>Export all sensors (CSV)</Button>
      </div>
    </div>
  )
}
