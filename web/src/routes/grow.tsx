import { createFileRoute } from '@tanstack/react-router'
import { GrowPage, isGrowTab, type GrowTab } from '@/src/components/Grow/GrowPage'

/** `?pod=N` opens that pod in the side panel (Home links here). */
export const Route = createFileRoute('/grow')({
  component: GrowRoute,
  validateSearch: (search: Record<string, unknown>): { pod?: number, tab?: GrowTab } => {
    const pod = typeof search.pod === 'number' || typeof search.pod === 'string' ? Number(search.pod) : Number.NaN
    return {
      ...(Number.isInteger(pod) && pod > 0 && pod <= 60 ? { pod } : {}),
      ...(isGrowTab(search.tab) ? { tab: search.tab } : {}),
    }
  },
})

function GrowRoute() {
  const { tab, pod } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <GrowPage tab={tab} pod={pod} onTabChange={next => void navigate({ search: { tab: next, pod: next === 'pods' ? pod : undefined } })} />
}
