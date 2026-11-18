// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { AuthGate } from '../AuthGate'
import { UNAUTHORIZED_EVENT } from '@/src/utils/authEvents'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function renderGate(child: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AuthGate>
        {child}
      </AuthGate>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
})

beforeEach(() => {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ required: false, signedIn: true }) })
})

describe('AuthGate', () => {
  it('renders the app when no API key is required', async () => {
    renderGate(<div>dashboard</div>)
    await waitFor(() => expect(screen.getByText('dashboard')).toBeTruthy())
  })

  it('asks for the API key when one is set and this browser has no session', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ required: true, signedIn: false }) })
    renderGate(<div>dashboard</div>)
    await waitFor(() => expect(screen.getByTestId('auth-login')).toBeTruthy())
    expect(screen.queryByText('dashboard')).toBeNull()
    expect(screen.getByText(/Sign in to this unit/)).toBeTruthy()
  })

  it('shows a 401-specific unreachable screen when core cannot be reached, not just after a key is set', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    renderGate(<div>dashboard</div>)
    await waitFor(() => expect(screen.getByText(/This unit isn't reachable/)).toBeTruthy())
    expect(screen.queryByText('dashboard')).toBeNull()
    expect(screen.getByText(/scripts\/thryve-clear-api-key/)).toBeTruthy()
  })

  it('signs in with the entered key and then shows the app', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ required: true, signedIn: false }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, required: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ required: true, signedIn: true }) })
    renderGate(<div>dashboard</div>)
    await waitFor(() => expect(screen.getByTestId('auth-login')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sekret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByText('dashboard')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith('/api/login', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ apiKey: 'sekret' }),
    }))
  })

  it('opens the sign-in screen when a later request is unauthorized', async () => {
    renderGate(<div>dashboard</div>)
    await waitFor(() => expect(screen.getByText('dashboard')).toBeTruthy())
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ required: true, signedIn: false }) })
    act(() => {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    })
    await waitFor(() => expect(screen.getByTestId('auth-login')).toBeTruthy())
  })
})
