/**
 * scripts/thryve-migrate: one-time seedypod → Thryve path and unit rename.
 * Runs against a scratch root; no systemd and no GitHub.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../../scripts/thryve-migrate')

let dir: string
let root: string
let state: string
let bin: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thryve-migrate-'))
  root = join(dir, 'root')
  state = join(dir, 'state')
  bin = join(dir, 'bin')
  for (const d of [state, bin]) mkdirSync(d)
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho "systemctl $*" >> "$STATE/log"\n')
  chmodSync(join(bin, 'systemctl'), 0o755)
  writeFileSync(join(state, 'log'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function seed() {
  const unitDir = join(root, 'etc/systemd/system')
  mkdirSync(join(root, 'opt/seedypod/data/captures'), { recursive: true })
  mkdirSync(join(root, 'etc/seedypod'), { recursive: true })
  mkdirSync(join(root, 'var/lib/seedypod'), { recursive: true })
  mkdirSync(join(root, 'etc/udev/rules.d'), { recursive: true })
  mkdirSync(join(root, 'etc/mosquitto/conf.d'), { recursive: true })
  mkdirSync(join(root, 'usr/local/sbin'), { recursive: true })
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(join(root, 'opt/seedypod/data/seedypod.db'), 'sqlite')
  writeFileSync(join(root, 'opt/seedypod/data/seedypod.db-wal'), 'wal')
  writeFileSync(join(root, 'etc/seedypod/hal.toml'), 'state_dir = "/var/lib/seedypod"\n# pump_max_duty = 30.0\n')
  writeFileSync(join(root, 'etc/hostname'), 'seedypod\n')
  writeFileSync(join(root, 'etc/systemd/system/seedypod-core.service'), '[Service]\nUser=seedypod-core\nWorkingDirectory=/opt/seedypod\nEnvironment=DATA_DIR=/opt/seedypod/data\n')
  writeFileSync(join(root, 'etc/systemd/system/hald.service'), '[Service]\nUser=seedypod\nEnvironment=THRYVE_RECORDING_POLICY_FILE=/opt/seedypod/data/recording-policy.json\nExecStart=/usr/local/bin/hald --config /etc/seedypod/hal.toml\n')
  writeFileSync(join(root, 'etc/udev/rules.d/70-seedypod-cameras.rules'), 'SYMLINK+="seedypod/camera-upper"\n')
  writeFileSync(join(root, 'etc/mosquitto/seedypod.passwd'), 'user:pass\n')
  writeFileSync(join(root, 'usr/local/sbin/seedypod-update'), '#!/bin/sh\necho update\n')
  writeFileSync(join(root, 'usr/local/sbin/seedypod-restore'), '#!/bin/sh\necho restore\n')
}

function run(commands: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `source "${script}"; ${commands}`], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      THRYVE_LIB_ONLY: '1',
      THRYVE_ROOT: root,
      THRYVE_SYSTEMCTL: join(bin, 'systemctl'),
      STATE: state,
      ...env,
    },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('thryve-migrate', () => {
  it('moves trees, renames the database and units, and rewrites paths', () => {
    seed()
    const backup = join(dir, 'backup')
    const r = run('KEEP_HOSTNAME=0 BACKUP_DIR="$THRYVE_BACKUP_DIR" migrate_on_unit', { THRYVE_BACKUP_DIR: backup })
    expect(r.err, r.err).toBe('')
    expect(r.code).toBe(0)
    expect(existsSync(join(root, 'opt/thryve/data/thryve.db'))).toBe(true)
    expect(existsSync(join(root, 'opt/thryve/data/thryve.db-wal'))).toBe(true)
    expect(existsSync(join(root, 'opt/seedypod'))).toBe(false)
    expect(existsSync(join(root, 'etc/thryve/hal.toml'))).toBe(true)
    expect(readFileSync(join(root, 'etc/thryve/hal.toml'), 'utf8')).toContain('/var/lib/thryve')
    expect(existsSync(join(root, 'etc/systemd/system/thryve-core.service'))).toBe(true)
    expect(existsSync(join(root, 'etc/systemd/system/seedypod-core.service'))).toBe(false)
    const coreUnit = readFileSync(join(root, 'etc/systemd/system/thryve-core.service'), 'utf8')
    expect(coreUnit).toContain('User=thryve-core')
    expect(coreUnit).toContain('/opt/thryve')
    expect(readFileSync(join(root, 'etc/systemd/system/hald.service'), 'utf8')).toContain('/etc/thryve/hal.toml')
    expect(existsSync(join(root, 'etc/udev/rules.d/70-thryve-cameras.rules'))).toBe(true)
    expect(readFileSync(join(root, 'etc/udev/rules.d/70-thryve-cameras.rules'), 'utf8')).toContain('thryve/camera-upper')
    expect(existsSync(join(root, 'etc/mosquitto/thryve.passwd'))).toBe(true)
    expect(existsSync(join(root, 'usr/local/sbin/thryve-update'))).toBe(true)
    expect(readFileSync(join(root, 'etc/hostname'), 'utf8').trim()).toBe('thryve')
    expect(existsSync(join(backup, 'rollback.sh'))).toBe(true)
    expect(readFileSync(join(backup, 'rollback.sh'), 'utf8')).toContain('seedypod-core.service')
    expect(existsSync(join(backup, 'opt-seedypod/data/seedypod.db'))).toBe(true)
  })

  it('is safe to run twice', () => {
    seed()
    expect(run('BACKUP_DIR="$THRYVE_BACKUP_DIR" migrate_on_unit', { THRYVE_BACKUP_DIR: join(dir, 'b1') }).code).toBe(0)
    const r = run('BACKUP_DIR="$THRYVE_BACKUP_DIR" migrate_on_unit', { THRYVE_BACKUP_DIR: join(dir, 'b2') })
    expect(r.code).toBe(0)
    expect(existsSync(join(root, 'opt/thryve/data/thryve.db'))).toBe(true)
    expect(existsSync(join(root, 'etc/systemd/system/thryve-core.service'))).toBe(true)
  })

  it('honours SEEDYPOD_* when THRYVE_* is unset', () => {
    const r = spawnSync('bash', ['-c', 'unset THRYVE_REPO; export SEEDYPOD_REPO=example/from-legacy THRYVE_LIB_ONLY=1; source "$1"; echo "repo=$THRYVE_REPO"', 'bash', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, THRYVE_ROOT: root, HOME: dir },
    })
    expect(r.stderr, r.stderr).toBe('')
    expect(r.stdout.trim()).toBe('repo=example/from-legacy')
    expect(r.status).toBe(0)
  })
})
