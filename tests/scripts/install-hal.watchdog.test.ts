/**
 * install-hal's hald.service watchdog and the pump-off script its ExecStopPost
 * runs, against a scratch root with a stub hald and stub GPIO tools. What they
 * do on a Pi is in docs/hardware/hal.md#watchdog.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/install-hal')
const LIGHT_PIN = 18

let dir: string
let root: string
let bin: string

const exec = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}
const log = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : '')
const unit = () => readFileSync(join(root, 'etc/systemd/system/hald.service'), 'utf8')
const pumpOff = () => join(root, 'usr/local/lib/thryve/pump-off')
const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, THRYVE_LIB_ONLY: '1', THRYVE_ROOT: root, LOG: join(dir, 'log'), STATE: dir, PUMP_OFF_SYSFS: join(dir, 'sys') })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-hal-watchdog-'))
  root = join(dir, 'root')
  bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  // A hald that answers --pump-pin with $STATE/pin, fails when $STATE/hald-fails is
  // there, and predates the flag when $STATE/old-hald is.
  exec(join(dir, 'hald'), `echo "hald $*" >> "$LOG"
case " $* " in *" --pump-pin "*)
  [ -f "$STATE/old-hald" ] && { echo "error: unexpected argument '--pump-pin'" >&2; exit 2; }
  [ -f "$STATE/hald-fails" ] && exit 1
  cat "$STATE/pin"; exit 0 ;;
esac`)
  writeFileSync(join(dir, 'pin'), '24\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function lib(steps: string, hald = join(dir, 'hald')) {
  return spawnSync('bash', ['-c', `set -euo pipefail; source "${script}"; SUDO=; REPO=kaniick/Thryve; SERVICE_USER=thryve; STATE_DIR=/var/lib/thryve; I2C_BUS=1; ${steps.replaceAll('$HALD_BIN', hald)}`], { encoding: 'utf8', env: env() })
}

function stop(extra: Record<string, string> = {}) {
  return spawnSync(pumpOff(), [], { encoding: 'utf8', env: { ...env(), ...extra } })
}

/** GPIO calls the pump-off script made. */
const gpio = () => log().split('\n').filter(l => /^(pinctrl|raspi-gpio|gpioset) /.test(l))

describe('write_hald_unit', () => {
  it('has systemd watch hald and run pump-off after every stop', () => {
    const r = lib('write_hald_unit $HALD_BIN /etc/thryve/hal.toml')
    expect(r.status).toBe(0)
    const text = unit()
    expect(text).toMatch(/^Type=notify$/m)
    expect(text).toMatch(/^WatchdogSec=10$/m)
    expect(text).toMatch(/^TimeoutStartSec=120$/m)
    expect(text).toMatch(/^ExecStopPost=-\/usr\/local\/lib\/thryve\/pump-off$/m)
    expect(text).toContain(`ExecStart=${join(dir, 'hald')} --config /etc/thryve/hal.toml`)
    for (const kept of ['Restart=always', 'RestartSec=3', 'TimeoutStopSec=10', 'User=thryve', 'ReadWritePaths=/var/lib/thryve /tmp', 'ExecStartPre=-/usr/bin/timeout 30']) {
      expect(text).toContain(kept)
    }
    expect(r.stderr).toBe('')
  })

  it('gives an older hald, which never pings, no watchdog to be killed by', () => {
    writeFileSync(join(dir, 'old-hald'), '')
    const r = lib('write_hald_unit $HALD_BIN /etc/thryve/hal.toml')
    expect(r.status).toBe(0)
    expect(unit()).not.toMatch(/WatchdogSec|Type=notify/)
    expect(unit()).toMatch(/^ExecStopPost=-\/usr\/local\/lib\/thryve\/pump-off$/m)
    expect(r.stderr).toContain('no watchdog')
  })

  it('reports a change only when the unit changes', () => {
    lib('write_hald_unit $HALD_BIN /etc/thryve/hal.toml')
    expect(lib('UNIT_CHANGED=0; write_hald_unit $HALD_BIN /etc/thryve/hal.toml; echo "changed=$UNIT_CHANGED"').stdout).toContain('changed=0')
  })
})

describe('the pump-off script', () => {
  const install = () => {
    const r = lib('install_pump_off $HALD_BIN /etc/thryve/hal.toml')
    expect(r.status).toBe(0)
    rmSync(join(dir, 'log'), { force: true })
  }

  beforeEach(() => {
    exec(join(bin, 'pinctrl'), 'echo "pinctrl $*" >> "$LOG"')
  })

  it('is installed executable, asking hald for the pin from hal.toml', () => {
    install()
    expect(statSync(pumpOff()).mode & 0o111).toBe(0o111)
    const text = readFileSync(pumpOff(), 'utf8')
    expect(text).toMatch(/^#!\/bin\/sh/)
    expect(text).toContain(`HALD=${join(dir, 'hald')}`)
    expect(text).toContain('CONF=/etc/thryve/hal.toml')
    expect(text).toContain('FALLBACK=24')
  })

  it('drives the default pump pin low with pinctrl', () => {
    install()
    const r = stop()
    expect(r.status).toBe(0)
    expect(gpio()).toEqual(['pinctrl set 24 op dl'])
    expect(r.stdout).toContain('pump-off: GPIO24 driven low (pinctrl)')
    expect(log()).toContain('--config /etc/thryve/hal.toml --pump-pin')
  })

  it('follows a pump_pwm changed since the install', () => {
    install()
    writeFileSync(join(dir, 'pin'), '23\n')
    stop()
    expect(gpio()).toEqual(['pinctrl set 23 op dl'])
  })

  it('falls back to the pin hald gave at install when hald can\'t say', () => {
    writeFileSync(join(dir, 'pin'), '23\n')
    install()
    writeFileSync(join(dir, 'hald-fails'), '')
    stop()
    expect(gpio()).toEqual(['pinctrl set 23 op dl'])
  })

  it('drives nothing when hald names no pin, as for a pump on the light pin', () => {
    writeFileSync(join(dir, 'pin'), '')
    install()
    const r = stop()
    expect(r.status).toBe(0)
    expect(gpio()).toEqual([])
    expect(r.stdout).toContain('no pump pin')
  })

  it('never touches the light pin', () => {
    install()
    stop()
    expect(gpio().join('\n')).not.toContain(` ${LIGHT_PIN} `)
  })

  it('uses raspi-gpio where pinctrl is missing or fails', () => {
    exec(join(bin, 'pinctrl'), 'echo "pinctrl $*" >> "$LOG"; exit 1')
    exec(join(bin, 'raspi-gpio'), 'echo "raspi-gpio $*" >> "$LOG"')
    install()
    const r = stop()
    expect(gpio()).toEqual(['pinctrl set 24 op dl', 'raspi-gpio set 24 op dl'])
    expect(r.stdout).toContain('(raspi-gpio)')
  })

  it('uses sysfs on the Pi\'s GPIO chip, offset by its base', () => {
    rmSync(join(bin, 'pinctrl'))
    const sys = join(dir, 'sys')
    for (const [chip, label, base] of [['gpiochip0', 'brcmvirt-gpio', '0'], ['gpiochip512', 'pinctrl-bcm2835', '512']]) {
      mkdirSync(join(sys, chip), { recursive: true })
      writeFileSync(join(sys, chip, 'label'), `${label}\n`)
      writeFileSync(join(sys, chip, 'base'), `${base}\n`)
    }
    // The kernel makes gpio536 on export; here it's already there.
    mkdirSync(join(sys, 'gpio536'))
    install()
    const r = stop()
    expect(r.stdout).toContain('(sysfs)')
    expect(readFileSync(join(sys, 'gpio536/direction'), 'utf8')).toBe('low\n')
  })

  it('uses libgpiod\'s gpioset last', () => {
    rmSync(join(bin, 'pinctrl'))
    exec(join(bin, 'gpioset'), 'echo "gpioset $*" >> "$LOG"')
    exec(join(bin, 'timeout'), 'shift; exec "$@"')
    install()
    const r = stop()
    expect(gpio()).toEqual(['gpioset -t0 GPIO24=0'])
    expect(r.stdout).toContain('(gpioset)')
  })

  it('fails, for the journal, when nothing can drive the pin', () => {
    rmSync(join(bin, 'pinctrl'))
    install()
    const r = stop()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('couldn\'t drive GPIO24 low')
  })
})

// The real hald, where it's been built (cargo build -p hald), reading real hal.toml files.
const built = [process.env.HALD_TEST_BIN, resolve(import.meta.dirname, '../../hal/target/debug/hald'), resolve(import.meta.dirname, '../../hal/target/release/hald')].find(p => p && existsSync(p))

describe.runIf(built)('pump-off with the real hald', () => {
  const conf = () => join(dir, 'hal.toml')
  const run = (toml: string) => {
    writeFileSync(conf(), toml)
    expect(lib(`install_pump_off ${built} ${conf()}`).status).toBe(0)
    rmSync(join(dir, 'log'), { force: true })
    return stop()
  }

  beforeEach(() => {
    exec(join(bin, 'pinctrl'), 'echo "pinctrl $*" >> "$LOG"')
  })

  it('drives the default pin, from the commented default hal.toml', () => {
    const defaults = spawnSync(built ?? 'hald', ['--print-default-config'], { encoding: 'utf8' }).stdout
    expect(run(defaults).status).toBe(0)
    expect(gpio()).toEqual(['pinctrl set 24 op dl'])
  })

  it('drives a custom pump_pwm, never the light', () => {
    run('[pins]\npump_pwm = 23\n')
    expect(gpio()).toEqual(['pinctrl set 23 op dl'])
  })

  it('drives nothing for a pump put on the light pin', () => {
    run(`[pins]\npump_pwm = ${LIGHT_PIN}\n`)
    expect(gpio()).toEqual([])
  })

  it('keeps the install-time pin for a hal.toml it can\'t read at stop', () => {
    run('[pins]\npump_pwm = 23\n')
    writeFileSync(conf(), 'not = [toml\n')
    rmSync(join(dir, 'log'), { force: true })
    stop()
    expect(gpio()).toEqual(['pinctrl set 23 op dl'])
  })
})
