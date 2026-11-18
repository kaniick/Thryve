// @vitest-environment jsdom
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * /sensors must be a layout with an Outlet. If the list is the parent route's
 * only component, /sensors/$id matches but still shows the list (v2.2.2).
 */
function tree() {
  const root = createRootRoute({ component: Outlet })
  const sensors = createRoute({ getParentRoute: () => root, path: '/sensors', component: Outlet })
  const index = createRoute({ getParentRoute: () => sensors, path: '/', component: () => <div data-testid="sensors-list">list</div> })
  const history = createRoute({ getParentRoute: () => sensors, path: '$id', component: () => <div data-testid="sensor-history">history</div> })
  return createRouter({
    routeTree: root.addChildren([sensors.addChildren([index, history])]),
    history: createMemoryHistory({ initialEntries: ['/sensors/air_temp'] }),
  })
}

afterEach(cleanup)

describe('the sensors history route', () => {
  it('renders the history view at /sensors/$id, not the list', async () => {
    render(<RouterProvider router={tree()} />)
    expect(await screen.findByTestId('sensor-history')).toBeTruthy()
    expect(screen.queryByTestId('sensors-list')).toBeNull()
  })
})
