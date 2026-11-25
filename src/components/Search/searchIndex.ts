/**
 * What ⌘K searches (after sleepypod's searchIndex): every page, the Settings
 * cards, the unit's own pods and Autopilot rules, and the docs site's
 * guides, ranked with BM25.
 */
import type { LucideIcon } from 'lucide-react'
import { Archive, BellRing, BookOpen, CloudUpload, Code, Database, HardDrive, House, Info, KeyRound, Monitor, Power, Radio, RefreshCw, Ruler, Settings, Sprout, Timer, Camera, Wand2, Waves, Wifi } from 'lucide-react'
import { navItems } from '@/src/components/AppShell/navItems'
import { createBm25Index, tokenize } from '@/src/lib/bm25'
import { PLANTS } from '@/src/plants/catalog'
import { DOCS_BASE, type DocsIndex } from './docsIndex'

export interface SearchEntry {
  id: string
  title: string
  /** Parent pages, outermost first: ['Settings']. Empty for top-level pages. */
  crumbs: string[]
  description: string
  /** Space-separated synonyms. Searched, never shown. */
  keywords: string
  /** In-app path, with any query or hash, or an absolute URL when `external`. */
  href: string
  /** Opens `href` in a new tab instead of navigating the app. */
  external?: boolean
  icon: LucideIcon
  /** Static rank multiplier. */
  boost?: number
}

/** Title outranks synonyms, which outrank prose. Breadcrumbs aren't indexed. */
export const SEARCH_FIELDS = {
  title: { weight: 3, b: 0.3 },
  keywords: { weight: 1.5, b: 0.5 },
  description: { weight: 1, b: 0.75 },
} as const

const PAGES: Record<string, { description: string, keywords: string }> = {
  '/': { description: 'The tower at a glance: light, water, air and alerts', keywords: 'dashboard overview status home tower 3d' },
  '/light': { description: 'Brightness, on and off, the manual hold and light curves', keywords: 'grow light led lamp brightness dim hold schedule timer curve sunrise sunset program' },
  '/water': { description: 'Tank level, running the pump and pump cycles', keywords: 'water tank reservoir pump level refill watering schedule timer cycle program' },
  '/care': { description: 'Chores, the tank log, setup issues, starter rules and connecting an AI assistant', keywords: 'care chores feed top off refresh thin trim roots clean tank log nutrients setup check starter rules ai assistant agent claude mcp kelby' },
  '/autopilot': { description: 'Rules that react to readings, with backtests', keywords: 'automation automations rules backtest dry run kill switch' },
  '/notifications': { description: 'Push rules for Pushover, Pushbullet and Apprise', keywords: 'notifications notify pushover pushbullet apprise push alerts ifttt rules quiet hours cooldown' },
  '/grow': { description: 'Grow cycle, stages, reminders and the 30 pods', keywords: 'grow cycle pods plants harvest seedling stage tower' },
  '/plan': { description: 'Lay out pods by light zone and stagger sowing dates', keywords: 'plan planner layout light zone placement sow sowing succession catalog ycube seed' },
  '/cameras': { description: 'Stills from both cameras and the timelapse', keywords: 'camera photo picture still timelapse capture' },
  '/analysis': { description: 'Growth per pod from the photos, analysers and dataset export', keywords: 'analysis vision green growth dataset export analyser analyzer' },
  '/alerts': { description: 'Faults and reminders, and acknowledging them', keywords: 'alerts faults warnings reminders acknowledge latch' },
  '/status': { description: 'Whether each part of the unit is running: daemon, sensors, outputs, cameras and services', keywords: 'status health checks system daemon services uptime ok down stalled bridge mqtt' },
  '/sensors': { description: 'Every sensor, adding probes and calibration', keywords: 'sensors probes ph ec temperature calibrate i2c ezo' },
  '/settings': { description: 'The unit, calibration, integrations and backups', keywords: 'settings preferences configuration options' },
}

/** The Settings cards, linked by their anchor on the page. */
const SETTINGS: ReadonlyArray<Omit<SearchEntry, 'crumbs' | 'href'> & { anchor: string }> = [
  { id: 'unit', anchor: 'unit', title: 'Unit', description: 'Name, timezone and units (°C, L, cm or °F, gal, in)', keywords: 'name timezone time zone celsius fahrenheit degrees units metric imperial us gallons litres liters inches centimetres', icon: Settings },
  { id: 'tank', anchor: 'tank', title: 'Tank calibration', description: 'Distance to the water when full and when empty, and the capacity', keywords: 'tank calibration full empty capacity litres liters distance ultrasonic water level', icon: Ruler },
  { id: 'pump', anchor: 'pump', title: 'Pump duty cycle', description: 'How hard the pump runs, its soft start, and a test run', keywords: 'pump power speed duty cycle strength water top tower reboot brown out soft start ramp inrush test run', icon: Waves, boost: 0.7 },
  { id: 'reminders', anchor: 'reminders', title: 'Grow reminders', description: 'Days to thinning, root check, harvest and nutrients', keywords: 'reminders thinning root check harvest nutrients feed days', icon: Timer },
  { id: 'notifications', anchor: 'notifications', title: 'Notifications', description: 'Kill switch and quiet hours for Pushover, Pushbullet and Apprise rules', keywords: 'notifications pushover pushbullet apprise quiet hours push', icon: BellRing },
  { id: 'cameras', anchor: 'cameras', title: 'Capture interval', description: 'How often the cameras take a still, and analysis masks', keywords: 'camera capture interval timelapse masks artifacts photos', icon: Camera },
  { id: 'storage', anchor: 'storage', title: 'Storage', description: 'How much the unit writes to its SD card each day', keywords: 'sd card flash writes wear storage disk endurance', icon: HardDrive },
  { id: 'backup', anchor: 'backup', title: 'Backup', description: 'Download a backup, nightly backups to the bucket, restore and undo', keywords: 'backup restore download nightly bucket undo archive recovery card', icon: Archive },
  { id: 'homekit', anchor: 'homekit', title: 'Apple Home', description: 'HomeKit: setup code and QR, pairing and reset', keywords: 'homekit apple home siri iphone ios pair pairing setup code qr', icon: House },
  { id: 'ha', anchor: 'home-assistant', title: 'Home Assistant bridge', description: 'Core MQTT bridge for grow events; Test connection and, when installed, point the hardware daemon at the same broker', keywords: 'home assistant hass mqtt broker tls integration hald hardware daemon', icon: Radio },
  { id: 'api', anchor: 'api', title: 'MCP access', description: 'An optional key required only by MCP clients; the web UI and the rest of the API on the LAN do not need it', keywords: 'api key mcp access token rest auth authentication security ingest results remote worker assistant claude', icon: KeyRound },
  { id: 'mirror', anchor: 'off-device', title: 'Off-device storage', description: 'Copy photos to an S3 bucket', keywords: 'mirror s3 r2 minio bucket off-device cloud', icon: CloudUpload },
  { id: 'update', anchor: 'update', title: 'Updates', description: 'Check for a new release and update, from the stable or dev channel', keywords: 'update upgrade release version channel stable dev latest install rollback', icon: RefreshCw },
  { id: 'maintenance', anchor: 'maintenance', title: 'Maintenance', description: 'Restart Core or reboot the Pi with the owner key; see uptime, event-loop delay and boot diagnostics', keywords: 'reboot restart core pi maintenance recovery uptime boot log diagnostics', icon: Power },
  { id: 'about', anchor: 'about', title: 'About', description: 'Core and hardware daemon versions, unit id', keywords: 'version core hald daemon unit id about', icon: Info },
]

export interface LiveData {
  pods?: ReadonlyArray<{ slot: number, plant: string | null, status: string, notes: string }>
  rules?: ReadonlyArray<{ id: number, name: string, enabled: boolean, dryRun: boolean }>
}

const STATUS: Record<string, string> = { seeded: 'Seeded', growing: 'Growing', harvest: 'Ready to harvest', attention: 'Needs attention', empty: 'Empty' }

export function buildSearchEntries(live: LiveData = {}): SearchEntry[] {
  const pages: SearchEntry[] = navItems.map(n => ({
    id: `page:${n.to}`,
    title: n.label,
    crumbs: [],
    description: PAGES[n.to]?.description ?? '',
    keywords: PAGES[n.to]?.keywords ?? '',
    href: n.to,
    icon: n.icon,
  }))
  const sub: SearchEntry[] = [
    { id: 'page:/wifi', title: 'Wi-Fi', crumbs: ['Settings'], description: 'Join a network, or open the setup hotspot', keywords: 'wifi wireless network hotspot ssid password join', href: '/wifi', icon: Wifi },
    { id: 'page:/database', title: 'Database', crumbs: ['Settings', 'SD card'], description: 'What is writing to the SD card: size, rows and writes per table', keywords: 'database sqlite wal tables rows writes integrity migrations sd card flash', href: '/database', icon: Database },
    { id: 'page:/kiosk', title: 'Kiosk', crumbs: [], description: 'Big numbers for a wall display', keywords: 'kiosk wall display fullscreen tablet', href: '/kiosk', icon: Monitor, boost: 0.8 },
    { id: 'page:/api/openapi.json', title: 'REST API', crumbs: ['Settings', 'API key'], description: 'The OpenAPI description of every endpoint', keywords: 'openapi swagger rest api endpoints docs', href: '/settings#api', icon: Code, boost: 0.7 },
  ]
  const settings: SearchEntry[] = SETTINGS.map(({ anchor, ...e }) => ({ ...e, id: `setting:${e.id}`, crumbs: ['Settings'], href: `/settings#${anchor}` }))
  const pods: SearchEntry[] = (live.pods ?? []).filter(p => p.plant).map(p => ({
    id: `pod:${p.slot}`,
    title: p.plant as string,
    crumbs: ['Grow', `Pod ${p.slot}`],
    description: `${STATUS[p.status] ?? p.status}${p.notes ? ` · ${p.notes}` : ''}`,
    keywords: `pod ${p.slot} plant ${p.status}`,
    href: `/grow?pod=${p.slot}`,
    icon: Sprout,
  }))
  const rules: SearchEntry[] = (live.rules ?? []).map(r => ({
    id: `rule:${r.id}`,
    title: r.name,
    crumbs: ['Autopilot'],
    description: !r.enabled ? 'Off' : r.dryRun ? 'Dry run' : 'Armed',
    keywords: 'rule automation',
    href: '/autopilot',
    icon: Wand2,
  }))
  return [...pages, ...sub, ...settings, ...pods, ...rules]
}

/** Below Kiosk and REST API: an app page or setting wins an equal match against its docs page. */
const DOCS_BOOST = 0.6

/** The bundled catalog is searchable even when the docs site or unit is offline. */
export const plantSearchEntries: SearchEntry[] = PLANTS.map(p => ({
  id: `plant:${p.id}`,
  title: p.name,
  crumbs: ['Plan', 'Plant catalog'],
  description: `${p.zone[0].toUpperCase()}${p.zone.slice(1)} light · ${p.harvestMonths.join('–')} mo to first harvest${p.harvestEstimated ? ' (estimated)' : ''}`,
  keywords: `ycube ${p.category}`,
  href: `/plan?plant=${encodeURIComponent(p.id)}#plant-catalog`,
  icon: Sprout,
  boost: 0.55,
}))

/**
 * One entry per docs page. Headings feed the keywords rather than becoming
 * entries of their own, so they can't bury the app's pages and settings.
 */
export function buildDocsEntries(index: DocsIndex): SearchEntry[] {
  return index.pages.map(page => ({
    id: `docs:${page.path}`,
    title: page.title,
    crumbs: page.section ? ['Docs', page.section] : ['Docs'],
    description: page.description,
    keywords: [...page.headings.map(h => h.title), page.keywords].join(' '),
    href: `${DOCS_BASE}${page.path}`,
    external: true,
    icon: BookOpen,
    boost: DOCS_BOOST,
  }))
}

/** A search function over the entries; the empty query returns nothing. */
export function createSearch(entries: SearchEntry[]) {
  const index = createBm25Index(entries, SEARCH_FIELDS)
  return (query: string, limit?: number): SearchEntry[] =>
    tokenize(query).length === 0 ? [] : index.search(query, limit).map(h => entries[h.index] as SearchEntry)
}
