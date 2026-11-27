// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GardenPage } from '../GardenPage'

const api = vi.hoisted(() => ({
  activity: vi.fn(),
  plants: vi.fn(),
  plant: vi.fn(),
  readiness: vi.fn(),
  vision: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}))
vi.mock('@/src/utils/trpc', () => ({
  apiBase: () => '',
  trpc: { garden: {
    activity: { useQuery: api.activity }, plants: { useQuery: api.plants }, plant: { useQuery: api.plant },
    readiness: { useQuery: api.readiness }, visionReview: { useQuery: api.vision },
  } },
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

const at = '2026-11-27T02:00:00.000Z'
const earlier = '2026-11-27T01:59:00.000Z'
const data = (d: unknown) => ({ data: d, refetch: vi.fn() })

it('imports external evidence, filters the list, and exposes a one-click export', async () => {
  api.activity.mockReturnValue(data({ checkedAt: at, days: 2, entries: [{ at, key: 'boot-1', title: 'Core started', kind: 'restart', detail: 'dev', attention: false }] }))
  render(<GardenPage />)
  expect(screen.getByText('Core started')).toBeTruthy()
  const file = new File([], 'outage.jsonl')
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ ts: earlier, host: '10.10.20.202', core: { result: 'timeout' }, hald: { result: 'ok' }, ssh: { result: 'ok' } }) })
  fireEvent.change(screen.getByLabelText('Observer logs'), { target: { files: [file] } })
  await waitFor(() => expect(screen.getByText('Core unreachable, HAL and SSH responding')).toBeTruthy())
  fireEvent.click(screen.getByLabelText('Needs attention'))
  expect(screen.queryByText('Core started')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear logs' }))
  expect(screen.queryByText('Core unreachable, HAL and SSH responding')).toBeNull()
  expect(screen.getByRole('button', { name: 'Download incident report' })).toBeTruthy()
})

it('deep-links to the journal for a physical slot and shows the prior pod move and notes', () => {
  const life = { id: 2, plant: 'Rosemary', plantedAt: '2026-11-22', slot: 24, startedAt: earlier, endedAt: null }
  api.plants.mockReturnValue(data({ active: [{ ...life, id: 1, slot: 2, plant: 'Basil' }, life], archive: [], next: null }))
  api.plant.mockReturnValue(data({ life, visits: [], visitsOmitted: 0, events: [{ id: 1, lifeId: 2, at: earlier, kind: 'moved', fromSlot: 9, slot: 24, note: 'Root check' }] }))
  render(<GardenPage tab="plants" slot={24} />)
  expect(api.plant).toHaveBeenCalledWith({ id: 2 }, { enabled: true })
  expect(screen.getByRole('button', { name: 'Rosemary · Pod 24' }).getAttribute('aria-pressed')).toBe('true')
  const journal = within(screen.getByRole('list', { name: 'Plant events' }))
  expect(journal.getByText('Moved · Pod 9 to pod 24')).toBeTruthy()
  expect(journal.getByText('Root check')).toBeTruthy()
})

it('displays unknown tank runway and refuses an empty return date', () => {
  api.readiness.mockReturnValue(data({ checkedAt: at, until: at, state: 'unknown', tank: { levelPct: null, hoursToTarget: null, reason: 'Tank reading stale' },
    watering: { lastCompleted: null }, cameras: [], chores: [], checks: ['Tank reading stale'] }))
  render(<GardenPage tab="readiness" />)
  expect(screen.getByRole('status').textContent).toBe('Not enough evidence to call it ready')
  expect(screen.getByText('unknown')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Check this trip' }))
  expect(screen.getByText('Choose a return time in the next seven days.')).toBeTruthy()
})

it('renders paired photos and lets the operator compare a different worker revision', () => {
  const method = { analyzer: 'utility-green', version: 2 }
  const photo = { id: 'new', ts: at, camera: 'upper', slot: 2, url: '/api/captures/new.jpg', box: null }
  api.vision.mockReturnValue(data({ selected: method, methods: [method, { ...method, version: 1 }], items: [
    { slot: 2, plant: 'Basil', deviceCover: 0.3, workerCover: 0.6, photo, before: { ...photo, id: 'old', ts: earlier } },
  ] }))
  render(<GardenPage tab="vision" />)
  expect(screen.getAllByRole('img')).toHaveLength(2)
  expect(screen.getByText('On device 30% · Off device 60%')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Off-device method'), { target: { value: 'utility-green@1' } })
  expect(api.vision).toHaveBeenLastCalledWith({ analyzer: 'utility-green', version: 1 })
})
