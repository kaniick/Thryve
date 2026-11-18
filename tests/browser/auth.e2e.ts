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

test('the web UI asks for an API key from the LAN and stays signed in after login', async ({ page, request }) => {
  const origin = lanOrigin()
  test.skip(!origin, 'no non-loopback address to exercise the API-key guard')

  // Loopback is exempt, so this setup request does not need a key.
  await request.patch('/api/settings', { data: { apiKey: 'e2e-sekret-key' } })
  try {
    await page.goto(`${origin}/`)
    await expect(page.getByTestId('auth-login')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Sign in to this unit')).toBeVisible()
    await page.getByLabel('API key').fill('e2e-sekret-key')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByTestId('tower-3d')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('auth-login')).toHaveCount(0)

    await page.goto(`${origin}/settings`)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByTestId('auth-login')).toBeVisible()
  }
  finally {
    await request.patch('/api/settings', { data: { apiKey: '' } })
  }
})

test('saving a new API key from the LAN keeps this browser signed in', async ({ page, request }) => {
  const origin = lanOrigin()
  test.skip(!origin, 'no non-loopback address to exercise the API-key guard')

  await request.patch('/api/settings', { data: { apiKey: '' } })
  try {
    await page.goto(`${origin}/settings`)
    await expect(page.getByRole('button', { name: 'Generate API key' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Generate API key' }).click()
    await expect(page.getByTestId('api-key-warning')).toBeVisible()
    const key = await page.getByRole('textbox', { name: 'API key' }).inputValue()
    expect(key).toMatch(/^[0-9a-f]{48}$/)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/unsaved/)).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Generate API key' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('auth-login')).toHaveCount(0)
    expect(key).toBeTruthy()
  }
  finally {
    await request.patch('/api/settings', { data: { apiKey: '' } })
  }
})
