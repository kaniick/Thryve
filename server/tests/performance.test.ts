import { expect, it } from 'vitest'
import { SimHal } from '../../src/hardware/sim'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'
import { createApp } from '../app'
import type { CorePerformanceWindow } from '../performance'

it('serves the latest performance window without altering the existing healthcheck', async () => {
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test' })
  let latest: CorePerformanceWindow | null = null
  const { app } = createApp({ ctx: core.ctx, performanceWindow: () => latest })
  try {
    expect(await (await app.request('/api/system/performance')).json()).toEqual({ core: null })
    latest = { endedAt: '2026-11-25T00:00:00Z', windowMs: 30_000, eventLoopUtilization: 0.5, p95LagMs: 33, maxLagMs: 1234 }
    const result = await app.request('/api/system/performance')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(await result.json()).toEqual({ core: latest })
    expect(await (await app.request('/api/healthcheck')).json()).toMatchObject({ ok: true })
  }
  finally {
    await core.stop()
  }
})
