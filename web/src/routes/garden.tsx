import { createFileRoute } from '@tanstack/react-router'
import { GARDEN_TABS, GardenPage, type GardenTab } from '@/src/components/Garden/GardenPage'

export const Route = createFileRoute('/garden')({
  component: GardenRoute,
  validateSearch: (search: Record<string, unknown>): { tab?: GardenTab, slot?: number } => {
    const tab = GARDEN_TABS.find(t => t.value === search.tab)?.value
    const slot = Number(search.slot)
    return { tab, ...(Number.isInteger(slot) && slot > 0 && slot <= 60 ? { slot } : {}) }
  },
})

function GardenRoute() {
  return <GardenPage {...Route.useSearch()} />
}
