import { Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { SegmentedControl, Toggle } from '@/src/components/ds/forms'
import { SettingRow } from '@/src/components/ds/layout'
import { isDemo } from '@/src/demo/mode'
import { apiBase, trpc } from '@/src/utils/trpc'
import type { DatasetProgress } from '@/src/datasets/progress'

const WINDOWS = [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const
const mb = (b: number) => `${(b / 1_000_000).toFixed(b < 10_000_000 ? 1 : 0)} MB`
const working = (j: DatasetProgress | null) => j !== null && ['preparing', 'ready', 'downloading'].includes(j.state)

export function DatasetExport() {
  const [days, setDays] = useState<'7' | '30' | '90'>('30')
  const [images, setImages] = useState(true)
  const [to] = useState(() => new Date())
  const [job, setJob] = useState<DatasetProgress | null>(null)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const last = useRef<DatasetProgress | null>(null)
  const from = new Date(to.getTime() - Number(days) * 86_400_000).toISOString()
  const summary = trpc.datasets.summary.useQuery({ from, to: to.toISOString(), images }).data
  const endpoint = `${apiBase()}/api/datasets/jobs`
  const active = working(job)
  const id = job?.id
  const update = (next: DatasetProgress) => {
    last.current = next
    setJob(next)
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const pending = last.current
      if (pending?.state === 'preparing' || pending?.state === 'ready') {
        void fetch(`${endpoint}/${pending.id}`, { method: 'DELETE', keepalive: true }).catch(() => undefined)
      }
    }
  }, [endpoint])
  useEffect(() => {
    if (!id || !active) return
    let disposed = false
    let checking = false
    const poll = async () => {
      if (checking) return
      checking = true
      try {
        const response = await fetch(`${endpoint}/${id}`, { cache: 'no-store' })
        if (!response.ok && response.status !== 404) return
        const next: DatasetProgress = response.ok
          ? await response.json() as DatasetProgress
          : { id, state: 'error', analyses: 0, telemetry: 0, bytes: 0, error: 'This export is no longer available.' }
        if (!disposed && last.current?.id === id && working(last.current)) update(next)
      }
      catch {
        // Retry a failed status check.
      }
      finally {
        checking = false
      }
    }
    const timer = setInterval(() => void poll(), 750)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [active, endpoint, id])
  const prepare = async () => {
    setPosting(true)
    setError(null)
    try {
      const params = new URLSearchParams({ from, to: to.toISOString(), images: images ? '1' : '0' })
      const response = await fetch(`${endpoint}?${params}`, { method: 'POST' })
      const next = await response.json() as DatasetProgress
      if (!response.ok) throw new Error(next.error ?? 'Could not start the export.')
      if (mounted.current) update(next)
      else void fetch(`${endpoint}/${next.id}`, { method: 'DELETE', keepalive: true }).catch(() => undefined)
    }
    catch (e) {
      if (mounted.current) setError((e as Error).message)
    }
    finally {
      if (mounted.current) setPosting(false)
    }
  }
  const cancel = async () => {
    if (!job) return
    try {
      const response = await fetch(`${endpoint}/${job.id}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) throw new Error('Could not cancel the export. Try again.')
      if (mounted.current && last.current?.id === job.id && working(last.current)) update({ ...job, state: 'cancelled' })
    }
    catch (e) {
      if (mounted.current) setError((e as Error).message)
    }
  }
  return (
    <div className="flex flex-col">
      <p className="text-[13px] text-fg-2">Photos, every analyser&apos;s results, your pod labels, pods and sensor history as a tar.</p>
      <fieldset disabled={active || posting} className="min-w-0 border-0 p-0">
        <SettingRow label="Window"><SegmentedControl ariaLabel="Window" size="sm" options={WINDOWS} value={days} onChange={setDays} /></SettingRow>
        <SettingRow label="Include photos" sub="The bulk of the size" divider={false}><Toggle label="Include photos" on={images} onChange={setImages} /></SettingRow>
      </fieldset>
      {summary && <p className="mt-2 font-mono text-[12px] text-fg-3">{`${summary.captures} photos · ${summary.analyses} results · ${summary.labels} labels · ${summary.telemetry} readings${images ? ` · about ${mb(summary.imageBytes)}` : ''}`}</p>}
      {job && (
        <p role="status" className="mt-2 text-[13px] text-fg-2">
          {job.state === 'preparing' && `Preparing · ${job.analyses.toLocaleString()} analysis rows and ${job.telemetry.toLocaleString()} readings staged`}
          {job.state === 'ready' && 'Archive ready to download.'}
          {job.state === 'downloading' && `Download streaming · ${mb(job.bytes)} sent`}
          {job.state === 'sent' && 'Archive sent. Check your browser’s downloads.'}
          {job.state === 'cancelled' && 'Export cancelled.'}
        </p>
      )}
      {(error || job?.error) && <InlineError>{error ?? job?.error}</InlineError>}
      <div className="mt-3 flex flex-wrap gap-2">
        {isDemo()
          ? <p className="text-[13px] text-fg-2">Downloads need a real unit; the demo has no server.</p>
          : (
              <>
                {!active && <Button size="sm" icon={Download} disabled={posting} onClick={() => void prepare()}>{posting ? 'Starting…' : 'Prepare download'}</Button>}
                {job?.state === 'ready' && <a href={`${endpoint}/${job.id}/download`} download className="inline-flex underline" onClick={() => { last.current = { ...job, state: 'downloading' } }}>Download</a>}
                {active && <Button size="sm" onClick={() => void cancel()}>Cancel export</Button>}
              </>
            )}
      </div>
    </div>
  )
}
