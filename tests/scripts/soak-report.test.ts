import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 25, 7) + seconds * 1000).toISOString()
const okay = { result: 'ok', ms: 25 }
const timeout = { result: 'timeout', ms: 2000 }
const sample = (seconds: number, patch: Record<string, unknown> = {}) => ({
  ts: at(seconds), host: '10.10.20.202', core: okay, hald: okay, ssh: null, ...patch,
})

function save(rows: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'thryve-soak-'))
  dirs.push(dir)
  const target = join(dir, 'observe.jsonl')
  writeFileSync(target, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
  return target
}

function run(...args: string[]) {
  return spawnSync('python3', ['scripts/thryve-soak-report.py', ...args], { encoding: 'utf8' })
}

describe('dev soak report', () => {
  it('counts checked endpoints and independent failure patterns without treating SSH skips as outages', () => {
    const log = save([
      sample(0, { hald: { ...okay, uptime_s: 700, mqtt_connected: true }, ssh: okay }),
      sample(5, { core: timeout, hald: { ...okay, uptime_s: 705, mqtt_connected: false }, ssh: okay }),
      sample(10, { core: { ...okay, ms: 500 }, ssh: timeout }),
      sample(15, { core: timeout, hald: timeout, ssh: timeout }),
      sample(38, { core: timeout, hald: { ...okay, uptime_s: 2, mqtt_connected: true } }),
      sample(43),
    ])
    const result = run(log, '--interval', '5', '--json')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      candidate: {
        host: '10.10.20.202', from: '2026-11-25T07:00:00.000+00:00', to: '2026-11-25T07:00:43.000+00:00',
        samples: 6, observed_seconds: 43, coverage: { expected_interval_s: 5, gaps_over_twice_interval: 1, longest_gap_s: 23 },
        services: {
          core: { checked: 6, ok: 3, failures: { timeout: 3 }, p95_ms: 500, max_ms: 500 },
          hald: { checked: 6, ok: 5, failures: { timeout: 1 }, p95_ms: 25, max_ms: 25 },
          ssh: { checked: 4, ok: 2, failures: { timeout: 2 }, p95_ms: 25, max_ms: 25 },
        },
        failure_patterns: { core_only: 1, ssh_only: 1, all_three: 1, other: 1 },
        first_failed_at: '2026-11-25T07:00:05.000+00:00', last_failed_at: '2026-11-25T07:00:38.000+00:00',
        hald_uptime_drops: ['2026-11-25T07:00:38.000+00:00'], hald_mqtt: { checked: 3, disconnected: 1 },
      },
    })
  })

  it('shows distinct observation windows and no latency for checks that never ran', () => {
    const base = save([sample(0), sample(30)])
    const candidate = save([sample(90, { core: timeout, ssh: okay }), sample(95, { core: timeout })])
    const result = run(candidate, '--baseline', base, '--baseline-interval', '30', '--interval', '5')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Baseline on 10.10.20.202')
    expect(result.stdout).toContain('0 gaps over 60s')
    expect(result.stdout).toContain('Candidate on 10.10.20.202')
    expect(result.stdout).toContain('0 gaps over 10s')
    expect(result.stdout).toContain('core: 0/2 successful checks, no successful latency (timeout=2)')
    expect(result.stdout).toContain('ssh: 0/0 successful checks, no successful latency')
    expect(result.stdout).toContain('not proof of a Pi reboot')
  })

  it('rejects clipped lines, mixed gateway logs, duplicate timestamps, and empty captures', () => {
    for (const [rows, error] of [
      [[sample(0), '{"ts":'], ':2:'],
      [[sample(0), sample(5, { host: '10.10.20.203' })], 'mixed gateways'],
      [[sample(0), sample(0)], 'duplicate or out-of-order'],
      [[], 'no samples'],
    ] as const) {
      const result = run(save([...rows]))
      expect(result.status).toBe(2)
      expect(result.stderr).toContain(error)
    }
    const result = run(save([sample(0)]), '--baseline', save([sample(0, { host: '10.10.20.203' })]))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('different gateway addresses')
  })
})
