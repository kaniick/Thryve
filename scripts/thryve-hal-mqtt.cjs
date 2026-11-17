#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Write mqtt_url / mqtt_username / mqtt_password into /etc/thryve/hal.toml and
// point core at the same broker (HAL_MQTT_URL in a 0600 env file + a systemd
// drop-in), then restart hald. Core is restarted a few seconds later so the
// Settings request can finish first. Secrets come from stdin JSON, never argv.
//
//   echo '{"url":"mqtt://ha:1883","username":"ha","password":"pw"}' | thryve-hal-mqtt
//
// Env: THRYVE_ETC_DIR (default /etc/thryve), THRYVE_HAL_MQTT_DROPIN,
// THRYVE_HAL_MQTT_ENV, THRYVE_HAL_MQTT_HALD, THRYVE_HAL_MQTT_DRY=1 (write
// files, do not restart).

'use strict'
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

function tomlQuote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function upsertHalTomlMqtt(text, mqtt) {
  const values = { mqtt_url: mqtt.url, mqtt_username: mqtt.username ?? null, mqtt_password: mqtt.password ?? null }
  const seen = new Set()
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    const m = !s.startsWith('#') ? /^(mqtt_url|mqtt_username|mqtt_password)\s*=/.exec(s) : null
    if (m) {
      seen.add(m[1])
      if (values[m[1]]) out.push(`${m[1]} = ${tomlQuote(values[m[1]])}`)
      continue
    }
    out.push(line)
  }
  for (const key of ['mqtt_url', 'mqtt_username', 'mqtt_password']) {
    if (seen.has(key) || !values[key]) continue
    if (out.length && out[out.length - 1] !== '') out.push('')
    out.push(`${key} = ${tomlQuote(values[key])}`)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

function fail(code, error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code, error })}\n`)
  process.exit(1)
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8')
  }
  catch {
    return ''
  }
}

function validUrl(url) {
  try {
    const u = new URL(url)
    return !!u.hostname && ['mqtt:', 'mqtts:'].includes(u.protocol)
  }
  catch {
    return false
  }
}

function mqttEnvUrl(mqtt) {
  const u = new URL(mqtt.url)
  if (mqtt.username) u.username = mqtt.username
  if (mqtt.password) u.password = mqtt.password
  return u.toString().replace(/\/$/, '')
}

function writeAtomic(file, body, mode) {
  const tmp = `${file}.new`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  fs.writeFileSync(tmp, body, { mode })
  fs.renameSync(tmp, file)
}

function main() {
  let mqtt
  try {
    mqtt = JSON.parse(readStdin() || '{}')
  }
  catch {
    fail('invalid', 'expected JSON on stdin: { url, username?, password? }')
  }
  if (!mqtt || typeof mqtt.url !== 'string' || !validUrl(mqtt.url)) {
    fail('invalid', 'url must be an mqtt:// or mqtts:// broker URL')
  }
  const etc = process.env.THRYVE_ETC_DIR || '/etc/thryve'
  const tomlPath = path.join(etc, 'hal.toml')
  if (!fs.existsSync(tomlPath)) fail('missing', `no ${tomlPath}; install hald first`)
  const mode = fs.statSync(tomlPath).mode & 0o777
  const next = upsertHalTomlMqtt(fs.readFileSync(tomlPath, 'utf8'), {
    url: mqtt.url,
    username: mqtt.username ?? null,
    password: mqtt.password ?? null,
  })
  writeAtomic(tomlPath, next, mode)

  const envFile = process.env.THRYVE_HAL_MQTT_ENV || path.join(etc, 'core-mqtt.env')
  const dropin = process.env.THRYVE_HAL_MQTT_DROPIN || '/etc/systemd/system/thryve-core.service.d/mqtt.conf'
  writeAtomic(envFile, `HAL_MQTT_URL=${JSON.stringify(mqttEnvUrl(mqtt))}\n`, 0o600)
  writeAtomic(dropin, `[Service]\nEnvironmentFile=-${envFile}\n`, 0o644)

  const hald = process.env.THRYVE_HAL_MQTT_HALD || '/usr/local/bin/hald'
  if (fs.existsSync(hald)) {
    const check = spawnSync(hald, ['--config', tomlPath, '--check'], { encoding: 'utf8' })
    if (check.status !== 0) fail('invalid', `hald --check failed${check.stderr ? `: ${check.stderr.trim()}` : ''}`)
  }

  const dry = process.env.THRYVE_HAL_MQTT_DRY === '1'
  if (!dry) {
    spawnSync('systemctl', ['daemon-reload'], { encoding: 'utf8' })
    const h = spawnSync('systemctl', ['restart', 'hald'], { encoding: 'utf8' })
    if (h.status !== 0) fail('restart', `could not restart hald${h.stderr ? `: ${h.stderr.trim()}` : ''}`)
    const delayed = spawnSync('systemd-run', ['--quiet', '--on-active=3s', '--no-block', '--collect', 'systemctl', 'try-restart', 'thryve-core'], { encoding: 'utf8' })
    const detail = delayed.status === 0
      ? 'Wrote hal.toml, pointed core at the same broker, and restarted hald. Core will reconnect in a few seconds.'
      : 'Wrote hal.toml, pointed core at the same broker, and restarted hald. Restart thryve-core when you can so the app keeps talking to the hardware.'
    process.stdout.write(`${JSON.stringify({ ok: true, detail })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({ ok: true, detail: 'Wrote hal.toml and the core MQTT drop-in.' })}\n`)
}

main()
