#!/usr/local/bin/node
/* eslint-disable @typescript-eslint/no-require-imports -- root-installed CommonJS helper */
// Installed root-owned. Sudo permits only the two queue operations. No caller
// controls a command, unit, file, URL, environment, or argument passed to root.
const fs = require('node:fs')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const KEY_PATH = '/etc/thryve-maintenance.key'
const BUSY_PATH = '/run/thryve-busy'
const SELF = '/usr/local/sbin/thryve-maintenance'
const JOB = 'thryve-manual-maintenance'
const SYSTEMCTL = '/usr/bin/systemctl'
const RUN = '/usr/bin/systemd-run'
const KEY = /^[0-9a-f]{64}$/
const actions = new Set(['restart-core', 'reboot'])
const exec = promisify(execFile)

class Refused extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function readKey(path = KEY_PATH) {
  // No symlink, no key the service user could read or replace.
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size !== 65) throw new Refused('not-configured')
    const key = fs.readFileSync(fd, 'utf8')
    if (!key.endsWith('\n') || !KEY.test(key.slice(0, -1))) throw new Refused('not-configured')
    return key.slice(0, -1)
  }
  finally {
    fs.closeSync(fd)
  }
}

function provision(path = KEY_PATH) {
  try {
    fs.writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
  }
  catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  return readKey(path)
}

function authenticate(given, lookup = readKey) {
  if (!KEY.test(given)) throw new Refused('unauthorized')
  let key
  try {
    key = lookup()
  }
  catch {
    throw new Refused('not-configured')
  }
  if (!KEY.test(key) || !timingSafeEqual(Buffer.from(key), Buffer.from(given))) throw new Refused('unauthorized')
}

function busy() {
  try {
    return fs.readdirSync(BUSY_PATH).length > 0
  }
  catch (err) {
    if (err.code !== 'ENOENT') throw err
    return false
  }
}

async function state() {
  const r = await fetch('http://127.0.0.1:3001/state', { signal: AbortSignal.timeout(2500), redirect: 'error' })
  if (!r.ok) throw new Error('HALD did not answer')
  return r.json()
}

async function checkHardware({ isBusy = busy, halState = state, now = Date.now } = {}) {
  if (isBusy()) throw new Refused('busy')
  let snapshot
  try {
    snapshot = await halState()
  }
  catch {
    throw new Refused('hald-unavailable')
  }
  const age = now() - Date.parse(snapshot?.ts)
  const actuators = snapshot?.actuators
  if (!Number.isFinite(age) || age < -5000 || age > 30_000 || actuators?.pump?.on !== false) {
    if (Number.isFinite(age) && age >= -5000 && age <= 30_000 && actuators?.pump?.on === true) throw new Refused('actuator-active')
    throw new Refused('hald-unavailable')
  }
  if (Object.entries(actuators).some(([id, s]) => id.startsWith('dose_') && s?.on !== false)) throw new Refused('actuator-active')
  if (isBusy()) throw new Refused('busy')
}

async function operate(action, { execute = false, key, lookup = readKey, check = checkHardware, run = exec } = {}) {
  if (!actions.has(action)) throw new Refused('invalid-action')
  if (!execute) authenticate(key, lookup)
  await check()
  if (execute) {
    const argv = action === 'restart-core' ? ['--no-block', 'restart', 'thryve-core.service'] : ['--no-block', 'reboot']
    await run(SYSTEMCTL, argv, { timeout: 5000 })
  }
  else {
    // Return HTTP 202 before stopping Core. A shared unit name prevents multiple
    // pending actions. Only root may invoke the execution form of the helper.
    await run(RUN, ['--quiet', '--collect', '--unit=' + JOB, '--on-active=3s', '--timer-property=AccuracySec=1s', SELF, '--execute', action], { timeout: 5000 })
  }
}

async function stdinKey() {
  let data = ''
  for await (const part of process.stdin.setEncoding('utf8')) {
    data += part
    if (data.length > 65) throw new Refused('unauthorized')
  }
  return data.endsWith('\n') ? data.slice(0, -1) : data
}

async function main(args) {
  if (process.getuid() !== 0) throw new Refused('not-configured')
  if (args.length === 1 && args[0] === '--provision') {
    console.log(provision())
    return
  }
  const execute = args.length === 2 && args[0] === '--execute'
  if (!execute && args.length !== 1) throw new Refused('invalid-action')
  const action = args.at(-1)
  if (!actions.has(action)) throw new Refused('invalid-action')
  await operate(action, { execute, key: execute ? undefined : await stdinKey() })
  console.log(JSON.stringify({ ok: true }))
}

module.exports = { authenticate, checkHardware, operate, provision, readKey }
if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    const code = err instanceof Refused ? err.code : 'command-failed'
    console.log(JSON.stringify({ ok: false, code }))
    process.exitCode = 1
  })
}
