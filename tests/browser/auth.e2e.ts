import { networkInterfaces } from 'node:os'
import { expect, test } from '@playwright/test'

/** A non-loopback IPv4 the e2e server (0.0.0.0:3218) should already be listening on. */
function lanOrigin(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      const family = String(a.family)
      if ((family === 'IPv4' || family === '4') && !a.internal) return `http://${a.address}:3218`
    }
  }
  return null
}

const mcpInit = (key?: string) => ({
  method: 'POST' as const,
  headers: {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    ...(key ? { 'x-api-key': key } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }),
})

test('the web UI on the LAN stays open when an MCP access key is set', async ({ page, request }) => {
  const origin = lanOrigin()
  test.skip(!origin, 'no non-loopback address to exercise LAN access')

  await request.patch('/api/settings', { data: { apiKey: 'e2e-mcp-key' } })
  try {
    await page.goto(`${origin}/`)
    await expect(page.getByTestId('tower-3d')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('auth-login')).toHaveCount(0)
    await expect(page.getByText('Sign in to this unit')).toHaveCount(0)

    await page.goto(`${origin}/settings#api`)
    await expect(page.getByRole('heading', { name: 'MCP access' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/MCP clients must send/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  }
  finally {
    await request.patch('/api/settings', { data: { apiKey: '' } })
  }
})

test('/api/mcp from the LAN returns 401 without the key and works with it', async ({ request }) => {
  const origin = lanOrigin()
  test.skip(!origin, 'no non-loopback address to exercise the MCP access key')

  await request.patch('/api/settings', { data: { apiKey: 'e2e-mcp-key' } })
  try {
    const denied = await fetch(`${origin}/api/mcp`, mcpInit())
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ code: 'api_key_required' })

    const ok = await fetch(`${origin}/api/mcp`, mcpInit('e2e-mcp-key'))
    expect(ok.status).toBe(200)
    const body = await ok.json() as { result?: { serverInfo?: { name?: string } } }
    expect(body.result?.serverInfo?.name).toBe('Thryve')

    // The rest of the API on the same LAN address stays open.
    const health = await fetch(`${origin}/api/healthcheck`)
    expect(health.status).toBe(200)
  }
  finally {
    await request.patch('/api/settings', { data: { apiKey: '' } })
  }
})
