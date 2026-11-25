// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MaintenanceSection, secureMaintenanceLocation } from '../MaintenanceSection'

const ready = { configured: true, busy: false, version: 'test@one', coreUptimeS: 150, hostUptimeS: 18000, halOnline: true, pump: 'off', dosing: false, maxLagMs: 42, bootLog: true }
const key = 'a'.repeat(64)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('only allows key entry over HTTPS or a localhost tunnel', () => {
  for (const available of ['https://thryve.example', 'http://localhost:13000', 'http://127.0.0.1:13000']) expect(secureMaintenanceLocation(new URL(available))).toBe(true)
  expect(secureMaintenanceLocation(new URL('http://10.10.20.202'))).toBe(false)
})

it.each(['Restart Core', 'Reboot Pi'] as const)('confirms %s with the owner key and reports that it was queued', async (name) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(ready)).mockResolvedValueOnce(Response.json({ queued: true }, { status: 202 }))
  vi.stubGlobal('fetch', fetcher)
  render(<MaintenanceSection />)
  const button = screen.getByRole('button', { name }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  expect(screen.getByText('42 ms')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Download boot log' }).getAttribute('href')).toBe('/api/system/boot-log')
  fireEvent.click(button)
  const dialog = within(screen.getByRole('dialog', { name }))
  const confirm = dialog.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.change(dialog.getByLabelText('Owner maintenance key'), { target: { value: key } })
  fireEvent.click(confirm)
  await waitFor(() => expect(screen.getByText(new RegExp(`${name} queued`))).toBeTruthy())
  expect(fetcher).toHaveBeenLastCalledWith(name === 'Reboot Pi' ? '/api/maintenance/reboot' : '/api/maintenance/restart-core', expect.objectContaining({
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
  }))
  expect(screen.queryByLabelText('Owner maintenance key')).toBeNull()
})

it('keeps both controls disabled while the pump is running', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...ready, pump: 'running' }))
  vi.stubGlobal('fetch', fetcher)
  render(<MaintenanceSection />)
  await screen.findByText('Wait until watering and dosing finish.')
  for (const name of ['Restart Core', 'Reboot Pi']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  expect(fetcher).toHaveBeenCalledOnce()
})
