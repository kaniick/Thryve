import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const shots = resolve('/workspace/brand')

test('notifications: add a channel, open the rule editor, capture the UI', async ({ page }) => {
  mkdirSync(shots, { recursive: true })
  await page.goto('/notifications')
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
  await expect(page.getByText('No channels yet')).toBeVisible()

  await page.getByRole('button', { name: 'Add channel' }).click()
  const ch = page.getByRole('dialog', { name: 'Add channel' })
  await ch.getByLabel('Name').fill('Phone')
  await ch.getByLabel('User key').fill('userkey-for-e2e-only')
  await ch.getByLabel('Application API token').fill('apptoken-for-e2e-only')
  await ch.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId(/^channel-/).filter({ hasText: 'Phone' })).toBeVisible()
  // Secrets must never appear in the page after save.
  await expect(page.getByText('userkey-for-e2e-only')).toHaveCount(0)

  await page.screenshot({ path: `${shots}/preview-notify-channels.png`, fullPage: true })

  await page.getByRole('button', { name: 'Pump fault' }).click()
  const dlg = page.getByRole('dialog', { name: 'New rule' })
  await expect(dlg.getByLabel('Rule preview')).toBeVisible()
  await expect(dlg.getByLabel('Rule preview')).toContainText('pump fault')
  await page.screenshot({ path: `${shots}/preview-notify-rule-editor.png`, fullPage: true })
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId(/^notify-rule-/).filter({ hasText: 'Pump fault' })).toBeVisible()
  const row = page.getByTestId(/^notify-rule-/).filter({ hasText: 'Pump fault' })
  await expect(row.getByLabel('Pump fault enabled')).toHaveAttribute('aria-checked', 'false')

  await page.goto('/settings#notifications')
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
})
