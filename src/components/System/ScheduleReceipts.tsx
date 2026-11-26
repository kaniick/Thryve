import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'

const WATER = {
  'completed': 'Completed',
  'stopped-early': 'Stopped early',
  'stopped-with-fault': 'Stopped with a fault',
  'start-observed': 'Start observed',
  'stop-observed': 'Stop observed',
  'retrying': 'Refused · retrying',
  'refused': 'Refused',
  'unconfirmed': 'Unconfirmed',
}

const LIGHT = {
  'matched': 'Target matched',
  'held': 'Overridden',
  'not-matched': 'Target not matched',
  'unconfirmed': 'Unconfirmed',
  'no-target': 'No scheduled target',
}

const percent = (level: number | null) => level === null ? '—' : `${Math.round(level * 10) / 10}%`

function formatter(timeZone: string) {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone })
  }
  catch {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' })
  }
}

export function ScheduleReceipts() {
  const query = trpc.schedules.receipts.useQuery(undefined, { refetchInterval: 30_000 })
  const activity = query.data
  const stamp = formatter(activity?.timezone ?? 'UTC')
  const time = (at: string) => {
    const date = Date.parse(at)
    return Number.isFinite(date) ? stamp.format(date) : at
  }

  return (
    <section aria-label="Schedule receipts" className="rounded-[14px] border border-line bg-surface px-[22px] py-[18px]">
      <h2 className="text-[15px] font-semibold">Schedule receipts</h2>
      <p className="mt-1 text-xs text-fg-3">What Core recorded and what the hardware daemon reported.</p>
      {!activity
        ? <p className="mt-3 text-sm text-fg-2">{query.isError ? 'Could not load schedule receipts.' : 'Loading schedule receipts…'}</p>
        : (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium">Watering</h3>
                <p className="mb-1 text-xs text-fg-3">Pump events confirm a start or stop, not water flow.</p>
                {!activity.watering.length
                  ? <p className="mt-2 text-xs text-fg-3">No scheduled attempts recorded.</p>
                  : (
                      <ul className="divide-y divide-line">
                        {activity.watering.slice(0, 6).map(r => (
                          <li key={r.key} className="py-2 text-xs">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                              <span>{r.name}</span>
                              <span className={cn(r.outcome === 'completed' ? 'text-pod-ok' : r.fault || r.outcome === 'refused' || r.outcome === 'stopped-early' ? 'text-pod-attention' : 'text-fg-2')}>{WATER[r.outcome]}</span>
                            </div>
                            <p className="mt-1 text-fg-3">{[time(r.at), r.durationS === null ? null : `${Math.round(r.durationS)}s recorded`, r.fault ?? r.reason].filter(Boolean).join(' · ')}</p>
                          </li>
                        ))}
                      </ul>
                    )}
              </div>
              <div>
                <h3 className="text-sm font-medium">Lighting</h3>
                <p className="mb-1 text-xs text-fg-3">Recent changes observed since Core started.</p>
                {!activity.lights.length
                  ? <p className="mt-2 text-xs text-fg-3">No light schedule observations yet.</p>
                  : (
                      <ul className="divide-y divide-line">
                        {activity.lights.slice(0, 6).map((r, i) => (
                          <li key={`${r.at}/${i}`} className="py-2 text-xs">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                              <span>{`Target ${percent(r.target)} · Reported ${percent(r.reported)}`}</span>
                              <span className={cn(r.outcome === 'matched' ? 'text-pod-ok' : r.outcome === 'not-matched' ? 'text-pod-attention' : 'text-fg-2')}>{LIGHT[r.outcome]}</span>
                            </div>
                            <p className="mt-1 text-fg-3">{[time(r.at), r.outcome === 'held' ? (r.source === 'manual' ? 'Manual control' : 'Autopilot') : null, r.fault].filter(Boolean).join(' · ')}</p>
                          </li>
                        ))}
                      </ul>
                    )}
              </div>
            </div>
          )}
    </section>
  )
}
