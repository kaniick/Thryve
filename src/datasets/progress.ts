export const EXPORT_STATES = ['preparing', 'ready', 'downloading', 'sent', 'cancelled', 'error'] as const
export interface DatasetProgress {
  id: string
  state: typeof EXPORT_STATES[number]
  analyses: number
  telemetry: number
  bytes: number
  error: string | null
}
