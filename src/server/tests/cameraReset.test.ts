import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cameraResetCommand, listRestartLog, restartCamera } from '../cameraReset'

describe('restartCamera', () => {
  const now = () => new Date('2026-11-19T20:00:00Z')

  it('simulates a restart when there is no helper and no real hald', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camera-reset-core-'))
    const env = { DATA_DIR: dir } as NodeJS.ProcessEnv
    const r = await restartCamera('upper', env, now)
    expect(r).toMatchObject({ ok: true, camera: 'upper', method: 'simulated', simulated: true })
    expect(r.detail).toMatch(/does not reboot the Pi/)
    expect(listRestartLog(env)[0]?.method).toBe('simulated')
  })

  it('tells the owner to run scripts/install on a unit without the helper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camera-reset-unit-'))
    const r = await restartCamera('lower', { DATA_DIR: dir, HAL_MQTT_URL: 'mqtt://127.0.0.1:1883' } as NodeJS.ProcessEnv, now)
    expect(r).toMatchObject({ ok: false, camera: 'lower', code: 'unavailable' })
    expect(r.detail).toMatch(/sudo \/opt\/thryve\/scripts\/install/)
  })

  it('runs a configured helper and keeps its audit line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camera-reset-cmd-'))
    mkdirSync(join(dir, 'bin'), { recursive: true })
    const hook = join(dir, 'bin/reset')
    writeFileSync(hook, '#!/bin/sh\necho "{\\"ok\\":true,\\"camera\\":\\"$1\\",\\"method\\":\\"usbdevfs_reset\\",\\"present\\":true}"\n')
    const { execFileSync } = await import('node:child_process')
    execFileSync('chmod', ['+x', hook])
    const env = { DATA_DIR: dir, THRYVE_CAMERA_RESET_CMD: JSON.stringify([hook]) } as NodeJS.ProcessEnv
    const r = await restartCamera('upper', env, now)
    expect(r).toMatchObject({ ok: true, camera: 'upper', method: 'usbdevfs_reset' })
    expect(r.detail).toMatch(/Restarted the upper camera/)
    expect(listRestartLog(env)[0]?.ok).toBe(true)
  })

  it('surfaces a helper refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camera-reset-fail-'))
    const hook = join(dir, 'reset')
    writeFileSync(hook, '#!/bin/sh\necho "{\\"ok\\":false,\\"code\\":\\"hub_missing\\",\\"error\\":\\"The cameras\' USB hub is not on the bus.\\"}"\nexit 1\n')
    const { execFileSync } = await import('node:child_process')
    execFileSync('chmod', ['+x', hook])
    const r = await restartCamera('upper', { DATA_DIR: dir, THRYVE_CAMERA_RESET_CMD: JSON.stringify([hook]) } as NodeJS.ProcessEnv, now)
    expect(r).toMatchObject({ ok: false, code: 'hub_missing' })
    expect(r.detail).toMatch(/hub is not on the bus/)
  })

  it('reads an override command from the env', () => {
    expect(cameraResetCommand({ THRYVE_CAMERA_RESET_CMD: '["/bin/echo"]' })).toEqual(['/bin/echo'])
  })
})
