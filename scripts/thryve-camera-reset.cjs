#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Reset one Gardyn timelapse camera by cycling its USB device. The cameras are
// UVC modules (c499:0ac8) on a 1a40:0801 hub hanging off the main Pi's USB
// port — not a second Pi Zero. This never rebinds dwc_otg/dwc2 and never
// reboots the board: those have been tried for a hub stuck in SE1 at boot and
// either did nothing or oopsed the kernel (docs/hardware/pin-map.md).
//
//   thryve-camera-reset upper|lower
//
// Env: THRYVE_SYSFS (default /sys), THRYVE_DEV (/dev),
// THRYVE_UDEV_RULES (/etc/udev/rules.d/70-thryve-cameras.rules),
// THRYVE_STATE_DIR (/var/lib/thryve), THRYVE_CAMERA_RESET_DRY=1 (plan only),
// THRYVE_CAMERA_RESET_SLEEP_MS (override waits; tests use 0).

'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const STOCK_PORTS = { upper: '1-1.3:1.0', lower: '1-1.4:1.0' }
const NAMES = new Set(['upper', 'lower'])

function envPath(name, fallback) {
  return process.env[name] || fallback
}

function sysfs() {
  return envPath('THRYVE_SYSFS', '/sys')
}

function devRoot() {
  return envPath('THRYVE_DEV', '/dev')
}

function rulesPath() {
  return envPath('THRYVE_UDEV_RULES', '/etc/udev/rules.d/70-thryve-cameras.rules')
}

function stateDir() {
  return envPath('THRYVE_STATE_DIR', '/var/lib/thryve')
}

function dryRun() {
  return process.env.THRYVE_CAMERA_RESET_DRY === '1'
}

function sleepMs() {
  const raw = process.env.THRYVE_CAMERA_RESET_SLEEP_MS
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, n) : null
}

function sleep(ms) {
  const forced = sleepMs()
  const wait = forced === null ? ms : forced
  if (wait <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
}

function readTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  }
  catch {
    return null
  }
}

function isUsbInterface(port) {
  const parts = String(port).split(':')
  if (parts.length !== 2) return false
  const [device, iface] = parts
  return device.includes('-')
    && [...device].every(c => /[0-9.-]/.test(c))
    && iface.length > 0
    && [...iface].every(c => /[0-9.]/.test(c))
}

function parseRules(text) {
  const between = (line, open, close) => {
    const i = line.indexOf(open)
    if (i < 0) return null
    const rest = line.slice(i + open.length)
    const j = rest.indexOf(close)
    if (j < 0) return null
    return rest.slice(0, j)
  }
  const out = {}
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    const port = between(line, 'KERNELS=="', '"')
    const name = between(line, 'thryve/camera-', '"')
    if (name && port && isUsbInterface(port)) out[name] = port
  }
  return out
}

function usbDeviceId(port) {
  return port.split(':')[0]
}

function assignedPort(name) {
  let pins = {}
  try {
    pins = parseRules(fs.readFileSync(rulesPath(), 'utf8'))
  }
  catch {
    pins = {}
  }
  return pins[name] || STOCK_PORTS[name]
}

function deviceDir(id) {
  return path.join(sysfs(), 'bus/usb/devices', id)
}

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  }
  catch {
    return false
  }
}

function cameraNode(name) {
  return path.join(devRoot(), 'thryve', `camera-${name}`)
}

function usbBusPath(id) {
  const dir = deviceDir(id)
  const bus = readTrim(path.join(dir, 'busnum'))
  const dev = readTrim(path.join(dir, 'devnum'))
  if (!bus || !dev) return null
  return path.join(devRoot(), 'bus/usb', bus.padStart(3, '0'), dev.padStart(3, '0'))
}

function hubPresent() {
  // The cameras hang off a device on the Pi root hub (typically 1-1).
  return exists(deviceDir('1-1')) || exists(path.join(sysfs(), 'bus/usb/devices/1-1'))
}

function writeSysfs(file, value) {
  if (dryRun()) return { ok: true, dry: true }
  try {
    fs.writeFileSync(file, value)
    return { ok: true }
  }
  catch (err) {
    return { ok: false, error: err.message }
  }
}

function usbReset(busPath) {
  if (dryRun()) return { ok: true, dry: true, method: 'usbdevfs_reset' }
  const hook = process.env.THRYVE_CAMERA_RESET_IOCTL
  const py = `import fcntl, os, sys
USBDEVFS_RESET = 21780
path = sys.argv[1]
fd = os.open(path, os.O_WRONLY)
try:
    fcntl.ioctl(fd, USBDEVFS_RESET, 0)
finally:
    os.close(fd)
`
  const cmd = hook
    ? spawnSync(hook, [busPath], { encoding: 'utf8' })
    : spawnSync('python3', ['-c', py, busPath], { encoding: 'utf8' })
  if (cmd.error) return { ok: false, error: cmd.error.message, method: 'usbdevfs_reset' }
  if (cmd.status !== 0) {
    return { ok: false, error: (cmd.stderr || cmd.stdout || `exit ${cmd.status}`).trim(), method: 'usbdevfs_reset' }
  }
  return { ok: true, method: 'usbdevfs_reset' }
}

function portDisablePath(deviceId) {
  // 1-1.3 → hub 1-1, port 3. Kernel 5+ exposes <hub>/<hub>-portN/disable.
  const last = deviceId.split('-').pop() || ''
  const portNo = last.split('.').pop()
  const hub = deviceId.includes('.') ? deviceId.slice(0, deviceId.lastIndexOf('.')) : null
  if (!hub || !portNo) return null
  const candidate = path.join(deviceDir(hub), `${hub}-port${portNo}`, 'disable')
  return exists(candidate) || dryRun() ? candidate : null
}

function unbindBind(interfaceId) {
  const driverLink = path.join(deviceDir(interfaceId), 'driver')
  let driverDir = path.join(sysfs(), 'bus/usb/drivers/uvcvideo')
  try {
    if (exists(driverLink)) driverDir = fs.realpathSync(driverLink)
  }
  catch {
    // keep uvcvideo
  }
  const driverName = path.basename(driverDir)
  // Never touch the Pi's USB controller drivers (unbind of dwc_otg can oops).
  if (driverName === 'dwc_otg' || driverName === 'dwc2') {
    return { ok: false, error: `refusing to unbind ${driverName}` }
  }
  const unbind = writeSysfs(path.join(driverDir, 'unbind'), interfaceId)
  if (!unbind.ok && !String(unbind.error || '').includes('NOENT')) {
    // Already unbound is fine; a real write error is not fatal until bind fails.
  }
  sleep(1000)
  const bind = writeSysfs(path.join(driverDir, 'bind'), interfaceId)
  return bind.ok
    ? { ok: true, method: `rebind:${driverName}` }
    : { ok: false, error: bind.error, method: `rebind:${driverName}` }
}

function present(name, deviceId) {
  return exists(cameraNode(name)) || exists(deviceDir(deviceId))
}

function waitFor(name, deviceId, ms) {
  const forced = sleepMs()
  const budget = forced === null ? ms : 0
  const start = Date.now()
  while (Date.now() - start <= budget) {
    if (present(name, deviceId)) return true
    sleep(Math.min(200, Math.max(0, budget)))
    if (budget === 0) break
  }
  return present(name, deviceId)
}

function appendLog(entry) {
  const dir = stateDir()
  const file = path.join(dir, 'camera-reset.log')
  const line = `${JSON.stringify(entry)}\n`
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.appendFileSync(file, line)
  }
  catch {
    // Best-effort: the JSON stdout is the record core persists.
  }
  try {
    spawnSync('logger', ['-t', 'thryve-camera-reset', `${entry.camera}: ${entry.ok ? entry.method : entry.error}`], { encoding: 'utf8' })
  }
  catch {
    // logger is optional in tests and on hosts without syslog.
  }
}

function fail(code, error, extra) {
  const body = { ok: false, code, error, ...extra }
  appendLog({ ts: new Date().toISOString(), ...body })
  process.stdout.write(`${JSON.stringify(body)}\n`)
  process.exit(1)
}

function ok(body) {
  const out = { ok: true, ...body }
  appendLog({ ts: new Date().toISOString(), ...out })
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

function usage() {
  fail('usage', 'usage: thryve-camera-reset upper|lower')
}

function main() {
  const name = process.argv[2]
  if (!NAMES.has(name)) usage()
  const port = assignedPort(name)
  if (!port) fail('unknown', `no USB port pinned for the ${name} camera`)
  const deviceId = usbDeviceId(port)
  const extra = { camera: name, port, device: deviceId }

  if (!hubPresent() && !exists(deviceDir(deviceId)) && !dryRun()) {
    fail('hub_missing', 'The cameras\' USB hub is not on the bus. A per-camera reset cannot bring it up. Reseat the cable between the Pi and the hub, then restart the unit.', extra)
  }

  const steps = []
  const busPath = exists(deviceDir(deviceId)) ? usbBusPath(deviceId) : null

  if (busPath || (dryRun() && exists(deviceDir(deviceId)))) {
    const r = usbReset(busPath || '/dev/bus/usb/001/001')
    steps.push(r)
    if (r.ok) {
      sleep(2000)
      if (waitFor(name, deviceId, 8000)) return ok({ camera: name, port, device: deviceId, method: 'usbdevfs_reset', steps, present: true })
    }
  }

  if (exists(deviceDir(deviceId)) || dryRun()) {
    const auth = path.join(deviceDir(deviceId), 'authorized')
    const off = writeSysfs(auth, '0')
    steps.push({ ok: off.ok, method: 'authorized:off', error: off.error })
    sleep(2000)
    const on = writeSysfs(auth, '1')
    steps.push({ ok: on.ok, method: 'authorized:on', error: on.error })
    if (on.ok) {
      sleep(2000)
      if (waitFor(name, deviceId, 8000)) return ok({ camera: name, port, device: deviceId, method: 'authorized', steps, present: true })
    }
  }

  const disable = portDisablePath(deviceId)
  if (disable) {
    const off = writeSysfs(disable, '1')
    steps.push({ ok: off.ok, method: 'hub-port:off', error: off.error, path: disable })
    sleep(2000)
    const on = writeSysfs(disable, '0')
    steps.push({ ok: on.ok, method: 'hub-port:on', error: on.error, path: disable })
    if (on.ok) {
      sleep(2000)
      if (waitFor(name, deviceId, 8000)) return ok({ camera: name, port, device: deviceId, method: 'hub-port-power', steps, present: true })
    }
  }

  if (exists(deviceDir(port)) || dryRun()) {
    const r = unbindBind(port)
    steps.push(r)
    if (r.ok) {
      sleep(2000)
      if (waitFor(name, deviceId, 8000)) return ok({ camera: name, port, device: deviceId, method: r.method, steps, present: true })
    }
  }

  const still = present(name, deviceId)
  const worked = steps.some(s => s && s.ok)
  if (still && worked) return ok({ camera: name, port, device: deviceId, method: steps.at(-1)?.method || 'none', steps, present: true })
  fail('still_missing', `The ${name} camera did not come back on the bus. Reseat its cable at the hub, then try again.`, { ...extra, steps, present: still })
}

main()
