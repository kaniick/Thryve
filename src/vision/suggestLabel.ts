/**
 * The tagger's suggested label for one pod in one photo (#261). A pod's state
 * changes slowly, so its last label on an earlier photo carries forward; the
 * pod-state model overrides that only when it names a later stage with
 * confidence ≥ 0.8. With no earlier label a confident model's guess stands on
 * its own; with neither there is no suggestion. The model has no `seeded`
 * class, so a `seeded` pod record turns an `empty` suggestion into `seeded`.
 * A suggestion is never a label: it is saved only when the grower accepts or
 * corrects it.
 */
import type { PodLabelValue, PodStatus } from '../store/types'

/** The least confidence at which the model's guess is suggested. */
export const SUGGEST_CONFIDENCE = 0.8
/** Growth stages in order; `unhealthy` is not a stage, so it is never later than anything. */
const STAGES: PodLabelValue[] = ['empty', 'seeded', 'sprouted', 'growing', 'ready']
const LABELS = new Set<string>([...STAGES, 'unhealthy'])

export interface SuggestInput {
  /** The pod's sowing date (`YYYY-MM-DD…`) when its record describes this photo, else null. */
  plantedAt: string | null
  /** The pod record's status, on the same terms. */
  status: PodStatus | null
  /** The pod's newest label on an earlier photo: its photo's time and local day, and the sowing date it was saved with. */
  last: { label: PodLabelValue, ts: string, day: string, plantedAt: string | null } | null
  /** The model's most likely state for this photo, and which model (`pod-state@<version>`). */
  model: { state: string, confidence: number, by: string } | null
}

export interface Suggestion {
  label: PodLabelValue
  /** `carry`, `record` or the model's `pod-state@<version>`. */
  by: string
  /** The model's confidence, when the model made the suggestion. */
  confidence: number | null
  /** The carried label's photo time. */
  from: string | null
}

const later = (a: PodLabelValue, b: PodLabelValue) => STAGES.includes(a) && STAGES.includes(b) && STAGES.indexOf(a) > STAGES.indexOf(b)

/**
 * Whether a label is from the pod's current planting: it was saved with the
 * same sowing date, or with none and on or after the sowing day. A label from
 * before a replant never carries.
 */
function samePlanting(last: NonNullable<SuggestInput['last']>, plantedAt: string | null): boolean {
  if (last.plantedAt !== null) return last.plantedAt === plantedAt
  return plantedAt === null || last.day >= plantedAt.slice(0, 10)
}

export function suggestLabel(i: SuggestInput): Suggestion | null {
  const carry: Suggestion | null = i.last && samePlanting(i.last, i.plantedAt) ? { label: i.last.label, by: 'carry', confidence: null, from: i.last.ts } : null
  const m = i.model
  const model: Suggestion | null = m && m.confidence >= SUGGEST_CONFIDENCE && LABELS.has(m.state)
    ? { label: m.state as PodLabelValue, by: m.by, confidence: m.confidence, from: null }
    : null
  const pick = carry ? (model && later(model.label, carry.label) ? model : carry) : model
  if (pick?.label === 'empty' && i.status === 'seeded') return { label: 'seeded', by: 'record', confidence: null, from: null }
  return pick
}
