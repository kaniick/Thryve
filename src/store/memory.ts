import type { SensorId } from '../hardware/contract'
import type { AlertQuery, AlertRow, Automation, AutomationRun, AnalysisPoint, AnalysisRow, AnalyzerStats, BackupRecord, Capture, CustomPlant, DeviceSettings, FlashSample, GrowCycle, GrowProtocolState, GrowStage, PlanRow, PlantProfile, Pod, PodCodePair, PodCodeRead, PodLabel, PodLabelCursor, PodLabelInput, PodLabelSource, PodLabelValue, SavedSchedule, Schedule, ScheduleRun, Store, SuggestionDismissal, TankAction, TankActionKind, TelemetryPoint, QualitySample, PumpRun, PumpSpec } from './types'
import type { NotificationChannel, NotificationRule, NotificationRun } from '../notify/types'
import type { ActivityToken, FeedItem, IosDevice } from '../notify/ios/types'
import type { AutomationRule } from '../autopilot/types'
import { DEFAULT_SETTINGS, POD_LABELS, profileKey } from './types'

/** In-memory Store for tests and the browser demo. Same semantics as SqliteStore. */
export class MemoryStore implements Store {
  private settingsRow: DeviceSettings = { ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() }
  private readonly scheduleRows = new Map<string, Schedule>()
  private readonly runs: ScheduleRun[] = []
  private readonly runKeys = new Set<string>()
  private readonly alertRows: AlertRow[] = []
  private nextAlertId = 1
  private readonly cycles: GrowCycle[] = []
  private readonly podRows = new Map<number, Pod>()
  private readonly profileRows = new Map<string, PlantProfile>()
  private readonly customPlantRows = new Map<string, CustomPlant>()
  private readonly savedRows = new Map<string, SavedSchedule>()
  private readonly captureRows: Capture[] = []
  private points: TelemetryPoint[] = []
  private readonly counterRows = new Map<string, number>()
  private flashRows: FlashSample[] = []
  private readonly backupRows: BackupRecord[] = []
  private readonly analysisRows: AnalysisRow[] = []
  private readonly planRows = new Map<string, PlanRow>()
  private automationRows: Automation[] = []
  private runRows: AutomationRun[] = []
  private nextAutomationId = 1
  private nextRunId = 1
  private notificationChannels: NotificationChannel[] = []
  private notificationRules: NotificationRule[] = []
  private notificationRunRows: NotificationRun[] = []
  private nextNotificationChannelId = 1
  private nextNotificationRuleId = 1
  private nextNotificationRunId = 1
  private iosDevices = new Map<string, IosDevice>()
  private activityTokenRows: ActivityToken[] = []
  private feedRows: FeedItem[] = []
  private nextFeedId = 1
  private readonly labelRows = new Map<string, PodLabel>()
  private readonly dismissalRows = new Map<string, SuggestionDismissal>()
  private readonly codePairs = new Map<string, PodCodePair>()
  private readonly codeReads = new Map<number, PodCodeRead>()
  private readonly tankRows: TankAction[] = []
  private nextTankId = 1
  private qualityRows: QualitySample[] = []
  private readonly pumpRunRows: PumpRun[] = []
  private nextPumpRunId = 1
  private openPumpRun: PumpRun | null = null

  constructor(podCount = 30) {
    const ts = new Date(0).toISOString()
    for (let slot = 1; slot <= podCount; slot++) {
      this.podRows.set(slot, { slot, plant: null, plantedAt: null, status: 'empty', notes: '', updatedAt: ts, statusSince: ts, lastHarvestAt: null })
    }
  }

  settings = {
    get: (): DeviceSettings => ({ ...this.settingsRow }),
    update: (patch: Partial<Omit<DeviceSettings, 'updatedAt'>>): DeviceSettings => {
      this.settingsRow = { ...this.settingsRow, ...patch, updatedAt: new Date().toISOString() }
      return { ...this.settingsRow }
    },
  }

  schedules = {
    list: (): Schedule[] => [...this.scheduleRows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    get: (id: string): Schedule | null => this.scheduleRows.get(id) ?? null,
    upsert: (s: Omit<Schedule, 'createdAt' | 'updatedAt'> & Partial<Pick<Schedule, 'createdAt'>>): Schedule => {
      const now = new Date().toISOString()
      const prev = this.scheduleRows.get(s.id)
      const row: Schedule = { ...s, createdAt: prev?.createdAt ?? s.createdAt ?? now, updatedAt: now }
      this.scheduleRows.set(s.id, row)
      return row
    },
    remove: (id: string): boolean => this.scheduleRows.delete(id),
    recordRun: (run: ScheduleRun): boolean => {
      if (this.runKeys.has(run.key)) return false
      this.runKeys.add(run.key)
      this.runs.push(run)
      return true
    },
    setRunResult: (key: string, result: string): void => {
      const run = this.runs.find(r => r.key === key)
      if (run) run.result = result
    },
    recentRuns: (limit = 50): ScheduleRun[] => this.runs.slice(-limit).reverse(),
  }

  alerts = {
    list: (opts?: AlertQuery): AlertRow[] => {
      const rows = this.alertRows.filter(a => (!opts?.activeOnly || a.active) && (opts?.kind === undefined || a.kind === opts.kind) && (opts?.since === undefined || a.raisedAt >= opts.since))
        .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || a.id - b.id)
      const offset = opts?.offset ?? 0
      return rows.slice(offset, opts?.limit === undefined ? undefined : offset + opts.limit)
    },
    raise: (kind: string, detail: string, ts: string): AlertRow => {
      const existing = this.alertRows.find(a => a.kind === kind && a.active)
      if (existing) {
        existing.detail = detail
        return existing
      }
      const row: AlertRow = { id: this.nextAlertId++, kind, active: true, detail, raisedAt: ts, clearedAt: null, acknowledgedAt: null, dismissedAt: null }
      this.alertRows.push(row)
      return row
    },
    clear: (kind: string, ts: string): AlertRow | null => {
      const existing = this.alertRows.find(a => a.kind === kind && a.active)
      if (!existing) return null
      existing.active = false
      existing.clearedAt = ts
      return existing
    },
    acknowledge: (id: number, ts: string): AlertRow | null => {
      const a = this.alertRows.find(x => x.id === id)
      if (!a) return null
      a.acknowledgedAt = ts
      return a
    },
    dismiss: (id: number, ts: string): AlertRow | null => {
      const a = this.alertRows.find(x => x.id === id)
      if (!a) return null
      a.dismissedAt = ts
      a.active = false
      return a
    },
  }

  grow = {
    current: (): GrowCycle | null => this.cycles.find(c => c.endedAt === null) ?? null,
    start: (ts: string, notes = ''): GrowCycle => {
      const open = this.grow.current()
      if (open) {
        open.endedAt = ts
        open.stage = 'ended'
      }
      const c: GrowCycle = { id: `cycle-${this.cycles.length + 1}`, startedAt: ts, endedAt: null, stage: 'germination', notes, issued: [], protocolId: null, shiftDays: 0, holdStageId: null, holdSince: null, thenKind: 'stay', thenScheduleId: null, thenDoneAt: null, stageStarts: {} }
      this.cycles.push(c)
      return c
    },
    setStart: (ts: string, stage: GrowStage, issued: string[]): GrowCycle | null => {
      const c = this.grow.current()
      if (!c) return null
      c.startedAt = ts
      c.stage = stage
      c.issued = [...issued]
      return c
    },
    setStage: (stage: GrowStage): GrowCycle | null => {
      const c = this.grow.current()
      if (!c) return null
      c.stage = stage
      return c
    },
    markIssued: (reminder: string): void => {
      const c = this.grow.current()
      if (c && !c.issued.includes(reminder)) c.issued.push(reminder)
    },
    setProtocol: (patch: Partial<GrowProtocolState>): GrowCycle | null => {
      const c = this.grow.current()
      if (!c) return null
      Object.assign(c, clone(patch))
      return c
    },
    end: (ts: string): GrowCycle | null => {
      const c = this.grow.current()
      if (!c) return null
      c.endedAt = ts
      c.stage = 'ended'
      return c
    },
    history: (): GrowCycle[] => [...this.cycles].reverse(),
  }

  pods = {
    list: (): Pod[] => [...this.podRows.values()].sort((a, b) => a.slot - b.slot),
    update: (slot: number, patch: Partial<Omit<Pod, 'slot' | 'updatedAt' | 'statusSince'>>, ts: string): Pod => {
      const prev = this.podRows.get(slot)
      if (!prev) throw new Error(`no pod ${slot}`)
      const moved = patch.status !== undefined && patch.status !== prev.status
      const row = { ...prev, ...patch, updatedAt: ts, statusSince: moved ? ts : prev.statusSince }
      this.podRows.set(slot, row)
      return row
    },
  }

  plants = {
    list: (): PlantProfile[] => [...this.profileRows.values()].sort((a, b) => a.key.localeCompare(b.key)),
    upsert: (p: Omit<PlantProfile, 'key' | 'updatedAt'>, ts: string): PlantProfile => {
      const row = { ...p, key: profileKey(p.name), updatedAt: ts }
      this.profileRows.set(row.key, row)
      return row
    },
    remove: (name: string): boolean => this.profileRows.delete(profileKey(name)),
  }

  customPlants = {
    list: (): CustomPlant[] => [...this.customPlantRows.values()].map(clone),
    get: (id: string): CustomPlant | null => {
      const r = this.customPlantRows.get(id)
      return r ? clone(r) : null
    },
    upsert: (p: Omit<CustomPlant, 'createdAt' | 'updatedAt'>, ts: string): CustomPlant => {
      const row: CustomPlant = { ...clone(p), createdAt: this.customPlantRows.get(p.id)?.createdAt ?? ts, updatedAt: ts }
      this.customPlantRows.set(p.id, row)
      return clone(row)
    },
    remove: (id: string): boolean => this.customPlantRows.delete(id),
  }

  scheduleLibrary = {
    list: (): SavedSchedule[] => [...this.savedRows.values()].map(clone),
    get: (id: string): SavedSchedule | null => {
      const r = this.savedRows.get(id)
      return r ? clone(r) : null
    },
    upsert: (s: Omit<SavedSchedule, 'createdAt' | 'updatedAt' | 'lastUsedAt'>, ts: string): SavedSchedule => {
      const prev = this.savedRows.get(s.id)
      const row: SavedSchedule = { ...clone(s), createdAt: prev?.createdAt ?? ts, updatedAt: ts, lastUsedAt: prev?.lastUsedAt ?? null }
      this.savedRows.set(s.id, row)
      return clone(row)
    },
    markUsed: (id: string, ts: string): void => {
      const r = this.savedRows.get(id)
      if (r) r.lastUsedAt = ts
    },
    remove: (id: string): boolean => this.savedRows.delete(id),
  }

  captures = {
    add: (c: Capture): void => {
      this.captureRows.push(c)
    },
    list: (camera?: 'upper' | 'lower', limit = 100): Capture[] =>
      this.captureRows.filter(c => !camera || c.camera === camera).slice().sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit),
    get: (id: string): Capture | null => this.captureRows.find(c => c.id === id) ?? null,
    prune: (camera: 'upper' | 'lower', keep: number): Capture[] => {
      const rows = this.captures.list(camera, Number.MAX_SAFE_INTEGER)
      const drop = rows.slice(keep)
      for (const d of drop) this.captureRows.splice(this.captureRows.indexOf(d), 1)
      return drop
    },
  }

  telemetry = {
    add: (pts: TelemetryPoint[]): void => {
      this.points.push(...pts)
    },
    range: (sensor: SensorId, fromTs: string, toTs: string, maxPoints = 500): TelemetryPoint[] => {
      const rows = this.points.filter(p => p.sensor === sensor && p.ts >= fromTs && p.ts <= toTs)
      return maxPoints < 0 ? rows : downsample(rows, maxPoints)
    },
    scan: (sensor: SensorId, fromTs: string, toTs: string): Iterable<TelemetryPoint> =>
      this.telemetry.range(sensor, fromTs, toTs, -1).sort((a, b) => a.ts.localeCompare(b.ts)),
    count: (sensor: SensorId, fromTs: string, toTs: string): number =>
      this.points.reduce((n, p) => n + Number(p.sensor === sensor && p.ts >= fromTs && p.ts <= toTs), 0),
    flush: (): void => {
      // nothing is held
    },
    thin: (sensors: readonly SensorId[], fromTs: string, toTs: string, bucketMin: number): number => {
      const seen = new Set<string>()
      const before = this.points.length
      this.points = this.points.filter((p) => {
        if (!sensors.includes(p.sensor) || p.ts < fromTs || p.ts >= toTs) return true
        const bucket = `${p.sensor}${p.ts.slice(0, 14)}${Math.floor(Number(p.ts.slice(14, 16)) / bucketMin)}`
        if (seen.has(bucket)) return false
        seen.add(bucket)
        return true
      })
      return before - this.points.length
    },
    oldestTs: (): string | null => this.points[0]?.ts ?? null,
  }

  sensorQuality = {
    add: (samples: QualitySample[]): void => {
      this.qualityRows.push(...samples)
    },
    range: (sensor: string, fromTs: string, toTs: string): QualitySample[] =>
      this.qualityRows.filter(s => s.sensor === sensor && s.ts >= fromTs && s.ts <= toTs),
    counts: (sensor: string, fromTs: string, toTs: string) => qualityCounts(this.sensorQuality.range(sensor, fromTs, toTs)),
    trustedShare: (sensor: string, nowTs: string, windowS: number) => {
      const from = new Date(Date.parse(nowTs) - windowS * 1000).toISOString()
      return trustedShareOf(this.sensorQuality.counts(sensor, from, nowTs), windowS)
    },
  }

  pumpRuns = {
    open: (startedAt: string, level: number | null, recent: ScheduleRun[]): PumpRun => {
      const started = Date.parse(startedAt)
      const hit = recent.find(r => Math.abs(Date.parse(r.firedAt) - started) <= 10_000 && !r.result.startsWith('refused'))
      const spec = hit ? this.scheduleRows.get(hit.scheduleId) : null
      const scheduledDurationS = spec?.kind === 'pump' ? (spec.spec as PumpSpec).durationS : null
      const row: PumpRun = {
        id: this.nextPumpRunId++,
        startedAt,
        endedAt: null,
        durationS: 0,
        source: hit ? 'scheduled' : 'manual',
        scheduleId: hit?.scheduleId ?? null,
        scheduledDurationS,
        fault: null,
        level,
      }
      this.openPumpRun = row
      this.pumpRunRows.push(row)
      return row
    },
    close: (endedAt: string, fault: string | null): PumpRun | null => {
      const row = this.openPumpRun
      if (!row) return null
      row.endedAt = endedAt
      row.durationS = Math.max(0, (Date.parse(endedAt) - Date.parse(row.startedAt)) / 1000)
      row.fault = fault
      this.openPumpRun = null
      return row
    },
    list: (opts?: { from?: string, to?: string, limit?: number }): PumpRun[] => {
      let rows = this.pumpRunRows.slice()
      const from = opts?.from
      const to = opts?.to
      if (from) rows = rows.filter(r => r.startedAt >= from)
      if (to) rows = rows.filter(r => r.startedAt <= to)
      rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id)
      const now = Date.now()
      return rows.slice(0, opts?.limit ?? 50).map((r) => {
        const durationS = r.endedAt ? r.durationS : Math.max(0, (now - Date.parse(r.startedAt)) / 1000)
        return { ...r, durationS }
      })
    },
  }

  counters = {
    add: (key: string, delta: number): number => {
      const v = (this.counterRows.get(key) ?? 0) + delta
      this.counterRows.set(key, v)
      return v
    },
    get: (key: string): number => this.counterRows.get(key) ?? 0,
  }

  backups = {
    add: (r: Omit<BackupRecord, 'id'>): BackupRecord => {
      const row = { ...r, id: this.backupRows.length + 1 }
      this.backupRows.push(row)
      return row
    },
    list: (limit = 50): BackupRecord[] => [...this.backupRows].sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id).slice(0, limit),
    lastSuccess: (destination?: BackupRecord['destination']): BackupRecord | null =>
      this.backups.list(Number.MAX_SAFE_INTEGER).find(r => r.ok && (!destination || r.destination === destination)) ?? null,
  }

  flash = {
    add: (sample: FlashSample): void => {
      this.flashRows = [...this.flashRows.filter(r => r.ts !== sample.ts), sample].sort((a, b) => a.ts.localeCompare(b.ts))
    },
    last: (): FlashSample | null => this.flashRows.at(-1) ?? null,
    since: (fromTs: string): FlashSample[] => this.flashRows.filter(r => r.ts >= fromTs),
    prune: (beforeTs: string): number => {
      const before = this.flashRows.length
      this.flashRows = this.flashRows.filter(r => r.ts >= beforeTs)
      return before - this.flashRows.length
    },
  }

  analyses = {
    add: (rows: AnalysisRow[]): void => {
      for (const r of rows) {
        const i = this.analysisRows.findIndex(x => x.captureId === r.captureId && x.analyzer === r.analyzer && x.version === r.version && x.slot === r.slot && x.metric === r.metric)
        if (i >= 0) this.analysisRows[i] = { ...r }
        else this.analysisRows.push({ ...r })
      }
    },
    latestVersion: (analyzer: string): number | null => {
      let latest: number | null = null
      for (const r of this.analysisRows) if (r.analyzer === analyzer && (latest === null || r.version > latest)) latest = r.version
      return latest
    },
    series: (q: { analyzer: string, version?: number, slot: number, metric: string, limit?: number }): AnalysisPoint[] => {
      const version = q.version ?? this.analyses.latestVersion(q.analyzer)
      if (version === null) return []
      return this.analysisRows
        .filter(r => r.analyzer === q.analyzer && r.version === version && r.slot === q.slot && r.metric === q.metric)
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(-(q.limit ?? 200))
        .map(r => ({ ts: r.ts, value: r.value, captureId: r.captureId }))
    },
    forCapture: (captureId: string): AnalysisRow[] =>
      this.analysisRows.filter(r => r.captureId === captureId)
        .sort((a, b) => a.analyzer.localeCompare(b.analyzer) || a.version - b.version || a.slot - b.slot || a.metric.localeCompare(b.metric)),
    removeDevice: (captureId: string): void => {
      const keep = this.analysisRows.filter(r => r.captureId !== captureId || r.source !== 'device')
      this.analysisRows.splice(0, this.analysisRows.length, ...keep)
    },
    range: (fromTs: string, toTs: string): AnalysisRow[] =>
      this.analysisRows.filter(r => r.ts >= fromTs && r.ts <= toTs).sort((a, b) => a.ts.localeCompare(b.ts)),
    stats: (): AnalyzerStats[] => {
      const m = new Map<string, AnalyzerStats & { ids: Set<string> }>()
      for (const r of this.analysisRows) {
        const k = `${r.analyzer}@${r.version}@${r.source}`
        const s = m.get(k) ?? { analyzer: r.analyzer, version: r.version, source: r.source, rows: 0, captures: 0, firstTs: r.ts, lastTs: r.ts, ids: new Set<string>() }
        s.rows++
        s.ids.add(r.captureId)
        if (r.ts < s.firstTs) s.firstTs = r.ts
        if (r.ts > s.lastTs) s.lastTs = r.ts
        m.set(k, s)
      }
      return [...m.values()].map(({ ids, ...s }) => ({ ...s, captures: ids.size })).sort((a, b) => a.analyzer.localeCompare(b.analyzer) || a.version - b.version)
    },
  }

  podLabels = {
    set: (input: PodLabelInput): PodLabel => {
      const l: PodLabel = { source: 'picked', suggested: null, suggestedBy: null, suggestedConfidence: null, ...input }
      const k = `${l.captureId}#${l.slot}`
      const was = this.labelRows.get(k)
      const row = was?.plant != null ? { ...l, plant: was.plant, plantedAt: was.plantedAt } : { ...l }
      this.labelRows.set(k, row)
      return { ...row }
    },
    remove: (captureId: string, slot: number): boolean => this.labelRows.delete(`${captureId}#${slot}`),
    forCapture: (captureId: string): PodLabel[] =>
      [...this.labelRows.values()].filter(l => l.captureId === captureId).sort((a, b) => a.slot - b.slot).map(l => ({ ...l })),
    range: (fromTs: string, toTs: string): PodLabel[] =>
      [...this.labelRows.values()].filter(l => l.ts >= fromTs && l.ts <= toTs)
        .sort((a, b) => a.ts.localeCompare(b.ts) || a.captureId.localeCompare(b.captureId) || a.slot - b.slot).map(l => ({ ...l })),
    list: (q: { label?: PodLabelValue, camera?: 'upper' | 'lower', limit: number, before?: PodLabelCursor }): PodLabel[] => {
      // Code-unit order, as SQLite compares text, so both stores page alike.
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
      const order = (a: PodLabelCursor, b: PodLabelCursor) => cmp(b.ts, a.ts) || cmp(b.captureId, a.captureId) || a.slot - b.slot
      const { before } = q
      return [...this.labelRows.values()]
        .filter(l => (!q.label || l.label === q.label) && (!q.camera || l.camera === q.camera) && (!before || order(l, before) > 0))
        .sort(order).slice(0, q.limit).map(l => ({ ...l }))
    },
    counts: (): Record<PodLabelValue, number> => {
      const out = Object.fromEntries(POD_LABELS.map(l => [l, 0])) as Record<PodLabelValue, number>
      for (const l of this.labelRows.values()) out[l.label]++
      return out
    },
    bySource: (): Array<{ source: PodLabelSource, suggestedBy: string | null, n: number }> => {
      const m = new Map<string, { source: PodLabelSource, suggestedBy: string | null, n: number }>()
      for (const l of this.labelRows.values()) {
        const k = `${l.source}#${l.suggestedBy}`
        const c = m.get(k) ?? { source: l.source, suggestedBy: l.suggestedBy, n: 0 }
        c.n++
        m.set(k, c)
      }
      // As SQLite orders them: by text, no suggester first. Keys are unique, so never equal.
      const key = (r: { source: string, suggestedBy: string | null }) => `${r.source}\u0000${r.suggestedBy ?? ''}`
      return [...m.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1))
    },
    lastBefore: (ts: string): PodLabel[] => {
      const m = new Map<number, PodLabel>()
      for (const l of this.labelRows.values()) {
        const had = m.get(l.slot)
        if (l.ts < ts && (!had || l.ts > had.ts || (l.ts === had.ts && l.captureId < had.captureId))) m.set(l.slot, l)
      }
      return [...m.values()].sort((a, b) => a.slot - b.slot).map(l => ({ ...l }))
    },
    captures: (limit = 50): Array<{ captureId: string, ts: string, camera: 'upper' | 'lower', pods: number }> => {
      const m = new Map<string, { captureId: string, ts: string, camera: 'upper' | 'lower', pods: number }>()
      for (const l of this.labelRows.values()) {
        const c = m.get(l.captureId) ?? { captureId: l.captureId, ts: l.ts, camera: l.camera, pods: 0 }
        c.pods++
        m.set(l.captureId, c)
      }
      return [...m.values()].sort((a, b) => b.ts.localeCompare(a.ts) || a.captureId.localeCompare(b.captureId)).slice(0, limit)
    },
  }

  dismissals = {
    dismiss: (d: SuggestionDismissal): SuggestionDismissal => {
      const k = `${d.captureId}#${d.slot}`
      const row = { ...d, dismissedAt: this.dismissalRows.get(k)?.dismissedAt ?? d.dismissedAt }
      this.dismissalRows.set(k, row)
      return { ...row }
    },
    restore: (captureId: string, slot: number): boolean => this.dismissalRows.delete(`${captureId}#${slot}`),
    forCapture: (captureId: string): SuggestionDismissal[] =>
      [...this.dismissalRows.values()].filter(d => d.captureId === captureId).sort((a, b) => a.slot - b.slot).map(d => ({ ...d })),
    range: (fromTs: string, toTs: string): SuggestionDismissal[] =>
      [...this.dismissalRows.values()].filter(d => d.ts >= fromTs && d.ts <= toTs)
        .sort((a, b) => a.ts.localeCompare(b.ts) || a.captureId.localeCompare(b.captureId) || a.slot - b.slot).map(d => ({ ...d })),
  }

  podCodes = {
    pairs: (): PodCodePair[] => [...this.codePairs.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map(p => ({ ...p })),
    pair: (code: string): PodCodePair | null => {
      const p = this.codePairs.get(code)
      return p ? { ...p } : null
    },
    confirm: (code: string, plant: string, ts: string): PodCodePair => {
      const p = { code, plant, confirmedAt: ts }
      this.codePairs.set(code, p)
      return { ...p }
    },
    forget: (code: string): boolean => this.codePairs.delete(code),
    reads: (): PodCodeRead[] => [...this.codeReads.values()].sort((a, b) => a.slot - b.slot).map(r => ({ ...r })),
    setReads: (camera: 'upper' | 'lower', reads: PodCodeRead[]): void => {
      for (const [slot, r] of this.codeReads) if (r.camera === camera) this.codeReads.delete(slot)
      for (const r of reads) this.codeReads.set(r.slot, { ...r, camera })
    },
  }

  automations = {
    list: (): Automation[] => this.automationRows.map(clone),
    get: (id: number): Automation | null => {
      const r = this.automationRows.find(a => a.id === id)
      return r ? clone(r) : null
    },
    create: (rule: Omit<AutomationRule, 'id'>, ts: string): Automation => {
      const r: Automation = { ...clone(rule), id: this.nextAutomationId++, createdAt: ts, updatedAt: ts }
      this.automationRows.push(r)
      return clone(r)
    },
    update: (id: number, patch: Partial<Omit<AutomationRule, 'id'>>, ts: string): Automation | null => {
      const i = this.automationRows.findIndex(a => a.id === id)
      const cur = this.automationRows[i]
      if (!cur) return null
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      const next: Automation = { ...cur, ...clone(defined), updatedAt: ts }
      this.automationRows[i] = next
      return clone(next)
    },
    remove: (id: number): boolean => {
      this.runRows = this.runRows.filter(r => r.automationId !== id)
      const before = this.automationRows.length
      this.automationRows = this.automationRows.filter(a => a.id !== id)
      return this.automationRows.length < before
    },
    addRun: (run: Omit<AutomationRun, 'id'>): void => {
      this.runRows.push({ ...run, id: this.nextRunId++ })
    },
    runs: (q?: { automationId?: number, limit?: number }): AutomationRun[] =>
      this.runRows.filter(r => q?.automationId === undefined || r.automationId === q.automationId).slice().reverse().slice(0, q?.limit ?? 100),
    pruneRuns: (beforeTs: string): number => {
      const before = this.runRows.length
      this.runRows = this.runRows.filter(r => r.firedAt >= beforeTs)
      return before - this.runRows.length
    },
  }

  notifications = {
    channels: {
      list: (): NotificationChannel[] => this.notificationChannels.map(clone),
      get: (id: number): NotificationChannel | null => {
        const r = this.notificationChannels.find(c => c.id === id)
        return r ? clone(r) : null
      },
      create: (ch: Omit<NotificationChannel, 'id' | 'createdAt' | 'updatedAt'>, ts: string): NotificationChannel => {
        const row: NotificationChannel = { ...clone(ch), id: this.nextNotificationChannelId++, createdAt: ts, updatedAt: ts }
        this.notificationChannels.push(row)
        return clone(row)
      },
      update: (id: number, patch: Partial<Omit<NotificationChannel, 'id' | 'createdAt' | 'updatedAt'>>, ts: string): NotificationChannel | null => {
        const i = this.notificationChannels.findIndex(c => c.id === id)
        if (i < 0) return null
        const cur = this.notificationChannels[i]
        if (!cur) return null
        const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
        const next: NotificationChannel = { ...cur, ...clone(defined), updatedAt: ts }
        this.notificationChannels[i] = next
        return clone(next)
      },
      remove: (id: number): boolean => {
        const before = this.notificationChannels.length
        this.notificationChannels = this.notificationChannels.filter(c => c.id !== id)
        return this.notificationChannels.length < before
      },
    },
    rules: {
      list: (): NotificationRule[] => this.notificationRules.map(clone),
      get: (id: number): NotificationRule | null => {
        const r = this.notificationRules.find(x => x.id === id)
        return r ? clone(r) : null
      },
      create: (rule: Omit<NotificationRule, 'id' | 'createdAt' | 'updatedAt'>, ts: string): NotificationRule => {
        const row: NotificationRule = { ...clone(rule), id: this.nextNotificationRuleId++, createdAt: ts, updatedAt: ts }
        this.notificationRules.push(row)
        return clone(row)
      },
      update: (id: number, patch: Partial<Omit<NotificationRule, 'id' | 'createdAt' | 'updatedAt'>>, ts: string): NotificationRule | null => {
        const i = this.notificationRules.findIndex(r => r.id === id)
        if (i < 0) return null
        const cur = this.notificationRules[i]
        if (!cur) return null
        const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
        const next: NotificationRule = { ...cur, ...clone(defined), updatedAt: ts }
        this.notificationRules[i] = next
        return clone(next)
      },
      remove: (id: number): boolean => {
        this.notificationRunRows = this.notificationRunRows.filter(r => r.ruleId !== id)
        const before = this.notificationRules.length
        this.notificationRules = this.notificationRules.filter(r => r.id !== id)
        return this.notificationRules.length < before
      },
    },
    runs: {
      add: (run: Omit<NotificationRun, 'id'>): void => {
        this.notificationRunRows.push({ ...run, id: this.nextNotificationRunId++ })
      },
      list: (q?: { ruleId?: number, limit?: number }): NotificationRun[] =>
        this.notificationRunRows.filter(r => q?.ruleId === undefined || r.ruleId === q.ruleId).slice().reverse().slice(0, q?.limit ?? 100),
      prune: (beforeTs: string): number => {
        const before = this.notificationRunRows.length
        this.notificationRunRows = this.notificationRunRows.filter(r => r.firedAt >= beforeTs)
        return before - this.notificationRunRows.length
      },
    },
    ios: {
      devices: {
        list: (): IosDevice[] => [...this.iosDevices.values()].map(clone),
        get: (deviceId: string): IosDevice | null => {
          const d = this.iosDevices.get(deviceId)
          return d ? clone(d) : null
        },
        upsert: (d: Omit<IosDevice, 'createdAt' | 'updatedAt'>, ts: string): IosDevice => {
          const row: IosDevice = { ...clone(d), createdAt: this.iosDevices.get(d.deviceId)?.createdAt ?? ts, updatedAt: ts }
          this.iosDevices.set(d.deviceId, row)
          return clone(row)
        },
        setToken: (deviceId: string, token: string | null, ts: string): void => {
          const d = this.iosDevices.get(deviceId)
          if (d) this.iosDevices.set(deviceId, { ...d, token, updatedAt: ts })
        },
        remove: (deviceId: string): boolean => this.iosDevices.delete(deviceId),
      },
      activityTokens: {
        list: (): ActivityToken[] => this.activityTokenRows.map(clone),
        upsert: (t: Omit<ActivityToken, 'updatedAt'>, ts: string): void => {
          this.activityTokenRows = this.activityTokenRows.filter(r => !(r.deviceId === t.deviceId && r.kind === t.kind && (t.kind === 'start' || r.activityId === t.activityId)))
          this.activityTokenRows.push({ ...clone(t), updatedAt: ts })
        },
        removeToken: (token: string): void => {
          this.activityTokenRows = this.activityTokenRows.filter(r => r.token !== token)
        },
        removeKind: (kind: ActivityToken['kind']): void => {
          this.activityTokenRows = this.activityTokenRows.filter(r => r.kind !== kind)
        },
        removeDevice: (deviceId: string): void => {
          this.activityTokenRows = this.activityTokenRows.filter(r => r.deviceId !== deviceId)
        },
      },
      feed: {
        add: (item: Omit<FeedItem, 'id'>): FeedItem => {
          const row: FeedItem = { ...clone(item), id: this.nextFeedId++ }
          this.feedRows.push(row)
          return clone(row)
        },
        after: (afterId: number, limit: number): FeedItem[] => this.feedRows.filter(r => r.id > afterId).slice(0, limit).map(clone),
        latestId: (): number | null => this.feedRows.at(-1)?.id ?? null,
        prune: (keep: number): void => {
          if (this.feedRows.length > keep) this.feedRows = this.feedRows.slice(-keep)
        },
      },
    },
  }

  tankActions = {
    add: (a: Omit<TankAction, 'id' | 'createdAt'>, createdAt: string): TankAction => {
      const row = { ...a, id: this.nextTankId++, createdAt }
      this.tankRows.push(row)
      return row
    },
    list: (q?: { kind?: TankActionKind, limit?: number }): TankAction[] =>
      this.tankRows.filter(r => !q?.kind || r.kind === q.kind).sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id).slice(0, q?.limit ?? 100),
    remove: (id: number): boolean => {
      const i = this.tankRows.findIndex(r => r.id === id)
      if (i < 0) return false
      this.tankRows.splice(i, 1)
      return true
    },
  }

  plans = {
    list: (): PlanRow[] => [...this.planRows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    get: (id: string): PlanRow | null => this.planRows.get(id) ?? null,
    save: (p: Omit<PlanRow, 'createdAt' | 'updatedAt' | 'appliedAt' | 'issued'>): PlanRow => {
      const now = new Date().toISOString()
      const prev = this.planRows.get(p.id)
      const row: PlanRow = { ...p, createdAt: prev?.createdAt ?? now, updatedAt: now, appliedAt: prev?.appliedAt ?? null, issued: prev?.issued ?? [] }
      this.planRows.set(p.id, row)
      return row
    },
    remove: (id: string): boolean => this.planRows.delete(id),
    markApplied: (id: string, ts: string): PlanRow | null => {
      const r = this.planRows.get(id)
      if (!r) return null
      r.appliedAt = ts
      return r
    },
    markIssued: (id: string, key: string): void => {
      const r = this.planRows.get(id)
      if (r && !r.issued.includes(key)) r.issued.push(key)
    },
  }

  close(): void {
    // nothing to release
  }
}

/** Keep at most `max` points by uniform stride (good enough for charts). */
export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const stride = rows.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * stride)] as T)
  return out
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export function qualityCounts(rows: QualitySample[]) {
  let good = 0
  let suspect = 0
  for (const row of rows) {
    if (row.quality === 'good') good++
    if (row.quality === 'suspect') suspect++
  }
  return { samples: rows.length, good, suspect }
}

export function trustedShareOf(counts: { samples: number, good: number }, windowS: number) {
  const { samples, good } = counts
  return {
    trustedPct: samples ? Math.round((good / samples) * 1000) / 10 : null,
    samples,
    trusted: good,
    hours: windowS / 3600,
  }
}
