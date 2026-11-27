import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('imports observer evidence into Activity and exports an incident report', async ({ page }) => {
  await page.goto('/garden')
  await expect(page.getByRole('heading', { name: 'Garden Activity' })).toBeVisible()
  await page.getByText('Add off-device observer logs').click()
  const bad = { result: 'timeout' }
  const ok = { result: 'ok' }
  const log = [
    { ts: new Date(Date.now() - 120_000).toISOString(), host: '10.10.20.202', core: bad, hald: ok, ssh: ok },
    { ts: new Date(Date.now() - 60_000).toISOString(), host: '10.10.20.202', core: ok, hald: ok, ssh: ok },
  ].map(row => JSON.stringify(row)).join('\n')
  await page.getByLabel('Observer logs').setInputFiles({ name: 'field.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(log) })
  await expect(page.getByText('Core unreachable, HAL and SSH responding')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download incident report' }).click()
  const path = await (await download).path()
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ format: 'thryve-incident-v1', observerSamples: 2 })
  await page.getByRole('button', { name: 'Clear logs' }).click()
  await expect(page.getByText('Core unreachable, HAL and SSH responding')).toHaveCount(0)
})

test('opens a planted yCube from Grow and keeps the same history after its move', async ({ page, request }) => {
  const pod = 29
  const dest = 30
  const empty = { status: 'empty', plant: null, plantedAt: null, notes: '' }
  await request.patch('/api/pods/' + pod, { data: empty })
  await request.patch('/api/pods/' + dest, { data: empty })
  try {
    const sowed = await request.patch('/api/pods/' + pod, { data: { status: 'growing', plant: 'Rosemary', plantedAt: new Date().toISOString().slice(0, 10), notes: 'Checked the roots' } })
    expect(sowed.ok()).toBe(true)
    await page.goto('/grow?pod=' + pod)
    await page.getByRole('link', { name: 'Open plant history' }).click()
    await expect(page.getByRole('button', { name: 'Rosemary · Pod 29' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('list', { name: 'Plant events' })).toContainText('Checked the roots')
    const moved = await request.post('/api/pods/swap', { data: { a: pod, b: dest } })
    expect(moved.ok()).toBe(true)
    await page.goto('/garden?tab=plants&slot=' + dest)
    await expect(page.getByRole('button', { name: 'Rosemary · Pod 30' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('list', { name: 'Plant events' })).toContainText('Moved · Pod 29 to pod 30')
    await expect(page.getByRole('list', { name: 'Plant events' })).toContainText('Checked the roots')
  }
  finally {
    await request.patch('/api/pods/' + pod, { data: empty })
    await request.patch('/api/pods/' + dest, { data: empty })
  }
})

test('shows the trip check and opens local vision review from Analysis', async ({ page }) => {
  await page.goto('/garden?tab=readiness')
  await expect(page.getByRole('heading', { name: 'Ready to leave?' })).toBeVisible()
  await expect(page.getByText('Tank runway')).toBeVisible()
  await expect(page.getByText('Last completed pump run')).toBeVisible()
  await page.getByRole('button', { name: 'Check this trip' }).click()
  await expect(page.getByText('Choose a return time in the next seven days.')).toBeVisible()
  await page.goto('/analysis?tab=methods')
  await page.getByRole('link', { name: 'Review off-device comparisons' }).click()
  await expect(page.getByRole('heading', { name: 'Local vision review' })).toBeVisible()
})
