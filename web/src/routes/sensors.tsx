import { createFileRoute, Outlet } from '@tanstack/react-router'

/** Layout so /sensors/$id can render the history view instead of the list. */
export const Route = createFileRoute('/sensors')({
  component: function SensorsLayout() {
    return <Outlet />
  },
})
