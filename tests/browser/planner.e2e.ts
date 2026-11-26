import { expect, test } from '@playwright/test'

// Applying a plan seeds pods and starts a grow cycle; put both back so later tests start from an empty tower.
test.afterEach(async ({ request }) => {
  const pods = await (await request.get('/api/pods')).json() as { slot: number, status: string }[]
  for (const p of pods.filter(x => x.status !== 'empty')) await request.patch(`/api/pods/${p.slot}`, { data: { plant: null, plantedAt: null, status: 'empty', notes: '' } })
  const end = await request.post('/api/grow/end', { headers: { 'content-type': 'application/json' } })
  expect(end.ok(), await end.text()).toBe(true)
})

test('plan: add plants, see the zone layout, save and apply onto the pods', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByText('High 12')).toBeVisible()
  const search = page.getByPlaceholder('Search basil, kale, pepper…')
  await search.fill('Basil')
  await page.getByRole('button', { name: 'Add Basil', exact: true }).click()
  await search.fill('Mint')
  await page.getByRole('button', { name: 'Add Mint', exact: true }).click()
  await expect(page.getByText(/^2 planned/)).toBeVisible()
  await expect(page.getByText(/sow \d{4}-\d{2}-\d{2} → harvest/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Save plan' }).click()
  const card = page.getByRole('group', { name: 'My plan' }).first()
  await expect(card.getByRole('list', { name: 'Plants in My plan' })).toHaveText(/Basil.*Mint/)
  await card.getByRole('button', { name: 'Apply to tower' }).click()
  await expect(page.getByRole('dialog')).toContainText('2 pods marked seeded today.')
  await page.getByRole('dialog').getByRole('button', { name: 'Apply to tower' }).click()
  await expect(page.getByText(/Applied: 2 pods seeded/)).toBeVisible()
  const pods = await (await page.request.get('/api/pods')).json() as { plant: string | null, status: string }[]
  const seeded = pods.filter(p => p.status === 'seeded').map(p => p.plant)
  expect(seeded).toEqual(expect.arrayContaining(['Basil', 'Mint']))
})

test('plan: opens on the 3D tower, and the 2D grid is remembered and never loads the tower renderer', async ({ page }) => {
  await page.goto('/plan')
  await expect(page.getByTestId('tower-3d')).toBeVisible()
  await page.getByRole('tab', { name: '2D' }).click()
  await expect(page.getByTestId('plan-grid')).toBeVisible()
  const scripts: string[] = []
  page.on('request', r => r.url().endsWith('.js') && scripts.push(r.url()))
  await page.reload()
  await expect(page.getByTestId('plan-grid')).toBeVisible()
  await expect(page.getByRole('tab', { name: '2D' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('tower-3d')).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(scripts.filter(u => /towerRenderer/.test(u))).toEqual([])
})

test('plan: reviews a physical pod move on the layout and writes it only on confirmation', async ({ page }) => {
  expect((await page.request.patch('/api/pods/1', { data: { plant: 'Basil', status: 'growing' } })).ok()).toBe(true)
  const readPod = async (slot: number) => {
    const pods = await (await page.request.get('/api/pods')).json() as { slot: number, plant: string | null }[]
    return pods.find(p => p.slot === slot)?.plant
  }
  await page.goto('/plan')
  await page.getByRole('tab', { name: '2D' }).click()
  const grid = page.getByTestId('plan-grid')
  await grid.getByRole('button', { name: 'Pod 1, Basil', exact: true }).click()
  await page.getByRole('button', { name: 'Choose destination on layout' }).click()
  await grid.getByRole('button', { name: 'Pod 2', exact: true }).click()
  await page.getByRole('button', { name: 'Review move' }).click()
  const dialog = page.getByRole('dialog', { name: 'Record pod move?' })
  await expect(dialog).toContainText('Pod 1 · Basil → Pod 2 · Empty')
  expect(await readPod(1)).toBe('Basil')
  expect(await readPod(2)).toBeNull()
  await dialog.getByRole('button', { name: 'Record move' }).click()
  await expect(page.getByText('Pod records updated for 1 and 2.')).toBeVisible()
  expect(await readPod(1)).toBeNull()
  expect(await readPod(2)).toBe('Basil')
})
