import { useQuery } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds/core'
import { TextField } from '@/src/components/ds/forms'
import { UNAUTHORIZED_EVENT } from '@/src/utils/authEvents'
import { apiBase, queryClient } from '@/src/utils/trpc'

type Gate = 'loading' | 'ok' | 'login' | 'unreachable'

interface AuthStatus { required: boolean, signedIn: boolean }

async function readStatus(): Promise<Gate> {
  try {
    const r = await fetch(`${apiBase()}/api/auth/status`, { credentials: 'include' })
    if (!r.ok) return 'unreachable'
    const status = await r.json() as AuthStatus
    return status.required && !status.signedIn ? 'login' : 'ok'
  }
  catch {
    return 'unreachable'
  }
}

/**
 * The unit's SPA loads without an API key (HTML is unauthenticated). When a
 * key is set, tRPC/images would 401 from the LAN; this gate asks for the key
 * and stores a session cookie, or shows a 401-specific screen instead of
 * "core unreachable".
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const demo = import.meta.env.VITE_DEMO === '1'
  const [forcedLogin, setForcedLogin] = useState(false)
  const [down, setDown] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: readStatus,
    enabled: !demo,
    retry: false,
  })

  useEffect(() => {
    const onDenied = () => {
      setDown(false)
      setForcedLogin(true)
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onDenied)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onDenied)
  }, [])

  const refresh = async () => {
    setForcedLogin(false)
    setDown(false)
    const result = await status.refetch()
    if (result.data === 'ok') setError(null)
  }

  const login = async (e: FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const r = await fetch(`${apiBase()}/api/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      })
      if (!r.ok) {
        setError(r.status === 401 ? 'That key is not the one saved on this unit.' : 'Could not sign in. Try again.')
        setForcedLogin(true)
        return
      }
      setKey('')
      await queryClient.invalidateQueries()
      await refresh()
    }
    catch {
      setError('Could not reach the unit. Check that it is powered on and on the network.')
      setForcedLogin(false)
      setDown(true)
    }
    finally {
      setPending(false)
    }
  }

  const gate: Gate = demo
    ? 'ok'
    : down
      ? 'unreachable'
      : forcedLogin
        ? 'login'
        : status.isPending
          ? 'loading'
          : (status.data ?? 'unreachable')

  if (gate === 'ok') return children

  if (gate === 'loading') {
    return (
      <div className="mx-auto flex max-w-[480px] flex-col gap-2 pt-16 text-sm text-fg-2" data-testid="auth-loading">
        Connecting…
      </div>
    )
  }

  if (gate === 'unreachable') {
    return (
      <div className="mx-auto flex max-w-[520px] flex-col gap-4 pt-16">
        <Card>
          <CardHeader title="This unit isn't reachable" subtitle="The web app loaded, but it could not talk to core on this address. If you just set an API key, you should see a sign-in screen instead of this. Power-cycling does not clear a key." />
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-sm text-fg-2">
              If you are locked out after saving an API key, SSH into the unit and run
              {' '}
              <code className="font-mono text-xs">/opt/thryve/scripts/thryve-clear-api-key</code>
              , then refresh.
            </p>
            <Button onClick={() => {
              void refresh()
            }}
            >
              Try again
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-[520px] flex-col gap-4 pt-16">
      <h1 className="text-2xl font-medium">Sign in to this unit</h1>
      <p className="text-sm text-fg-2">
        An API key is set on this unit. Enter it to use the web UI. Scripts, REST, MCP and Home Assistant still send the key as
        {' '}
        <span className="font-mono text-xs">X-API-Key</span>
        {' '}
        or a Bearer token — this sign-in is only for the browser.
      </p>
      <Card>
        <CardHeader title="API key" icon={KeyRound} subtitle="The same key you generated in Settings." />
        <form
          className="mt-3 flex flex-col items-start gap-3"
          onSubmit={(e) => {
            void login(e)
          }}
          data-testid="auth-login"
        >
          <TextField aria-label="API key" className="w-full" type="password" value={key} onChange={setKey} placeholder="Paste the API key" autoComplete="off" />
          {error && <InlineError>{error}</InlineError>}
          <Button variant="primary" type="submit" disabled={pending || !key.trim()}>{pending ? 'Signing in…' : 'Sign in'}</Button>
        </form>
      </Card>
      <p className="text-xs text-fg-3">
        Locked out? SSH into the unit and run
        {' '}
        <code className="font-mono">/opt/thryve/scripts/thryve-clear-api-key</code>
        .
      </p>
    </div>
  )
}

export async function logoutSession(): Promise<void> {
  await fetch(`${apiBase()}/api/logout`, { method: 'POST', credentials: 'include' })
  queryClient.clear()
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}
