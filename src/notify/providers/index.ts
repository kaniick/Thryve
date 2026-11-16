
import type { NotificationChannel } from '../types'
import { sendApprise } from './apprise'
import type { HttpFetch, SendRequest, SendResult } from './http'
import { sendPushbullet } from './pushbullet'
import { sendPushover } from './pushover'

export type { HttpFetch, SendRequest, SendResult } from './http'

export async function sendOnChannel(channel: NotificationChannel, req: SendRequest, fetchImpl: HttpFetch): Promise<SendResult> {
  switch (channel.kind) {
    case 'pushover': return sendPushover(channel, req, fetchImpl)
    case 'pushbullet': return sendPushbullet(channel, req, fetchImpl)
    case 'apprise': return sendApprise(channel, req, fetchImpl)
  }
}
