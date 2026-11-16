
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface SendRequest {
  title: string
  message: string
  priority: 'lowest' | 'low' | 'normal' | 'high' | 'emergency'
}

export interface SendResult {
  ok: boolean
  id?: string
  error?: string
}

export async function readBody(res: Response): Promise<string> {
  try {
    return await res.text()
  }
  catch {
    return ''
  }
}

/** Never return a provider body verbatim: it can echo tokens. Keep status + short reason. */
export function httpError(status: number, body: string): string {
  const trim = body.replace(/\s+/g, ' ').trim().slice(0, 180)
  const safe = trim.replace(/[A-Za-z0-9_-]{20,}/g, '••••')
  return safe ? `HTTP ${status}: ${safe}` : `HTTP ${status}`
}
