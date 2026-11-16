import { BellRing, Plus } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button, InlineError, SectionLabel } from '@/src/components/ds/core'
import { Toggle } from '@/src/components/ds/forms'
import { describeNotifyRule } from '@/src/notify/describe'
import { EVENT_LABELS } from '@/src/notify/events'
import type { NotificationRule } from '@/src/notify/types'
import { trpc } from '@/src/utils/trpc'
import { ChannelEditor } from './ChannelEditor'
import { RuleEditor } from './RuleEditor'

interface ChannelDraft { id: number | null }
interface RuleDraft { id: number | null, starter?: Omit<NotificationRule, 'id' | 'createdAt' | 'updatedAt'> }

const OUTCOME: Record<string, string> = {
  sent: 'Sent',
  skipped: 'Skipped',
  quiet: 'Quiet hours',
  cooldown: 'Cooldown',
  dedup: 'Already sent',
  error: 'Failed',
  disabled: 'Off',
}

export function NotificationsPage() {
  const utils = trpc.useUtils()
  const status = trpc.notifications.status.useQuery()
  const channels = trpc.notifications.channels.useQuery()
  const rules = trpc.notifications.rules.useQuery()
  const runs = trpc.notifications.runs.useQuery({ limit: 50 })
  const starters = trpc.notifications.starters.useQuery()
  const catalog = trpc.notifications.catalog.useQuery()
  const refresh = { onSuccess: () => void utils.notifications.invalidate() }
  const setGlobal = trpc.notifications.setGlobal.useMutation(refresh)
  const setQuiet = trpc.notifications.setQuietHours.useMutation(refresh)
  const removeChannel = trpc.notifications.removeChannel.useMutation(refresh)
  const removeRule = trpc.notifications.removeRule.useMutation(refresh)
  const updateRule = trpc.notifications.updateRule.useMutation(refresh)
  const testChannel = trpc.notifications.testChannel.useMutation()
  const [editingChannel, setEditingChannel] = useState<ChannelDraft | null>(null)
  const [editingRule, setEditingRule] = useState<RuleDraft | null>(null)
  const [testMsg, setTestMsg] = useState<Record<number, string>>({})

  const killed = status.data && !status.data.enabled
  const quiet = status.data?.quietHours
  const labels = new Map((catalog.data?.signals ?? []).map(s => [s.key, s.label]))
  const signalLabel = (k: string) => labels.get(k) ?? k

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Notifications</h1>
          <p className="mt-1 max-w-[42rem] text-[13px] leading-snug text-fg-2">
            Push a message when something happens on the unit — a pump fault, a low tank, a pod that is ready — through Pushover, Pushbullet or an Apprise API server you run.
            {' '}
            <Link to="/settings" hash="notifications" className="underline-offset-2 hover:underline">Settings → Notifications</Link>
            {' '}
            holds the same kill switch and quiet hours.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-fg-2">
          {killed ? 'Off' : 'On'}
          <Toggle size="md" label="Notifications enabled" on={!killed} onChange={on => setGlobal.mutate({ enabled: on })} />
        </label>
      </div>

      {killed && (
        <div role="status" className="rounded-ctl border border-line-2 bg-active px-4 py-2.5 text-[13px] text-fg-2">
          Notifications are off. Rules stay saved but nothing is sent until you turn them back on.
        </div>
      )}

      <div className="rounded-card border border-line bg-surface px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-fg">Quiet hours</div>
            <p className="text-[13px] text-fg-2">No pushes in this window, unless a rule says to ignore quiet hours (pump faults do).</p>
          </div>
          <div className="flex items-center gap-2">
            <input aria-label="Quiet hours start" type="time" className="rounded-ctl border border-line-2 bg-transparent px-2 py-1 font-mono text-[13px] text-fg" value={quiet?.start ?? ''} onChange={e => setQuiet.mutate({ quietHours: e.target.value && (quiet?.end || e.target.value) ? { start: e.target.value, end: quiet?.end || e.target.value } : null })} />
            <span className="text-[13px] text-fg-3">to</span>
            <input aria-label="Quiet hours end" type="time" className="rounded-ctl border border-line-2 bg-transparent px-2 py-1 font-mono text-[13px] text-fg" value={quiet?.end ?? ''} onChange={e => setQuiet.mutate({ quietHours: e.target.value && (quiet?.start || e.target.value) ? { start: quiet?.start || '22:00', end: e.target.value } : null })} />
            {quiet && <Button size="sm" variant="ghost" onClick={() => setQuiet.mutate({ quietHours: null })}>Clear</Button>}
          </div>
        </div>
      </div>

      <SectionLabel right={<Button size="sm" icon={Plus} onClick={() => setEditingChannel({ id: null })}>Add channel</Button>}>Channels</SectionLabel>
      {channels.data?.length === 0 && (
        <p className="text-[13px] text-fg-2">No channels yet. Add Pushover (user key + app token), Pushbullet (access token), or an Apprise API server URL. Tokens stay on the unit and are never shown in full.</p>
      )}
      <div className="flex flex-col gap-2">
        {channels.data?.map(ch => (
          <div key={ch.id} data-testid={`channel-${ch.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface px-4 py-3">
            <div>
              <div className="text-sm font-medium text-fg">{ch.name}</div>
              <div className="text-[13px] text-fg-2 capitalize">
                {ch.kind}
                {ch.enabled ? '' : ' · off'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => testChannel.mutate({ id: ch.id }, { onSuccess: r => setTestMsg(m => ({ ...m, [ch.id]: r.ok ? 'Test sent' : (r.error ?? 'Failed') })), onError: e => setTestMsg(m => ({ ...m, [ch.id]: e.message })) })}>
                {testChannel.isPending && testChannel.variables?.id === ch.id ? 'Sending…' : 'Send test'}
              </Button>
              <Button size="sm" onClick={() => setEditingChannel({ id: ch.id })}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete ${ch.name}?`)) removeChannel.mutate({ id: ch.id }) }}>Remove</Button>
            </div>
            {testMsg[ch.id] && <div role="status" className="w-full text-[13px] text-fg-2">{testMsg[ch.id]}</div>}
          </div>
        ))}
      </div>

      <SectionLabel right={<Button variant="primary" icon={Plus} onClick={() => setEditingRule({ id: null })}>New rule</Button>}>Rules</SectionLabel>
      {rules.data?.length === 0 && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[13px] text-fg-2">No rules yet. A rule is IF this, THEN notify that — the same idea as Autopilot, but it only sends a push. Start from one of these (they save off until you turn them on):</p>
          <div className="grid gap-2.5 min-[720px]:grid-cols-3">
            {(starters.data ?? []).map(s => (
              <button key={s.id} type="button" onClick={() => setEditingRule({ id: null, starter: { ...s, enabled: false } })} className="flex cursor-pointer flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:bg-active">
                <span className="text-sm font-medium text-fg">{s.name}</span>
                <span className="text-[13px] leading-snug text-fg-2">{s.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {rules.data?.map(r => (
          <div key={r.id} data-testid={`notify-rule-${r.id}`} className="flex flex-col gap-2 rounded-card border border-line bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-fg">{r.name}</div>
                <p className="text-[13px] leading-snug text-fg-2">{describeNotifyRule(r, signalLabel)}</p>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg-2">
                {r.enabled ? 'On' : 'Off'}
                <Toggle label={`${r.name} enabled`} on={r.enabled} onChange={on => updateRule.mutate({ id: r.id, enabled: on })} />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setEditingRule({ id: r.id })}>Edit</Button>
              <TestRuleButton id={r.id} />
              <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete ${r.name}?`)) removeRule.mutate({ id: r.id }) }}>Remove</Button>
              {r.lastRun && (
                <span className="ml-auto text-[12px] text-fg-3">{OUTCOME[r.lastRun.outcome] ?? r.lastRun.outcome}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {rules.data && rules.data.length > 0 && (starters.data ?? []).some(s => !s.alreadyAdded) && (
        <>
          <SectionLabel>Starter templates</SectionLabel>
          <div className="grid gap-2.5 min-[720px]:grid-cols-3">
            {(starters.data ?? []).filter(s => !s.alreadyAdded).map(s => (
              <button key={s.id} type="button" onClick={() => setEditingRule({ id: null, starter: { ...s, enabled: false } })} className="flex cursor-pointer flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:bg-active">
                <span className="text-sm font-medium text-fg">{s.name}</span>
                <span className="text-[13px] leading-snug text-fg-2">{s.description}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <SectionLabel>History</SectionLabel>
      <ol aria-label="Notification log" className="flex flex-col gap-1.5">
        {(runs.data ?? []).length === 0 && <li className="text-[13px] text-fg-2">Nothing sent yet.</li>}
        {(runs.data ?? []).map((run) => {
          const rule = rules.data?.find(r => r.id === run.ruleId)
          return (
            <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-ctl border border-line-2 px-3 py-2 text-[13px]">
              <span className="text-fg">{rule?.name ?? `Rule ${run.ruleId}`}</span>
              <span className="text-fg-2">{OUTCOME[run.outcome] ?? run.outcome}</span>
              <span className="w-full font-mono text-[12px] text-fg-3">{run.firedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</span>
            </li>
          )
        })}
      </ol>

      {editingChannel && (
        <ChannelEditor
          id={editingChannel.id}
          existing={editingChannel.id !== null ? channels.data?.find(c => c.id === editingChannel.id) : undefined}
          onClose={() => setEditingChannel(null)}
        />
      )}
      {editingRule && (
        <RuleEditor
          id={editingRule.id}
          existing={editingRule.id !== null ? rules.data?.find(r => r.id === editingRule.id) : undefined}
          starter={editingRule.starter}
          channels={channels.data ?? []}
          events={catalog.data?.events ?? Object.entries(EVENT_LABELS).map(([event, label]) => ({ event: event as keyof typeof EVENT_LABELS, label }))}
          signals={catalog.data?.signals ?? []}
          onClose={() => setEditingRule(null)}
        />
      )}
      {setGlobal.error && <InlineError>{setGlobal.error.message}</InlineError>}
    </div>
  )
}

function TestRuleButton({ id }: { id: number }) {
  const utils = trpc.useUtils()
  const test = trpc.notifications.testRule.useMutation({ onSuccess: () => void utils.notifications.invalidate() })
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" onClick={() => test.mutate({ id })}>{test.isPending ? 'Sending…' : 'Test rule'}</Button>
      {test.data && <span role="status" className="text-[12px] text-fg-2">{test.data.results.some(r => r.ok) ? 'Sent' : (test.data.results[0]?.error ?? 'No channel')}</span>}
      {test.error && <span role="status" className="text-[12px] text-danger">{test.error.message}</span>}
    </span>
  )
}

void BellRing
