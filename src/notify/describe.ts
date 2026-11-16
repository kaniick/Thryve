import { EVENT_LABELS } from './events'
import type { NotificationRule, NotifyTrigger } from './types'
import type { CompareOp, Condition } from '../autopilot/types'

const OP: Record<CompareOp, string> = { '>': 'above', '>=': 'at least', '<': 'below', '<=': 'at most', '==': 'equal to', '!=': 'not' }

export function describeTrigger(t: NotifyTrigger, signalLabel: (key: string) => string): string {
  switch (t.kind) {
    case 'tick': return `Every ${t.everyMin} minute${t.everyMin === 1 ? '' : 's'}`
    case 'signalChange': return `When ${signalLabel(t.signal)} changes`
    case 'timeOfDay': return `At ${t.at}${t.days?.length ? ` on ${t.days.join(', ')}` : ''}`
    case 'threshold': {
      const hold = t.forMin ? ` for ${t.forMin} min` : ''
      return `When ${signalLabel(t.signal)} is ${OP[t.op]} ${t.value}${hold}`
    }
    case 'event': return `When ${EVENT_LABELS[t.event].toLowerCase()}${t.alertKind ? ` (${t.alertKind})` : ''}`
  }
}

export function describeNotifyRule(r: Pick<NotificationRule, 'trigger' | 'conditions' | 'priority' | 'cooldownMin' | 'ignoreQuietHours' | 'repeatWhileTrue' | 'channelIds'>, signalLabel: (key: string) => string = k => k): string {
  const when = describeTrigger(r.trigger, signalLabel)
  const cond = describeCondition(r.conditions, signalLabel)
  const dest = r.channelIds.length === 0 ? 'every enabled channel' : `${r.channelIds.length} channel${r.channelIds.length === 1 ? '' : 's'}`
  const cool = r.cooldownMin > 0 ? ` At most once every ${r.cooldownMin} min.` : ''
  const quiet = r.ignoreQuietHours ? ' Quiet hours are ignored.' : ''
  const repeat = r.repeatWhileTrue ? ' Repeats while it still holds.' : ''
  return `${when}${cond ? `, if ${cond}` : ''}, send a ${r.priority} notice to ${dest}.${cool}${quiet}${repeat}`
}

function describeCondition(c: Condition, signalLabel: (key: string) => string): string {
  switch (c.kind) {
    case 'and':
      return c.conditions.map(x => describeCondition(x, signalLabel)).filter(Boolean).join(' and ')
    case 'or':
      return c.conditions.map(x => describeCondition(x, signalLabel)).filter(Boolean).join(' or ')
    case 'not':
      return `not ${describeCondition(c.condition, signalLabel)}`
    case 'compare': {
      const left = c.left.kind === 'signal' ? signalLabel(c.left.signal) : c.left.kind === 'literal' ? String(c.left.value) : 'value'
      const right = c.right.kind === 'literal' ? String(c.right.value) : 'a value'
      return `${left} is ${OP[c.op]} ${right}`
    }
    case 'between':
      return 'a value is in range'
    case 'timeBetween':
      return `it's between ${c.start} and ${c.end}`
    case 'onDays':
      return `it's ${c.days.join(' or ')}`
    case 'sustained':
      return `${describeCondition(c.condition, signalLabel)} for ${c.forMin} min`
  }
}
