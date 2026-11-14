import { X } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { cn } from '@/lib/utils'
import { LineChart } from '@/src/components/ds/charts'
import { ageDays } from '@/src/components/Grow/towerLayout'
import type { AppRouter } from '@/src/server/routers/app'
import type { Rect } from '@/src/vision/greenArea'
import { POD_STATES } from '@/src/vision/podState'
import type { PodRegions } from '@/src/vision/regions'

type Outputs = inferRouterOutputs<AppRouter>
type Result = Outputs['vision']['capture'][number]
export type Pod = Outputs['grow']['pods'][number]
export type Trend = Outputs['vision']['podTrends'][number]

const pct = (v: number) => `${Math.round(v * 100)}%`
const at = (n: number) => `${n * 100}%`
const TREND: Record<string, string> = { growing: 'Growing', stalled: 'Stalled', declining: 'Shrinking', unknown: 'Not enough photos for a trend' }
const STATUS: Record<string, string> = { empty: 'Empty', seeded: 'Seeded', growing: 'Growing', harvest: 'Ready to harvest', attention: 'Needs attention' }

/** A learned analyser's guess in words: the likeliest class, and the runner-up when it is close enough to matter. */
export function stateGuess(r: Pick<Result, 'value' | 'detail'>): string {
  const probs = r.detail?.probabilities
  if (probs && typeof probs === 'object') {
    const ranked = Object.entries(probs as Record<string, unknown>)
      .filter((e): e is [string, number] => typeof e[1] === 'number')
      .sort((a, b) => b[1] - a[1])
      .filter(([, p], i) => i === 0 || (i === 1 && p >= 0.1))
    if (ranked.length) return ranked.map(([s, p]) => `${s} ${pct(p)}`).join(' · ')
  }
  const name = typeof r.detail?.state === 'string' ? r.detail.state : (POD_STATES[r.value] ?? `class ${r.value}`)
  return typeof r.detail?.confidence === 'number' ? `${name} ${pct(r.detail.confidence)}` : name
}

/**
 * Where the card sits beside a pod's box: under it in the top half of the
 * frame and over it in the bottom half, lined up with whichever side keeps it
 * inside the photo.
 */
export function cardPlace(r: Rect) {
  const v = r.y + r.h / 2 < 0.5 ? { top: at(r.y + r.h) } : { bottom: at(1 - r.y) }
  const h = r.x + r.w / 2 < 0.5 ? { left: at(r.x) } : { right: at(1 - r.x - r.w) }
  return { ...v, ...h }
}

/** A column per analyser on this photo: its label, mark colour, and reading of the pod. */
export interface Reading { key: string, label: string, color: string, text: string }

/** Everything known about one pod on one photo: the pod record, each analyser's reading, and the trend. */
export function PodCard({ slot, box, pod, trend, readings, pinned, onClose }: {
  slot: number
  box: Rect
  pod: Pod | undefined
  trend: Trend | undefined
  readings: Reading[]
  pinned: boolean
  onClose: () => void
}) {
  const empty = !pod || pod.status === 'empty'
  const days = ageDays(pod?.plantedAt)
  const note = pod?.notes?.trim()
  const recent = trend?.recent ?? []
  return (
    <div
      role="dialog"
      aria-label={`Pod ${slot}`}
      data-testid="pod-card"
      className="pointer-events-auto absolute z-10 m-1 flex w-[230px] max-w-[calc(100%-8px)] flex-col gap-2 rounded-[10px] border border-line bg-surface/95 p-3 text-left shadow-lg backdrop-blur-sm"
      style={cardPlace(box)}
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-mono text-[10px] tracking-[0.06em] text-fg-3">{`POD ${slot}`}</span>
          <span className="truncate text-[15px] font-medium">{pod?.plant ?? 'Empty'}</span>
          <span className="text-xs text-fg-2">
            {[STATUS[pod?.status ?? 'empty'] ?? pod?.status, days !== null && `day ${Math.floor(days)}`].filter(Boolean).join(' · ')}
          </span>
        </div>
        {pinned && <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer border-0 bg-transparent p-0 text-fg-3 hover:text-fg"><X size={14} /></button>}
      </div>
      {readings.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          {readings.map(r => (
            <div key={r.key} className="flex items-center gap-2 text-xs">
              <span className="h-[3px] w-2 shrink-0 rounded-[2px]" style={{ background: r.color }} />
              <span className="min-w-0 flex-1 truncate text-fg-2" title={r.key}>{r.label}</span>
              <span className="font-mono text-fg">{r.text}</span>
            </div>
          ))}
          {empty && <span className="text-[11px] text-fg-3">Marked empty, so none of this counts as cover.</span>}
        </div>
      )}
      {!empty && trend && (
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          {recent.length > 1 && <LineChart series={[{ data: recent, color: 'var(--pod-ok)', width: 1.5 }]} min={0} height={28} />}
          <span className="text-xs text-fg-3">{`${TREND[trend.verdict] ?? trend.verdict}${trend.verdict === 'unknown' ? '' : ` over the last ${recent.length} photos`}`}</span>
        </div>
      )}
      {note && <p className="m-0 line-clamp-2 border-t border-line pt-2 text-[11px] text-fg-3" title={note}>{note}</p>}
    </div>
  )
}

/**
 * A target over each pod's box: hovering or focusing one shows its card,
 * clicking (or tapping) pins it and picks it for the chart below.
 */
export function PodHits({ boxes, shown, onHover, onPick }: {
  boxes: PodRegions
  shown: number | null
  onHover: (slot: number | null) => void
  onPick: (slot: number) => void
}) {
  return (
    <div className="absolute inset-0" data-testid="pod-hits">
      {Object.entries(boxes).map(([slot, r]) => {
        const s = Number(slot)
        return (
          <button
            key={slot}
            type="button"
            aria-label={`Pod ${slot} details`}
            aria-pressed={shown === s}
            className={cn('absolute cursor-pointer rounded-[3px] border-[1.5px] bg-transparent p-0 outline-none hover:border-fg focus-visible:border-fg', shown === s ? 'border-fg' : 'border-transparent')}
            style={{ left: at(r.x), top: at(r.y), width: at(r.w), height: at(r.h) }}
            onPointerEnter={() => onHover(s)}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(s)}
            onBlur={() => onHover(null)}
            onClick={() => onPick(s)}
          />
        )
      })}
    </div>
  )
}
