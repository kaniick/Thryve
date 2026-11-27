import { Link } from '@tanstack/react-router'
import { useState, type ChangeEvent } from 'react'
import { Button, Card, InlineError } from '@/src/components/ds/core'
import { ACTIVITY_KINDS, latestFirst, type ActivityEntry } from '@/src/garden/activity'
import { MAX_OBSERVER_FILE_BYTES, parseObserver } from '@/src/garden/observer'
import type { CameraEvidence } from '@/src/garden/plantHistory'
import { apiBase, trpc } from '@/src/utils/trpc'
import type { z } from 'zod'

export const GARDEN_TABS = [
  { value: 'activity', label: 'Activity' }, { value: 'plants', label: 'Plant history' },
  { value: 'readiness', label: 'Trip check' }, { value: 'vision', label: 'Vision review' },
] as const
export type GardenTab = typeof GARDEN_TABS[number]['value']
const CONTROL = 'rounded-ctl border border-line bg-surface px-2.5 py-1.5 text-sm text-fg'
const DASH = '—'
const dateTime = (ts: string) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const pct = (n: number) => Math.round(n * 100) + '%'

function JournalHeading({ title, subtitle }: { title: string, subtitle: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-[15px] font-medium">{title}</h2>
      <p className="text-[13px] leading-snug text-fg-2">{subtitle}</p>
    </div>
  )
}

export function GardenPage({ tab = 'activity', slot }: { tab?: GardenTab, slot?: number }) {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <header>
        <p className="font-mono text-xs text-fg-3">Garden /</p>
        <h1 className="text-2xl font-semibold">Garden journal</h1>
      </header>
      <nav aria-label="Garden journal" className="flex flex-wrap gap-2">
        {GARDEN_TABS.map(t => (
          <Link
            key={t.value}
            to="/garden"
            search={{ tab: t.value }}
            aria-current={tab === t.value ? 'page' : undefined}
            className={CONTROL + (tab === t.value ? ' border-meter font-semibold' : '')}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === 'activity' && <Activity />}
      {tab === 'plants' && <PlantJournal key={slot ?? 0} slot={slot} />}
      {tab === 'readiness' && <TripCheck />}
      {tab === 'vision' && <VisionQueue />}
    </div>
  )
}

function DownloadIncident({ checkedAt, days, entries, sampleCount }: { checkedAt: string, days: number, entries: ActivityEntry[], sampleCount: number }) {
  function download() {
    const report = { format: 'thryve-incident-v1', checkedAt, days, observerSamples: sampleCount, entries }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'thryve-incident-' + checkedAt.slice(0, 10) + '.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  return <Button onClick={download}>Download incident report</Button>
}

function Activity() {
  const [days, setDays] = useState(2)
  const [kind, setKind] = useState<string>('all')
  const [attention, setAttention] = useState(false)
  const [observer, setObserver] = useState<ReturnType<typeof parseObserver> | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [shown, setShown] = useState(50)
  const query = trpc.garden.activity.useQuery({ days }, { refetchInterval: 60_000 })
  const report = query.data
  const since = report ? Date.parse(report.checkedAt) - days * 86_400_000 : 0
  const until = report ? Date.parse(report.checkedAt) : 0
  const external = (observer?.entries ?? []).filter(e => Date.parse(e.at) >= since && Date.parse(e.at) <= until)
  const entries = [...report?.entries ?? [], ...external].sort(latestFirst)
  const filtered = entries.filter(e => (kind === 'all' || kind === e.kind) && (!attention || e.attention))
  async function importLogs(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length) return
    setImportError(null)
    if (files.length > 7 || files.some(f => f.size > MAX_OBSERVER_FILE_BYTES) || files.reduce((n, f) => n + f.size, 0) > 24 << 20) {
      setImportError('Choose up to seven daily logs, each under 8 MB and under 24 MB together.')
      return
    }
    setImporting(true)
    try {
      setObserver(parseObserver(await Promise.all(files.map(f => f.text()))))
    }
    catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not read observer logs.')
    }
    finally {
      setImporting(false)
    }
  }
  return (
    <Card className="gap-4">
      <JournalHeading title="Garden Activity" subtitle="Watering, light changes, tank warnings, camera results and restarts in one place." />
      <div className="flex flex-wrap items-center gap-3">
        <label>
          Window
          <select
            aria-label="Activity window"
            className={CONTROL}
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value))
              setShown(50)
            }}
          >
            <option value={1}>24 hours</option>
            <option value={2}>48 hours</option>
            <option value={7}>7 days</option>
          </select>
        </label>
        <label>
          Event
          <select
            aria-label="Event type"
            className={CONTROL}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value)
              setShown(50)
            }}
          >
            <option value="all">All</option>
            {ACTIVITY_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={attention} onChange={e => setAttention(e.target.checked)} />
          {' '}
          Needs attention
        </label>
        {report && <DownloadIncident checkedAt={report.checkedAt} days={days} entries={entries} sampleCount={observer?.sampleCount ?? 0} />}
      </div>
      <details className="rounded-ctl border border-line px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Add off-device observer logs</summary>
        <p className="mt-2 text-xs text-fg-2">Import daily JSONL files from the same tower. They are read by this browser, not uploaded. A probe failure does not prove the Pi froze.</p>
        <input aria-label="Observer logs" className="my-2 block w-full text-sm" type="file" accept=".jsonl,.ndjson" multiple disabled={importing} onChange={e => void importLogs(e)} />
        {importError && <InlineError>{importError}</InlineError>}
        {observer && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {observer.sampleCount}
            {' '}
            samples read ·
            {' '}
            {external.length}
            {' '}
            changes in this window
            {observer.ignored ? ' · ' + observer.ignored + ' lines skipped' : ''}
            <Button size="sm" onClick={() => setObserver(null)}>Clear logs</Button>
          </div>
        )}
      </details>
      {query.isLoading && <p>Loading activity…</p>}
      {query.error && <InlineError>{query.error.message}</InlineError>}
      {report && (filtered.length
        ? (
            <ol aria-label="Activity timeline" className="divide-y divide-line">
              {filtered.slice(0, shown).map(e => (
                <li key={e.key} className="grid gap-1 py-2.5 sm:grid-cols-[175px_1fr]">
                  <time dateTime={e.at} className="font-mono text-xs text-fg-2">{dateTime(e.at)}</time>
                  <div>
                    <p className={e.attention ? 'font-medium text-pod-attention' : 'font-medium'}>{e.title}</p>
                    {e.detail && <p className="text-sm text-fg-2">{e.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )
        : <p className="text-sm text-fg-2">No events match these filters.</p>)}
      {filtered.length > shown && <Button onClick={() => setShown(n => n + 50)}>Show more events</Button>}
    </Card>
  )
}

type Photo = z.infer<typeof CameraEvidence>
function PhotoTile({ photo, caption }: { photo: Photo, caption?: string }) {
  const [ratio, setRatio] = useState(4 / 3)
  const box = photo.box
  const url = apiBase() + photo.url
  const part = (fraction: number) => fraction * 100 + '%'
  return (
    <figure className="min-w-0">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="relative block overflow-hidden rounded-ctl bg-code"
        style={{ aspectRatio: box ? box.w / box.h * ratio : ratio }}
      >
        <img
          src={url}
          loading="lazy"
          alt={'Pod ' + photo.slot + ', ' + dateTime(photo.ts) + (box ? '' : ' (full camera still)')}
          className={box ? 'absolute max-w-none' : 'w-full'}
          style={box ? { width: part(1 / box.w), height: part(1 / box.h), left: part(-box.x / box.w), top: part(-box.y / box.h) } : undefined}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget
            if (naturalWidth && naturalHeight) setRatio(naturalWidth / naturalHeight)
          }}
        />
      </a>
      <figcaption className="mt-1 text-xs text-fg-2">
        {caption ? caption + ' · ' : ''}
        {dateTime(photo.ts)}
        {box ? '' : ' · full still'}
      </figcaption>
    </figure>
  )
}

const EVENT_LABELS = { sowed: 'Sowing logged', recorded: 'History begins', moved: 'Moved', note: 'Care note', harvested: 'Harvest logged', removed: 'Removed' } as const
function PlantJournal({ slot }: { slot?: number }) {
  const [pages, setPages] = useState<number[]>([])
  const [picked, setPicked] = useState<number | null>(null)
  const list = trpc.garden.plants.useQuery({ before: pages.at(-1) })
  const current = list.data?.active
  const activeId = picked ?? (slot === undefined ? current?.[0]?.id : current?.find(p => p.slot === slot)?.id)
  const detail = trpc.garden.plant.useQuery({ id: activeId ?? 0 }, { enabled: activeId !== undefined })
  const life = detail.data?.life
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(190px,255px)_minmax(0,1fr)]">
      <Card className="h-fit gap-3">
        <JournalHeading title="Plant history" subtitle="Changes follow the yCube." />
        {list.isLoading && <p>Loading plants…</p>}
        {list.error && <InlineError>{list.error.message}</InlineError>}
        <h3 className="text-xs font-medium uppercase text-fg-2">On the tower</h3>
        {current?.length === 0 && <p className="text-sm text-fg-2">No planted yCubes yet.</p>}
        {current?.map(p => (
          <Button key={p.id} aria-pressed={p.id === activeId} variant={p.id === activeId ? 'primary' : 'secondary'} onClick={() => setPicked(p.id)}>
            {p.plant}
            {' '}
            · Pod
            {' '}
            {p.slot}
          </Button>
        ))}
        <h3 className="mt-2 text-xs font-medium uppercase text-fg-2">Past plants</h3>
        {list.data?.archive.length === 0 && <p className="text-sm text-fg-2">No past plants on this page.</p>}
        {list.data?.archive.map(p => (
          <Button key={p.id} aria-pressed={p.id === activeId} variant={p.id === activeId ? 'primary' : 'secondary'} onClick={() => setPicked(p.id)}>
            {p.plant}
            {' '}
            ·
            {' '}
            {p.plantedAt?.slice(0, 10) ?? 'undated'}
          </Button>
        ))}
        <div className="flex flex-wrap gap-2">
          {!!pages.length && <Button size="sm" onClick={() => setPages(p => p.slice(0, -1))}>Previous</Button>}
          {!!list.data?.next && (
            <Button
              size="sm"
              onClick={() => {
                const next = list.data?.next
                if (next) setPages(p => [...p, next])
              }}
            >
              Older
            </Button>
          )}
        </div>
      </Card>
      <Card className="gap-4">
        <JournalHeading title={life?.plant ?? 'Plant details'} subtitle={life ? (life.slot ? 'Currently in pod ' + life.slot : 'Removed from the tower') + ' · Sown ' + (life.plantedAt?.slice(0, 10) ?? 'date unknown') : 'Pick a plant to see its sowing, photos, notes and harvests.'} />
        {detail.isLoading && <p>Loading plant history…</p>}
        {detail.error && <InlineError>{detail.error.message}</InlineError>}
        {detail.data && (
          <>
            <ol aria-label="Plant events" className="divide-y divide-line">
              {[...detail.data.events].reverse().map(e => (
                <li key={e.id} className="py-2 text-sm">
                  <span className="font-medium">
                    {EVENT_LABELS[e.kind]}
                    {e.fromSlot === null ? ' · Pod ' + e.slot : ' · Pod ' + e.fromSlot + ' to pod ' + e.slot}
                  </span>
                  <time className="ml-2 text-xs text-fg-2" dateTime={e.at}>{dateTime(e.at)}</time>
                  {e.note && <p className="text-fg-2">{e.note}</p>}
                </li>
              ))}
            </ol>
            <div>
              <h3 className="font-medium">Retained photos by slot</h3>
              <p className="text-xs text-fg-2">Only photos inside a recorded stay appear here. Crops use today’s pod boxes. Older stills may have been pruned.</p>
              {detail.data.visitsOmitted > 0 && <p className="text-xs text-fg-2">Showing the latest 30 stays.</p>}
            </div>
            {detail.data.visits.map(v => (
              <section key={v.slot + ':' + v.from} className="flex flex-col gap-2 border-t border-line pt-3">
                <h4 className="text-sm font-medium">
                  Pod
                  {v.slot}
                  {' '}
                  ·
                  {dateTime(v.from)}
                  {' '}
                  to
                  {v.to ? dateTime(v.to) : 'now'}
                </h4>
                {v.photos.length
                  ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{v.photos.map(photo => <PhotoTile key={photo.id} photo={photo} />)}</div>
                  : <p className="text-xs text-fg-2">No retained photos from this stay.</p>}
              </section>
            ))}
          </>
        )}
      </Card>
    </div>
  )
}

function TripCheck() {
  const [custom, setCustom] = useState('')
  const [until, setUntil] = useState<string | undefined>()
  const [badDate, setBadDate] = useState(false)
  const query = trpc.garden.readiness.useQuery({ until })
  const data = query.data
  return (
    <Card className="gap-4">
      <JournalHeading title="Ready to leave?" subtitle="A read-only check of the tank, watering, cameras and chores. The default window is 72 hours." />
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const date = new Date(custom)
          const span = date.getTime() - Date.now()
          if (!Number.isFinite(span) || span <= 0 || span > 7 * 86_400_000) {
            setBadDate(true)
            return
          }
          setBadDate(false)
          const iso = date.toISOString()
          if (until === iso) void query.refetch()
          else setUntil(iso)
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Return time (local)
          <input className={CONTROL} type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)} />
        </label>
        <Button type="submit">Check this trip</Button>
        <Button onClick={() => {
          if (until === undefined) void query.refetch()
          setUntil(undefined)
          setCustom('')
          setBadDate(false)
        }}
        >
          Next 72 hours
        </Button>
      </form>
      {badDate && <InlineError>Choose a return time in the next seven days.</InlineError>}
      {query.isLoading && <p>Checking the garden…</p>}
      {query.error && <InlineError>{query.error.message}</InlineError>}
      {data && (
        <>
          <div>
            <p role="status" className="font-semibold">{data.state === 'ready' ? 'No issues found in this check' : data.state === 'review' ? 'Review before leaving' : 'Not enough evidence to call it ready'}</p>
            <p className="text-xs text-fg-2">
              Checked
              {dateTime(data.checkedAt)}
              {' '}
              · through
              {dateTime(data.until)}
            </p>
          </div>
          {!!data.checks.length && <ul className="list-disc space-y-1 pl-5 text-sm">{data.checks.map(c => <li key={c}>{c}</li>)}</ul>}
          <dl className="grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
            <div>
              <dt className="font-medium">Tank runway</dt>
              <dd className="text-sm text-fg-2">
                {data.tank.levelPct !== null ? Math.round(data.tank.levelPct) + '% now · ' : ''}
                {data.tank.hoursToTarget !== null ? Math.round(data.tank.hoursToTarget) + ' h to ' + data.tank.targetPct + '%' : 'unknown'}
              </dd>
              <dd className="text-xs text-fg-2">{data.tank.reason}</dd>
            </div>
            <div>
              <dt className="font-medium">Last completed pump run</dt>
              <dd className="text-sm text-fg-2">{data.watering.lastCompleted ? dateTime(data.watering.lastCompleted.at) + ', ' + data.watering.lastCompleted.source + ' · ' + data.watering.lastCompleted.durationS + ' s' : DASH}</dd>
              <dd className="text-xs text-fg-2">A hardware report is not proof of water flow.</dd>
            </div>
            <div>
              <dt className="font-medium">Cameras</dt>
              <dd>
                <ul className="text-sm text-fg-2">
                  {data.cameras.map(c => (
                    <li key={c.camera}>
                      {c.camera}
                      {' '}
                      ·
                      {' '}
                      {c.state}
                      {c.lastPhotoAt && ' · ' + dateTime(c.lastPhotoAt)}
                    </li>
                  ))}
                </ul>
                {!data.cameras.length && <p className="text-sm text-fg-2">None reported by this unit.</p>}
              </dd>
            </div>
          </dl>
          <div>
            <h3 className="font-medium">Chores in this window</h3>
            {data.chores.length
              ? (
                  <ul className="divide-y divide-line">
                    {data.chores.map(c => (
                      <li key={c.title} className="py-2 text-sm">
                        <strong>{c.title}</strong>
                        {c.dueAt ? ' · ' + dateTime(c.dueAt) : ''}
                        <p className="text-fg-2">{c.reason}</p>
                      </li>
                    ))}
                  </ul>
                )
              : <p className="text-sm text-fg-2">No due or upcoming chores found.</p>}
          </div>
        </>
      )}
    </Card>
  )
}

function VisionQueue() {
  const [method, setMethod] = useState<{ analyzer: string, version: number }>()
  const query = trpc.garden.visionReview.useQuery(method ?? {})
  const data = query.data
  const key = (m: NonNullable<typeof method>) => m.analyzer + '@' + m.version
  return (
    <Card className="gap-4">
      <JournalHeading title="Local vision review" subtitle="Compare off-device green cover with the on-device baseline. A difference is not a plant health verdict." />
      <Link className="text-sm underline" to="/analysis" search={{ tab: 'methods' }}>Back to Analysis → Methods</Link>
      {query.isLoading && <p>Loading comparisons…</p>}
      {query.error && <InlineError>{query.error.message}</InlineError>}
      {data && (data.methods.length
        ? (
            <>
              <label className="text-sm">
                Off-device method
                <select className={CONTROL} value={data.selected ? key(data.selected) : ''} onChange={e => setMethod(data.methods.find(m => key(m) === e.target.value))}>
                  {!data.selected && <option value="">Choose a method</option>}
                  {data.methods.map(m => <option key={key(m)} value={key(m)}>{key(m)}</option>)}
                </select>
              </label>
              {data.items.length
                ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {data.items.map(item => (
                        <section key={item.slot} className="flex flex-col gap-2 rounded-ctl border border-line p-3">
                          <Link className="font-medium underline" to="/grow" search={{ pod: item.slot }}>
                            {item.plant}
                            {' '}
                            · Pod
                            {' '}
                            {item.slot}
                          </Link>
                          <p className="text-sm text-fg-2">
                            {'On device ' + pct(item.deviceCover) + ' · Off device ' + pct(item.workerCover)}
                          </p>
                          <div className="grid grid-cols-2 gap-2">
                            {item.before && <PhotoTile photo={item.before} caption="Earlier" />}
                            <PhotoTile photo={item.photo} caption="Comparison" />
                          </div>
                        </section>
                      ))}
                    </div>
                  )
                : <p className="text-sm text-fg-2">No recent, comparable photos differ by at least five percentage points.</p>}
            </>
          )
        : <p className="text-sm text-fg-2">Waiting for local worker results. See the off-device analyser setup in the Capture analysis guide.</p>)}
    </Card>
  )
}
