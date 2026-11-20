import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/thryve-camera-reset.cjs')

const fixtures: string[] = []

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'thryve-camera-reset-'))
  fixtures.push(dir)
  const sys = join(dir, 'sys')
  const dev = join(dir, 'dev')
  const state = join(dir, 'var/lib/thryve')
  const rules = join(dir, 'etc/udev/rules.d/70-thryve-cameras.rules')
  mkdirSync(join(sys, 'bus/usb/devices/1-1'), { recursive: true })
  mkdirSync(join(sys, 'bus/usb/devices/1-1.3'), { recursive: true })
  mkdirSync(join(sys, 'bus/usb/devices/1-1.3:1.0'), { recursive: true })
  mkdirSync(join(sys, 'bus/usb/drivers/uvcvideo'), { recursive: true })
  mkdirSync(join(dev, 'thryve'), { recursive: true })
  mkdirSync(join(dev, 'bus/usb/001'), { recursive: true })
  mkdirSync(join(dir, 'etc/udev/rules.d'), { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(join(sys, 'bus/usb/devices/1-1.3/busnum'), '1\n')
  writeFileSync(join(sys, 'bus/usb/devices/1-1.3/devnum'), '4\n')
  writeFileSync(join(sys, 'bus/usb/devices/1-1.3/authorized'), '1\n')
  writeFileSync(join(dev, 'bus/usb/001/004'), '')
  writeFileSync(join(dev, 'thryve/camera-upper'), '')
  writeFileSync(join(sys, 'bus/usb/drivers/uvcvideo/unbind'), '')
  writeFileSync(join(sys, 'bus/usb/drivers/uvcvideo/bind'), '')
  symlinkSync(join(sys, 'bus/usb/drivers/uvcvideo'), join(sys, 'bus/usb/devices/1-1.3:1.0/driver'))
  writeFileSync(rules, 'SUBSYSTEM=="video4linux", KERNELS=="1-1.3:1.0", ATTR{index}=="0", SYMLINK+="thryve/camera-upper"\nSUBSYSTEM=="video4linux", KERNELS=="1-1.4:1.0", ATTR{index}=="0", SYMLINK+="thryve/camera-lower"\n')
  return { dir, sys, dev, state, rules }
}

function run(args: string[], env: NodeJS.ProcessEnv, allowFail = false) {
  try {
    const stdout = execFileSync('node', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, THRYVE_CAMERA_RESET_SLEEP_MS: '0', ...env },
    })
    return { status: 0, stdout, stderr: '' }
  }
  catch (err) {
    const e = err as { status?: number, stdout?: string, stderr?: string }
    if (!allowFail) throw err
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

function lastJson(stdout: string) {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(line) as Record<string, unknown>
}

afterEach(() => {
  // Trees sit in /tmp and are removed with the box; no need to rm here.
  fixtures.length = 0
})

describe('thryve-camera-reset', () => {
  it('refuses anything other than upper or lower', () => {
    const r = run(['side'], {}, true)
    expect(r.status).toBe(1)
    expect(lastJson(r.stdout).code).toBe('usage')
  })

  it('resets a present upper camera with usbdevfs_reset in dry-run', () => {
    const f = tree()
    const r = run(['upper'], {
      THRYVE_SYSFS: f.sys,
      THRYVE_DEV: f.dev,
      THRYVE_UDEV_RULES: f.rules,
      THRYVE_STATE_DIR: f.state,
      THRYVE_CAMERA_RESET_DRY: '1',
    })
    const body = lastJson(r.stdout)
    expect(body).toMatchObject({ ok: true, camera: 'upper', port: '1-1.3:1.0', device: '1-1.3', method: 'usbdevfs_reset', present: true })
    const log = readFileSync(join(f.state, 'camera-reset.log'), 'utf8')
    expect(log).toContain('"camera":"upper"')
  })

  it('says the hub is missing when the bus is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thryve-camera-empty-'))
    const sys = join(dir, 'sys/bus/usb/devices')
    mkdirSync(sys, { recursive: true })
    const r = run(['upper'], {
      THRYVE_SYSFS: join(dir, 'sys'),
      THRYVE_DEV: join(dir, 'dev'),
      THRYVE_UDEV_RULES: join(dir, 'missing.rules'),
      THRYVE_STATE_DIR: join(dir, 'state'),
    }, true)
    expect(r.status).toBe(1)
    expect(lastJson(r.stdout)).toMatchObject({ ok: false, code: 'hub_missing', camera: 'upper' })
    expect(String(lastJson(r.stdout).error)).toMatch(/hub is not on the bus/i)
  })

  it('falls back to authorized 0/1 when the ioctl fails and the node stays up', () => {
    const f = tree()
    const hook = join(f.dir, 'fail-ioctl')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    execFileSync('chmod', ['+x', hook])
    const r = run(['upper'], {
      THRYVE_SYSFS: f.sys,
      THRYVE_DEV: f.dev,
      THRYVE_UDEV_RULES: f.rules,
      THRYVE_STATE_DIR: f.state,
      THRYVE_CAMERA_RESET_IOCTL: hook,
    })
    const body = lastJson(r.stdout)
    expect(body.ok).toBe(true)
    expect(body.method).toBe('authorized')
    expect(readFileSync(join(f.sys, 'bus/usb/devices/1-1.3/authorized'), 'utf8').trim()).toBe('1')
  })

  it('does not unbind dwc_otg when the camera is gone and rebind is the last step', () => {
    const f = tree()
    const hook = join(f.dir, 'fail-ioctl')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    execFileSync('chmod', ['+x', hook])
    const auth = join(f.sys, 'bus/usb/devices/1-1.3/authorized')
    execFileSync('rm', ['-f', auth])
    mkdirSync(auth)
    execFileSync('rm', ['-f', join(f.dev, 'thryve/camera-upper')])
    mkdirSync(join(f.sys, 'bus/platform/drivers/dwc_otg'), { recursive: true })
    writeFileSync(join(f.sys, 'bus/platform/drivers/dwc_otg/unbind'), '')
    writeFileSync(join(f.sys, 'bus/platform/drivers/dwc_otg/bind'), '')
    const iface = join(f.sys, 'bus/usb/devices/1-1.3:1.0/driver')
    execFileSync('rm', ['-f', iface])
    symlinkSync(join(f.sys, 'bus/platform/drivers/dwc_otg'), iface)
    const r = run(['upper'], {
      THRYVE_SYSFS: f.sys,
      THRYVE_DEV: f.dev,
      THRYVE_UDEV_RULES: f.rules,
      THRYVE_STATE_DIR: f.state,
      THRYVE_CAMERA_RESET_IOCTL: hook,
    }, true)
    expect(r.status).toBe(1)
    const body = lastJson(r.stdout)
    expect(body.code).toBe('still_missing')
    expect(JSON.stringify(body.steps)).toContain('refusing to unbind dwc_otg')
    expect(readFileSync(join(f.sys, 'bus/platform/drivers/dwc_otg/unbind'), 'utf8')).toBe('')
    expect(readFileSync(join(f.sys, 'bus/platform/drivers/dwc_otg/bind'), 'utf8')).toBe('')
  })
})
