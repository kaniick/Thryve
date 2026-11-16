import { BellRing } from 'lucide-react'
import { useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SelectValue, TextField, Toggle } from '@/src/components/ds/forms'
import type { ChannelKind } from '@/src/notify/types'
import { trpc } from '@/src/utils/trpc'

const KINDS: ReadonlyArray<{ value: ChannelKind, label: string }> = [
  { value: 'pushover', label: 'Pushover' },
  { value: 'pushbullet', label: 'Pushbullet' },
  { value: 'apprise', label: 'Apprise API' },
]

const SOUNDS = ['', 'pushover', 'bike', 'bugle', 'cashregister', 'classical', 'cosmic', 'falling', 'gamelan', 'incoming', 'intermission', 'magic', 'mechanical', 'pianobar', 'siren', 'spacealarm', 'tugboat', 'alien', 'climb', 'persistent', 'echo', 'updown', 'vibrate', 'none']

interface PublicChannel {
  id: number
  name: string
  kind: ChannelKind
  enabled: boolean
  config: Record<string, unknown>
  secrets: {
    userKey: string | null
    hasUserKey: boolean
    appToken: string | null
    hasAppToken: boolean
    accessToken: string | null
    hasAccessToken: boolean
    apiKey: string | null
    hasApiKey: boolean
    urls: number
    hasUrls: boolean
  }
}

export function ChannelEditor({ id, existing, onClose }: { id: number | null, existing?: PublicChannel, onClose: () => void }) {
  const utils = trpc.useUtils()
  const create = trpc.notifications.createChannel.useMutation()
  const update = trpc.notifications.updateChannel.useMutation()
  const [name, setName] = useState(existing?.name ?? '')
  const [kind, setKind] = useState<ChannelKind>(existing?.kind ?? 'pushover')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [device, setDevice] = useState(str(existing?.config.device))
  const [sound, setSound] = useState(str(existing?.config.sound))
  const [retry, setRetry] = useState(num(existing?.config.retry, 60))
  const [expire, setExpire] = useState(num(existing?.config.expire, 600))
  const [deviceIden, setDeviceIden] = useState(str(existing?.config.deviceIden))
  const [channelTag, setChannelTag] = useState(str(existing?.config.channelTag))
  const [serverUrl, setServerUrl] = useState(str(existing?.config.serverUrl))
  const [configKey, setConfigKey] = useState(str(existing?.config.configKey))
  const [tag, setTag] = useState(str(existing?.config.tag))
  const [userKey, setUserKey] = useState('')
  const [appToken, setAppToken] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [urls, setUrls] = useState('')
  const saving = create.isPending || update.isPending
  const err = create.error?.message ?? update.error?.message

  const configFor = () => {
    if (kind === 'pushover') return { device: device || undefined, sound: sound || undefined, retry, expire }
    if (kind === 'pushbullet') return { deviceIden: deviceIden || undefined, channelTag: channelTag || undefined }
    return { serverUrl, configKey: configKey || undefined, tag: tag || undefined }
  }

  const secretsFor = () => {
    const s: Record<string, unknown> = {}
    if (kind === 'pushover') {
      if (userKey) s.userKey = userKey
      if (appToken) s.appToken = appToken
    }
    else if (kind === 'pushbullet') {
      if (accessToken) s.accessToken = accessToken
    }
    else {
      if (apiKey) s.apiKey = apiKey
      if (urls.trim()) s.urls = urls.split(/[\n,]+/).map(x => x.trim()).filter(Boolean)
    }
    return s
  }

  async function save() {
    const body = { name: name.trim() || kindLabel(kind), kind, enabled, config: configFor(), secrets: secretsFor() }
    if (id === null) await create.mutateAsync(body)
    else await update.mutateAsync({ id, ...body })
    await utils.notifications.invalidate()
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={id === null ? 'Add channel' : 'Edit channel'}
      icon={BellRing}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <TextField label="Name" value={name} onChange={setName} placeholder="Phone" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SelectValue label="Service" value={kind} options={KINDS} onChange={setKind} />
          <label className="flex items-center gap-2 text-[13px] text-fg-2">
            Enabled
            <Toggle label="Channel enabled" on={enabled} onChange={setEnabled} />
          </label>
        </div>

        {kind === 'pushover' && (
          <>
            <p className="text-[13px] text-fg-2">Create an application at pushover.net/apps for the API token, and use your user key from the Pushover dashboard. Both stay on the unit.</p>
            <TextField label="User key" type="password" value={userKey} onChange={setUserKey} placeholder={existing?.secrets.hasUserKey ? (existing.secrets.userKey ?? '••••') : 'Your user key'} />
            <TextField label="Application API token" type="password" value={appToken} onChange={setAppToken} placeholder={existing?.secrets.hasAppToken ? (existing.secrets.appToken ?? '••••') : 'Application token'} />
            <TextField label="Device (optional)" value={device} onChange={setDevice} placeholder="Leave blank for all devices" />
            <div className="flex flex-col gap-1">
              <span className="text-[13px] text-fg-2">Sound</span>
              <SelectValue label="Sound" value={sound} options={SOUNDS.map(s => ({ value: s, label: s || 'Default' }))} onChange={setSound} />
            </div>
            <p className="text-[13px] text-fg-2">Emergency priority (used when a rule is set to emergency) retries every N seconds until the message expires.</p>
            <TextField label="Emergency retry (seconds)" value={String(retry)} onChange={v => setRetry(Number(v) || 60)} />
            <TextField label="Emergency expire (seconds)" value={String(expire)} onChange={v => setExpire(Number(v) || 600)} />
          </>
        )}

        {kind === 'pushbullet' && (
          <>
            <p className="text-[13px] text-fg-2">Create an access token in Pushbullet settings. It stays on the unit and is never returned in full.</p>
            <TextField label="Access token" type="password" value={accessToken} onChange={setAccessToken} placeholder={existing?.secrets.hasAccessToken ? (existing.secrets.accessToken ?? '••••') : 'Access token'} />
            <TextField label="Device iden (optional)" value={deviceIden} onChange={setDeviceIden} />
            <TextField label="Channel tag (optional)" value={channelTag} onChange={setChannelTag} />
          </>
        )}

        {kind === 'apprise' && (
          <>
            <p className="text-[13px] text-fg-2">
              Thryve talks to an Apprise API server you run (for example caronc/apprise-api), over HTTP. The Python Apprise package is not installed on the unit.
            </p>
            <TextField label="Apprise API URL" value={serverUrl} onChange={setServerUrl} placeholder="http://apprise.local:8000" />
            <TextField label="Config key (optional)" value={configKey} onChange={setConfigKey} hint="POST /notify/&#123;key&#125; when set" />
            <TextField label="Tag (optional)" value={tag} onChange={setTag} />
            <TextField label="API key (optional)" type="password" value={apiKey} onChange={setApiKey} placeholder={existing?.secrets.hasApiKey ? (existing.secrets.apiKey ?? '••••') : 'If the API is locked down'} />
            <label className="flex flex-col gap-1 text-[13px] text-fg-2">
              Notification URLs (optional)
              <textarea className="min-h-[80px] rounded-ctl border border-line-2 bg-transparent px-2.5 py-1.5 font-mono text-[13px] text-fg" value={urls} onChange={e => setUrls(e.target.value)} placeholder={existing?.secrets.hasUrls ? `${existing.secrets.urls} URL(s) saved — paste to replace` : 'pushover://token@user\nmailto://…'} />
              <span className="text-fg-3">One per line. These often contain tokens, so they are stored as secrets.</span>
            </label>
          </>
        )}
        {err && <InlineError>{err}</InlineError>}
      </div>
    </Modal>
  )
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}
function kindLabel(k: ChannelKind): string {
  return KINDS.find(x => x.value === k)?.label ?? k
}
