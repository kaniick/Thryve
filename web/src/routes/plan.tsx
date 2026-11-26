import { createFileRoute } from '@tanstack/react-router'
import { PlanPage } from '@/src/components/Plan/PlanPage'
import { getPlant } from '@/src/plants/catalog'

export const Route = createFileRoute('/plan')({
  validateSearch: (search: Record<string, unknown>): { plant?: string } => {
    const plant = typeof search.plant === 'string' ? getPlant(search.plant) : undefined
    return plant ? { plant: plant.id } : {}
  },
  component: PlanRoute,
})

function PlanRoute() {
  const { plant } = Route.useSearch()
  return <PlanPage catalogPlant={plant ? getPlant(plant)?.name : undefined} />
}
