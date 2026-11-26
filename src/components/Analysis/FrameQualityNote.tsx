import { trpc } from '@/src/utils/trpc'

const STATUS = {
  'scored': 'Frame scored',
  'dark': 'Dark frame · review scores cautiously',
  'damaged': 'Damaged frame · not usable for scoring',
  'unreadable': 'Frame couldn’t be read for scoring',
  'failed': 'Scoring failed for this frame',
  'no-result': 'No scores from this frame',
  'unchecked': 'Quality not yet recorded',
  'missing': 'Frame no longer available',
}

export function FrameQualityNote({ id, historical = false }: { id: string, historical?: boolean }) {
  const q = trpc.vision.frameQuality.useQuery({ captureId: id })
  const data = q.data
  if (!data) return null
  return (
    <span className={data.status === 'scored' && (!data.stale || historical) ? 'text-fg-3' : 'text-pod-attention'} aria-label="Frame quality">
      {[
        data.stale && !historical && 'Stale photo',
        STATUS[data.status],
        data.missingBoxes.length > 0 && `No box for pods ${data.missingBoxes.join(', ')}`,
        data.uncertain.length > 0 && `Low-confidence state for pods ${data.uncertain.join(', ')}`,
      ].filter(Boolean).join(' · ')}
    </span>
  )
}
