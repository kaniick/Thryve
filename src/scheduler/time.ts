/** Timezone-aware local time helpers without a date library. */

export interface LocalTime {
  /** YYYY-MM-DD in the zone. */
  date: string
  /** Minutes past local midnight. */
  minute: number
  /** 0 = Monday … 6 = Sunday (matches the schedule bitmask). */
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

const FORMATTER_CACHE_SIZE = 16
const localFormatters = new Map<string, Intl.DateTimeFormat>()
const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function formatter(cache: Map<string, Intl.DateTimeFormat>, timezone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const hit = cache.get(timezone)
  if (hit) return hit
  const fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone })
  const oldest = cache.keys().next().value
  if (cache.size >= FORMATTER_CACHE_SIZE && oldest !== undefined) cache.delete(oldest)
  cache.set(timezone, fmt)
  return fmt
}

const LOCAL_FORMAT: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
}

export function localTime(now: Date, timezone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = formatter(localFormatters, timezone, LOCAL_FORMAT).formatToParts(now)
  }
  catch {
    parts = formatter(localFormatters, 'UTC', LOCAL_FORMAT).formatToParts(now)
  }
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minute: hour * 60 + Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

/** The zone's short name at `now`, as a clock prints it: PST, EDT, UTC, GMT+5:30. */
export function zoneAbbr(now: Date, timezone: string): string {
  try {
    return formatter(zoneFormatters, timezone, { timeZoneName: 'short' }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? timezone
  }
  catch {
    return 'UTC'
  }
}

/** The zone this process runs in: a fallback until the unit's is known. */
export const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export function dayEnabled(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0
}

export function minuteToHHMM(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
