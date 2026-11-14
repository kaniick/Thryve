import { LineChart } from '@/src/components/ds/charts'
import { trpc } from '@/src/utils/trpc'
import type { Pod, Trend } from './PodCard'

const pct = (v: number) => `${Math.round(v * 100)}%`
const TREND: Record<string, string> = { growing: 'Growing', stalled: 'Stalled', declining: 'Shrinking' }
/** About a week of hourly photos. */
const LIMIT = 168
/** The shared scale's floor, so a pod at a few percent still shows its rise instead of a flat line. */
const FLOOR = 0.05

/**
 * Every planted pod's leaf cover from the primary analyser, one small chart
 * each on a shared scale, so the pods that are growing stand out from the
 * ones that aren't. Picking one charts it on its own.
 */
export function AllPods({ pods, trends, onPick }: { pods: Pod[], trends: Trend[], onPick: (slot: number) => void }) {
  const all = trpc.vision.allPodSeries.useQuery({ limit: LIMIT })
  const planted = pods.filter(p => p.status !== 'empty').sort((a, b) => a.slot - b.slot)
  const series = new Map((all.data ?? []).map(s => [s.slot, s.points.map(p => p.green)]))
  const max = Math.max(FLOOR, ...planted.flatMap(p => series.get(p.slot) ?? []))
  if (planted.length === 0) return <p className="text-[13px] text-fg-2">No pods are planted.</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5" data-testid="all-pods">
        {planted.map((p) => {
          const data = series.get(p.slot) ?? []
          const last = data.at(-1)
          const verdict = trends.find(t => t.slot === p.slot)?.verdict
          return (
            <button
              key={p.slot}
              type="button"
              aria-label={`Pod ${p.slot}, ${p.plant ?? 'unnamed'}`}
              className="flex min-w-0 cursor-pointer flex-col gap-1 rounded-[10px] border border-line bg-transparent p-2.5 text-left hover:border-line-2 hover:bg-active"
              onClick={() => onPick(p.slot)}
            >
              <span className="flex items-baseline gap-1.5 text-xs">
                <span className="font-mono text-[11px] text-fg-3">{p.slot}</span>
                <span className="min-w-0 flex-1 truncate text-fg">{p.plant ?? '—'}</span>
                <span className="font-mono text-fg">{last === undefined ? '—' : pct(last)}</span>
              </span>
              {data.length > 1
                ? <LineChart series={[{ data, color: 'var(--pod-ok)', width: 1.5 }]} min={0} max={max} height={32} />
                : <span className="flex h-8 items-center text-[11px] text-fg-3">No photos scored yet</span>}
              <span className="text-[11px] text-fg-3">{verdict && TREND[verdict] ? TREND[verdict] : 'No trend yet'}</span>
            </button>
          )
        })}
      </div>
      <span className="text-xs text-fg-3">{`Up to a week of photos per pod, all on one scale from 0 to ${pct(max)}. Empty pods are left out; pick one to chart it on its own.`}</span>
    </div>
  )
}
