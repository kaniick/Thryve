import type { IosService } from '../ios/service'
import type { NotificationChannel } from '../types'
import { sendApprise } from './apprise'
import type { HttpFetch, SendRequest, SendResult } from './http'
import { sendPushbullet } from './pushbullet'
import { sendPushover } from './pushover'

export type { HttpFetch, SendRequest, SendResult } from './http'

export type ChannelProvider = (channel: NotificationChannel, req: SendRequest, fetchImpl: HttpFetch) => Promise<SendResult>

const providers = new Map<string, ChannelProvider>()

/**
 * Register (or replace) a delivery backend by channel kind. Built-in
 * Pushover, Pushbullet and Apprise are registered below; another module
 * (e.g. iOS APNs) can call this at startup without editing this switch.
 */
export function registerChannelProvider(kind: string, send: ChannelProvider): void {
  providers.set(kind, send)
}

registerChannelProvider('pushover', sendPushover)
registerChannelProvider('pushbullet', sendPushbullet)
registerChannelProvider('apprise', sendApprise)

export async function sendOnChannel(channel: NotificationChannel, req: SendRequest, fetchImpl: HttpFetch, ios?: IosService | null): Promise<SendResult> {
  // The iPhone app channel is per-core (it owns the device list and APNs client), so it's passed in.
  if (channel.kind === 'ios') return ios ? ios.send(channel, req) : { ok: false, error: 'The iPhone channel isn\'t available on this host' }
  const send = providers.get(channel.kind)
  if (!send) return { ok: false, error: `No provider registered for ${channel.kind}` }
  return send(channel, req, fetchImpl)
}
