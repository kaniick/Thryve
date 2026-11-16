import { BellRing } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SelectValue, TextField, Toggle } from '@/src/components/ds/forms'
import { describeNotifyRule } from '@/src/notify/describe'
import type { CompareOp, Condition, DayOfWeek } from '@/src/autopilot/types'
import type { NotificationRule, NotifyEvent, NotifyPriority, NotifyTrigger, QuietHours } from '@/src/notify/types'
import { NOTIFY_EVENTS, NOTIFY_PRIORITIES } from '@/src/notify/types'
import { trpc } from '@/src/utils/trpc'

const OPS: ReadonlyArray<{ value: CompareOp, label: string }> = [
  { value: '>', label: '>' }, { value: '>=', label: '≥' }, { value: '<', label: '<' }, { value: '<=', label: '≤' }, { value: '==', label: '=' }, { value: '!=', label: '≠' },
]
const PRIORITIES: ReadonlyArray<{ value: NotifyPriority, label: string }> = NOTIFY_PRIORITIES.map(p => ({ value: p, label: p }))
const DAYS: ReadonlyArray<{ value: string, label: string }> = [
  { value: 'monday', label: 'Mon' }, { value: 'tuesday', label: 'Tue' }, { value: 'wednesday', label: 'Wed' },
  { value: 'thursday', label: 'Thu' }, { value: 'friday', label: 'Fri' }, { value: 'saturday', label: 'Sat' }, { value: 'sunday', label: 'Sun' },
]

type TriggerKind = NotifyTrigger['kind']

export function RuleEditor({
  id, existing, starter, channels, events, signals, onClose,
}: {
  id: number | null
  existing?: NotificationRule
  starter?: Omit<NotificationRule, 'id' | 'createdAt' | 'updatedAt'>
  channels: Array<{ id: number, name: string, kind: string, enabled: boolean }>
  events: Array<{ event: NotifyEvent, label: string }>
  signals: Array<{ key: string, label: string, unit: string, group: string }>
  onClose: () => void
}) {
  const src = existing ?? starter
  const utils = trpc.useUtils()
  const create = trpc.notifications.createRule.useMutation()
  const update = trpc.notifications.updateRule.useMutation()
  const [name, setName] = useState(src?.name ?? '')
  const [enabled, setEnabled] = useState(src?.enabled ?? false)
  const [triggerKind, setTriggerKind] = useState<TriggerKind>(src?.trigger.kind ?? 'event')
  const [event, setEvent] = useState<NotifyEvent>(src?.trigger.kind === 'event' ? src.trigger.event : 'pump_fault')
  const [alertKind, setAlertKind] = useState(src?.trigger.kind === 'event' ? (src.trigger.alertKind ?? '') : '')
  const [signal, setSignal] = useState(
    src?.trigger.kind === 'threshold'
      ? src.trigger.signal
      : src?.trigger.kind === 'signalChange'
        ? src.trigger.signal
        : 'sensor.water_level_pct',
  )
  const [op, setOp] = useState<CompareOp>(src?.trigger.kind === 'threshold' ? src.trigger.op : '<')
  const [value, setValue] = useState(src?.trigger.kind === 'threshold' ? String(src.trigger.value) : '25')
  const [forMin, setForMin] = useState(src?.trigger.kind === 'threshold' ? String(src.trigger.forMin ?? 0) : '0')
  const [everyMin, setEveryMin] = useState(src?.trigger.kind === 'tick' ? String(src.trigger.everyMin) : '5')
  const [at, setAt] = useState(src?.trigger.kind === 'timeOfDay' ? src.trigger.at : '08:00')
  const [days, setDays] = useState<string[]>(src?.trigger.kind === 'timeOfDay' ? (src.trigger.days ?? []) : [])
  const [useWindow, setUseWindow] = useState(src?.conditions.kind === 'and' && src.conditions.conditions.some(c => c.kind === 'timeBetween'))
  const windowCond = src?.conditions.kind === 'and' ? src.conditions.conditions.find(c => c.kind === 'timeBetween') : undefined
  const [windowStart, setWindowStart] = useState(windowCond && windowCond.kind === 'timeBetween' ? windowCond.start : '08:00')
  const [windowEnd, setWindowEnd] = useState(windowCond && windowCond.kind === 'timeBetween' ? windowCond.end : '20:00')
  const [channelIds, setChannelIds] = useState<number[]>(src?.channelIds ?? [])
  const [title, setTitle] = useState(src?.titleTemplate ?? 'Thryve: {{eventLabel}}')
  const [message, setMessage] = useState(src?.messageTemplate ?? '{{alert.detail}}')
  const [priority, setPriority] = useState<NotifyPriority>(src?.priority ?? 'normal')
  const [cooldown, setCooldown] = useState(String(src?.cooldownMin ?? 60))
  const [quiet, setQuiet] = useState<QuietHours | null>(src?.quietHours ?? null)
  const [ignoreQuiet, setIgnoreQuiet] = useState(src?.ignoreQuietHours ?? false)
  const [repeat, setRepeat] = useState(src?.repeatWhileTrue ?? false)
  const saving = create.isPending || update.isPending
  const err = create.error?.message ?? update.error?.message

  const sensorOptions = useMemo(
    () => signals.filter(s => s.group === 'sensors' || s.key === 'light.level').map(s => ({ value: s.key, label: `${s.label} (${s.unit})` })),
    [signals],
  )
  const labels = new Map(signals.map(s => [s.key, s.label]))
  const signalLabel = (k: string) => labels.get(k) ?? k

  function trigger(): NotifyTrigger {
    if (triggerKind === 'event') return { kind: 'event', event, alertKind: alertKind.trim() || undefined }
    if (triggerKind === 'threshold') return { kind: 'threshold', signal, op, value: Number(value), forMin: Number(forMin) > 0 ? Number(forMin) : undefined }
    if (triggerKind === 'signalChange') return { kind: 'signalChange', signal }
    if (triggerKind === 'timeOfDay') return { kind: 'timeOfDay', at, days: days.length ? days as DayOfWeek[] : undefined }
    return { kind: 'tick', everyMin: Math.max(1, Number(everyMin) || 5) }
  }

  function conditions(): Condition {
    const parts: Condition[] = []
    if (useWindow) parts.push({ kind: 'timeBetween', start: windowStart, end: windowEnd })
    return parts.length ? { kind: 'and', conditions: parts } : { kind: 'and', conditions: [] }
  }

  const preview = describeNotifyRule({
    trigger: trigger(), conditions: conditions(), priority,
    cooldownMin: Number(cooldown) || 0, ignoreQuietHours: ignoreQuiet, repeatWhileTrue: repeat, channelIds,
  }, signalLabel)

  async function save() {
    const body = {
      name: name.trim() || 'Notification',
      enabled,
      trigger: trigger(),
      conditions: conditions(),
      channelIds,
      titleTemplate: title,
      messageTemplate: message,
      priority,
      cooldownMin: Math.max(0, Number(cooldown) || 0),
      quietHours: quiet,
      ignoreQuietHours: ignoreQuiet,
      repeatWhileTrue: repeat,
    }
    if (id === null) await create.mutateAsync(body)
    else await update.mutateAsync({ id, ...body })
    await utils.notifications.invalidate()
    onClose()
  }

  function toggleDay(d: string) {
    setDays(cur => cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d])
  }

  function toggleChannel(cid: number) {
    setChannelIds(cur => cur.includes(cid) ? cur.filter(x => x !== cid) : [...cur, cid])
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={id === null ? 'New rule' : 'Edit rule'}
      icon={BellRing}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TextField label="Name" value={name} onChange={setName} placeholder="Pump fault" className="flex-1" />
          <label className="flex items-center gap-2 text-[13px] text-fg-2">
            Enabled
            <Toggle label="Rule enabled" on={enabled} onChange={setEnabled} />
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-fg-2">When</span>
          <SelectValue
            label="Trigger"
            value={triggerKind}
            options={[
              { value: 'event', label: 'An event happens' },
              { value: 'threshold', label: 'A sensor crosses a threshold' },
              { value: 'signalChange', label: 'A reading changes' },
              { value: 'timeOfDay', label: 'At a time of day' },
              { value: 'tick', label: 'Every N minutes' },
            ]}
            onChange={setTriggerKind}
          />
        </div>

        {triggerKind === 'event' && (
          <div className="flex flex-col gap-2">
            <SelectValue label="Event" value={event} options={(events.length ? events : NOTIFY_EVENTS.map(e => ({ event: e, label: e }))).map(e => ({ value: e.event, label: e.label }))} onChange={setEvent} />
            {(event === 'alert_raised' || event === 'alert_cleared' || event === 'task_due') && (
              <TextField label="Alert kind (optional)" value={alertKind} onChange={setAlertKind} placeholder="e.g. water_low" />
            )}
          </div>
        )}

        {(triggerKind === 'threshold' || triggerKind === 'signalChange') && (
          <div className="flex flex-wrap items-end gap-2">
            <SelectValue label="Signal" value={signal} options={sensorOptions.length ? sensorOptions : [{ value: signal, label: signal }]} onChange={setSignal} />
            {triggerKind === 'threshold' && (
              <>
                <SelectValue label="Operator" value={op} options={OPS} onChange={setOp} />
                <TextField label="Value" value={value} onChange={setValue} />
                <TextField label="Sustained (min)" value={forMin} onChange={setForMin} hint="0 = fire as soon as it crosses" />
              </>
            )}
          </div>
        )}

        {triggerKind === 'timeOfDay' && (
          <div className="flex flex-col gap-2">
            <TextField label="Time" value={at} onChange={setAt} placeholder="08:00" />
            <div className="flex flex-wrap gap-1">
              {DAYS.map(d => (
                <button key={d.value} type="button" aria-pressed={days.includes(d.value)} onClick={() => toggleDay(d.value)} className={`rounded-ctl border px-2 py-1 text-[12px] ${days.includes(d.value) || days.length === 0 ? 'border-line bg-active text-fg' : 'border-line-2 text-fg-2'}`}>
                  {d.label}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-fg-3">Leave every day selected (or none) to run all week.</p>
          </div>
        )}

        {triggerKind === 'tick' && <TextField label="Every (minutes)" value={everyMin} onChange={setEveryMin} />}

        <label className="flex items-center gap-2 text-[13px] text-fg-2">
          <Toggle label="Only in a time window" on={useWindow} onChange={setUseWindow} />
          Only in a time window
        </label>
        {useWindow && (
          <div className="flex items-center gap-2">
            <input aria-label="Window start" type="time" className="rounded-ctl border border-line-2 bg-transparent px-2 py-1 font-mono text-[13px]" value={windowStart} onChange={e => setWindowStart(e.target.value)} />
            <span className="text-[13px] text-fg-3">to</span>
            <input aria-label="Window end" type="time" className="rounded-ctl border border-line-2 bg-transparent px-2 py-1 font-mono text-[13px]" value={windowEnd} onChange={e => setWindowEnd(e.target.value)} />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-fg-2">Notify</span>
          <p className="text-[12px] text-fg-3">Leave all unchecked to use every enabled channel.</p>
          <div className="flex flex-col gap-1">
            {channels.length === 0 && <p className="text-[13px] text-fg-2">No channels yet. Add one on the Notifications page first.</p>}
            {channels.map(ch => (
              <label key={ch.id} className="flex items-center gap-2 text-[13px] text-fg">
                <input type="checkbox" checked={channelIds.includes(ch.id)} onChange={() => toggleChannel(ch.id)} />
                {ch.name}
                {' '}
                <span className="text-fg-3 capitalize">
                  (
                  {ch.kind}
                  {ch.enabled ? '' : ', off'}
                  )
                </span>
              </label>
            ))}
          </div>
        </div>

        <TextField label="Title" value={title} onChange={setTitle} />
        <label className="flex flex-col gap-1 text-[13px] text-fg-2">
          Message
          <textarea aria-label="Message" className="min-h-[80px] rounded-ctl border border-line-2 bg-transparent px-2.5 py-1.5 font-mono text-[13px] text-fg" value={message} onChange={e => setMessage(e.target.value)} />
          <span className="text-fg-3">{`Variables: {{unit.name}}, {{eventLabel}}, {{alert.detail}}, {{sensor.water_level_pct}}, {{pod.slot}}, {{update.tag}}, {{time}}`}</span>
        </label>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-2">Priority</span>
            <SelectValue label="Priority" value={priority} options={PRIORITIES} onChange={setPriority} />
          </div>
          <TextField label="Cooldown (min)" value={cooldown} onChange={setCooldown} />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-fg-2">
          <Toggle label="Ignore quiet hours" on={ignoreQuiet} onChange={setIgnoreQuiet} />
          Ignore quiet hours
        </label>
        <label className="flex items-center gap-2 text-[13px] text-fg-2">
          <Toggle label="Repeat while true" on={repeat} onChange={setRepeat} />
          Repeat after cooldown while it still holds
        </label>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-fg-2">Rule quiet hours</span>
          <input aria-label="Rule quiet start" type="time" className="rounded-ctl border border-line-2 bg-transparent px-2 py-1 font-mono text-[13px]" value={quiet?.start ?? ''} onChange={e => setQuiet(e.target.value ? { start: e.target.value, end: quiet?.end || e.target.value } : null)} />
          <span className="text-[13px] text-fg-3">to</span>
          <input aria-label="Rule quiet end" type="time" className="rounded-ctl border border-line-2 bg-transparent px-2 py-1 font-mono text-[13px]" value={quiet?.end ?? ''} onChange={e => setQuiet(e.target.value && quiet ? { ...quiet, end: e.target.value } : quiet)} />
          {quiet && <Button size="sm" variant="ghost" onClick={() => setQuiet(null)}>Clear</Button>}
        </div>

        <p aria-label="Rule preview" className="rounded-ctl border border-line-2 bg-active px-3 py-2 text-[13px] leading-snug text-fg-2">{preview}</p>
        {err && <InlineError>{err}</InlineError>}
      </div>
    </Modal>
  )
}

