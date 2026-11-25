import { ArrowRightLeft } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { trpc } from '@/src/utils/trpc'
import { podMoveOptions, type MovePod, type MoveSlot } from '@/src/plants/plannerMoves'
import type { Plant } from '@/src/plants/catalog'
import type { PlanOverrides } from '@/src/plants/planner'

const describe = (p: MovePod) => `Pod ${p.slot} · ${p.status === 'empty' ? 'Empty' : p.plant ?? 'Unnamed plant'}`

export function PodReview({ pods, slots, plants, reserved, overrides }: {
  pods: MovePod[]
  slots: MoveSlot[]
  plants: Plant[]
  reserved: ReadonlySet<number>
  overrides?: PlanOverrides
}) {
  const utils = trpc.useUtils()
  const slotSet = new Set(slots.map(s => s.slot))
  const shown = pods.filter(p => slotSet.has(p.slot))
  const planted = shown.filter(p => p.status !== 'empty')
  const camera = trpc.vision.seenEmpty.useQuery(undefined, { enabled: planted.some(p => p.status !== 'seeded') })
  const [from, setFrom] = useState(0)
  const [to, setTo] = useState(0)
  const [confirm, setConfirm] = useState<{ source: string, destination: string } | null>(null)
  const [recorded, setRecorded] = useState<string | null>(null)
  const swap = trpc.grow.swapPods.useMutation({
    onSuccess: () => {
      setRecorded(`Pod records updated for ${from} and ${to}.`)
      setConfirm(null)
      setFrom(0)
      setTo(0)
      void utils.grow.invalidate()
      void utils.planner.invalidate()
      void utils.vision.seenEmpty.invalidate()
    },
  })
  if (!planted.length || shown.length < 2) return null
  const source = planted.find(p => p.slot === from)
  const destination = shown.find(p => p.slot === to && to !== from && !reserved.has(to))
  const valid = !!source && !!destination && (!confirm || (confirm.source === describe(source) && confirm.destination === describe(destination)))
  const kind = destination?.status === 'empty' ? 'move' : 'swap'
  const suspects = (camera.data ?? []).filter(h => planted.some(p => p.slot === h.slot && p.status !== 'seeded'))
  const suggestions = overrides?.replant ? [] : podMoveOptions(shown, slots, plants, reserved, overrides)
  const input = 'mt-1 min-w-0 rounded-[var(--radius-ctl)] border border-line bg-surface px-2 py-1.5 text-sm text-fg'
  const selectPair = (a: number, b: number) => {
    setFrom(a)
    setTo(b)
    setRecorded(null)
    swap.reset()
  }
  return (
    <Card>
      <CardHeader title="Planted pods" subtitle="Review camera hints and record physical moves" icon={ArrowRightLeft} />
      {suspects.length > 0 && (
        <div role="status" aria-label="Camera review" className="mt-3 rounded-[var(--radius-ctl)] border border-line p-3 text-[13px]">
          <p className="text-fg">{`Camera sees ${suspects.length === 1 ? 'pod' : 'pods'} ${suspects.map(h => h.slot).join(', ')} as empty.`}</p>
          <p className="mt-1 text-fg-2">Check the photos and the tower before editing a record. Nothing was changed.</p>
          <a className="mt-1 inline-block text-fg underline" href="/analysis?tab=teach">Review in Analysis</a>
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="mt-3 text-[13px]">
          <p className="font-medium">Optional light moves</p>
          <ul className="mt-1 grid gap-2">
            {suggestions.map(m => (
              <li key={m.from} className="flex flex-wrap items-center justify-between gap-2 text-fg-2">
                <span>{m.swap ? `Swap ${m.plant} in pod ${m.from} with ${m.swap} in ${m.to} for ${m.zone} light.` : `Move ${m.plant} from pod ${m.from} to open pod ${m.to} for ${m.zone} light.`}</span>
                <Button size="sm" aria-label={`Use suggestion for pod ${m.from}`} disabled={swap.isPending} onClick={() => selectPair(m.from, m.to)}>Review suggestion</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 basis-40 text-xs text-fg-2">
          From planted pod
          <select className={input} value={from} onChange={e => selectPair(Number(e.currentTarget.value), 0)}>
            <option value={0}>Choose a pod</option>
            {planted.map(p => <option key={p.slot} value={p.slot}>{describe(p)}</option>)}
          </select>
        </label>
        <label className="grid min-w-0 flex-1 basis-40 text-xs text-fg-2">
          To pod
          <select className={input} value={to} disabled={!source} onChange={e => selectPair(from, Number(e.currentTarget.value))}>
            <option value={0}>Choose a pod</option>
            {shown.filter(p => p.slot !== from && !reserved.has(p.slot)).map(p => <option key={p.slot} value={p.slot}>{describe(p)}</option>)}
          </select>
        </label>
        <Button size="sm" disabled={!valid || swap.isPending} onClick={() => { if (source && destination) setConfirm({ source: describe(source), destination: describe(destination) }) }}>
          {`Review ${kind}`}
        </Button>
      </div>
      {recorded && <p className="mt-2 text-xs text-fg-2" role="status">{recorded}</p>}
      {confirm && (
        <Modal
          open
          title={`Record pod ${kind}?`}
          onClose={() => { if (!swap.isPending) setConfirm(null) }}
          footer={(
            <div className="flex justify-end gap-2">
              <Button disabled={swap.isPending} onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="primary" disabled={!valid || swap.isPending} onClick={() => { if (valid) swap.mutate({ a: from, b: to }) }}>{`Record ${kind}`}</Button>
            </div>
          )}
        >
          <p>{`${confirm.source} → ${confirm.destination}`}</p>
          <p className="mt-2 text-fg-2">Move the yCubes on the tower first. This only updates the pod records. Camera history stays with each slot.</p>
          {!valid && <InlineError>The records changed. Cancel and review the pair again.</InlineError>}
          {swap.error && <InlineError>{swap.error.message}</InlineError>}
        </Modal>
      )}
    </Card>
  )
}
