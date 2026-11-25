import { Power, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/src/components/ds/core'
import { Alert, Modal } from '@/src/components/ds/feedback'
import { Row, Section } from './Section'

interface RecoveryStatus {
  configured: boolean
  busy: boolean
  version: string
  hostUptimeS: number
  coreUptimeS: number
  halOnline: boolean
  pump: 'unknown' | 'running' | 'off'
  dosing: boolean
  maxLagMs: number | null
  bootLog: boolean
}

type Action = 'restart-core' | 'reboot'
const titles: Record<Action, string> = { 'restart-core': 'Restart Core', 'reboot': 'Reboot Pi' }
const descriptions: Record<Action, string> = {
  'restart-core': 'Restarts Thryve’s web service and scheduler. The Pi and hardware daemon stay running.',
  'reboot': 'Restarts the entire Pi. The web UI, SSH and hardware control will go offline while it boots.',
}
const keyFormat = /^[a-f0-9]{64}$/

export function secureMaintenanceLocation(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'https:'
    || (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
}

function uptimeText(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) return 'Less than 1 min'
  const hours = Math.floor(minutes / 60)
  if (hours < 1) return `${minutes} min`
  const days = Math.floor(hours / 24)
  return days > 0 ? `${days} d ${hours % 24} h` : `${hours} h ${minutes % 60} min`
}

export function MaintenanceSection() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null)
  const [reload, setReload] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [choice, setChoice] = useState<Action | null>(null)
  const [key, setKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState<Action | null>(null)
  const secure = typeof window !== 'undefined' && secureMaintenanceLocation(window.location)

  useEffect(() => {
    if (import.meta.env.VITE_DEMO === '1') return
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 5000)
    let active = true
    void fetch('/api/maintenance/status', { signal: abort.signal, cache: 'no-store' }).then(async (r) => {
      if (!r.ok) throw new Error('Status unavailable')
      const body = await r.json() as RecoveryStatus
      if (typeof body.configured !== 'boolean' || typeof body.version !== 'string') throw new Error('Status unavailable')
      if (active) {
        setStatus(body)
        setUnavailable(false)
      }
    }).catch(() => {
      if (active) {
        setStatus(null)
        setUnavailable(true)
      }
    }).finally(() => clearTimeout(timer))
    return () => {
      active = false
      clearTimeout(timer)
      abort.abort()
    }
  }, [reload])

  const blocked = !status?.configured || !secure || status.busy || !status.halOnline || status.pump !== 'off' || status.dosing || !!queued || submitting
  const close = () => {
    if (submitting) return
    setChoice(null)
    setKey('')
    setError(null)
  }
  const refresh = () => {
    setQueued(null)
    setReload(n => n + 1)
  }
  const open = (action: Action) => {
    setChoice(action)
    setError(null)
    setKey('')
  }

  async function confirm() {
    const action = choice
    const secret = key.trim()
    if (!action || blocked || !keyFormat.test(secret)) return
    setKey('')
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch(`/api/maintenance/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status !== 202) {
        const out = await response.json().catch(() => ({})) as { error?: string }
        setError(typeof out.error === 'string' ? out.error : 'The request was not accepted.')
        return
      }
      setQueued(action)
      setChoice(null)
    }
    catch {
      // A disappearing service is not proof that the command ran.
      setError('Lost contact before confirmation. Check uptime before trying again.')
    }
    finally {
      setSubmitting(false)
    }
  }

  let hint: string | null = null
  if (import.meta.env.VITE_DEMO === '1' || unavailable) hint = 'Maintenance status is unavailable.'
  else if (!status) hint = 'Checking maintenance status…'
  else if (!status.configured) hint = 'Owner actions are off. Enable them on the Pi with sudo /usr/local/sbin/thryve-maintenance --provision.'
  else if (!secure) hint = 'Use your HTTPS address or open Thryve on localhost through an SSH tunnel to use the owner actions.'
  else if (status.busy) hint = 'An update, restore, or maintenance request is in progress.'
  else if (!status.halOnline || status.pump === 'unknown') hint = 'Waiting for HALD to report pump status.'
  else if (status.pump === 'running' || status.dosing) hint = 'Wait until watering and dosing finish.'

  return (
    <Section
      id="maintenance"
      title="Maintenance"
      sub="Check the unit and recover it when the UI is reachable. Try Restart Core first for a slow or stalled app."
      right={<Button size="sm" icon={RefreshCw} onClick={refresh}>Refresh status</Button>}
    >
      {status && (
        <>
          <Row label="Core" sub={status.version}>{uptimeText(status.coreUptimeS)}</Row>
          <Row label="Pi uptime">{uptimeText(status.hostUptimeS)}</Row>
          <Row label="Hardware daemon" sub={status.pump === 'unknown' ? 'Pump status unknown' : status.pump === 'running' ? 'Pump running' : status.dosing ? 'Dosing active' : 'Pump off'}>
            {status.halOnline ? 'Online' : 'Offline'}
          </Row>
          <Row label="Core event loop" sub="Longest delay in the last completed measurement window">
            {status.maxLagMs === null ? 'No sample yet' : `${status.maxLagMs} ms`}
          </Row>
          {status.bootLog && (
            <Row label="Boot diagnostics">
              <a href="/api/system/boot-log" download className="text-[13px] underline-offset-2 hover:underline">Download boot log</a>
            </Row>
          )}
        </>
      )}
      <Row label="Recovery actions" sub={hint ?? undefined}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={RotateCcw} disabled={blocked} onClick={() => open('restart-core')}>{titles['restart-core']}</Button>
          <Button size="sm" variant="danger" icon={Power} disabled={blocked} onClick={() => open('reboot')}>{titles.reboot}</Button>
        </div>
      </Row>
      {queued && (
        <div className="pb-3">
          <Alert>
            {titles[queued]}
            {' '}
            queued. Wait for the unit to return, then refresh status and check uptime.
          </Alert>
        </div>
      )}
      <Modal
        open={!!choice}
        onClose={close}
        title={choice ? titles[choice] : 'Maintenance'}
        footer={(
          <>
            <Button size="sm" onClick={close} disabled={submitting}>Cancel</Button>
            <Button size="sm" variant="danger" onClick={() => void confirm()} disabled={blocked || !keyFormat.test(key.trim())}>Confirm</Button>
          </>
        )}
      >
        {choice && <p className="text-sm text-fg-2">{descriptions[choice]}</p>}
        <label className="flex flex-col gap-1 text-sm">
          Owner maintenance key
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
            className="rounded-ctl border border-line bg-field px-3 py-2 text-fg"
          />
        </label>
        {error && <Alert tone="danger">{error}</Alert>}
      </Modal>
    </Section>
  )
}
