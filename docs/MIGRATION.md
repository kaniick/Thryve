---
type: "Guide"
title: "Migrating from seedypod"
description: "Move a seedypod v1.5.0 unit to Thryve without reflashing: one-shot SSH migration, rollback, later updates, and pump checks."
status: "draft"
generated: {"by": "kaniick", "at": "2026-11-14T18:30:00+00:00"}
sources: [{"resource": "/INSTALLATION.md", "title": "Installation"}, {"resource": "/DEPLOYMENT.md", "title": "Deployment"}, {"resource": "/adr/0026-web-update.md", "title": "ADR 0026: Web update"}]
---

# Migrating a seedypod unit to Thryve

Thryve is a rebranded fork of seedypod. If the tower already runs **seedypod v1.5.0** (or later `dev`) from the microSD card, **do not reflash**. A one-time migration moves data, units, users and config onto the Thryve names, then installs a Thryve release from `kaniick/Thryve`.

HomeKit must be re-paired afterwards: the HomeKit identity salt changed, and Apple Home will treat this as a new bridge.

## Why the in-app updater cannot do this alone

seedypod v1.5.0's helper (`/usr/local/sbin/seedypod-update`) has the repository `seedypod/core` compiled in. When it runs as root (the normal `sudo` path, and what the web UI uses) it **ignores** environment overrides, so pointing `SEEDYPOD_UPDATE_DOWNLOADS` at this fork does nothing. Run the migration over SSH instead.

## Before you start

1. A Thryve release must exist on GitHub: either the rolling `dev-latest` prerelease (after this branch is merged to `dev` and the Dev release workflow has published assets) or a later tag such as `v2.0.0`. Check https://github.com/kaniick/Thryve/releases.
2. SSH into the unit (as the login you already use). Have a couple of hundred MB free on the card.
3. Confirm the tank has water if you plan to test the pump after the update. Never run the pump dry.

```sh
# on the unit
hostname
systemctl is-active seedypod-core.service hald.service
ls -ld /opt/seedypod /etc/seedypod /var/lib/seedypod
```

## One-shot migration

After a Thryve release is published:

```sh
# Installs Thryve from the rolling dev build:
curl -fsSL https://raw.githubusercontent.com/kaniick/Thryve/dev/scripts/thryve-migrate | sudo bash -s -- --tag dev-latest

# Or, once a stable tag exists:
# curl -fsSL https://raw.githubusercontent.com/kaniick/Thryve/dev/scripts/thryve-migrate | sudo bash -s -- --tag v2.0.0
```

The script:

- stops `seedypod-core`, `hald`, and related seedypod units
- copies a rollback snapshot to `/var/lib/thryve-migrate-backup-<timestamp>`
- moves `/opt/seedypod`, `/etc/seedypod`, `/var/lib/seedypod` (and the update/restore/cache/busy dirs) to the Thryve paths
- renames `seedypod.db` (and `-wal`/`-shm`) to `thryve.db`
- renames system users `seedypod-core` / `seedypod-hal` / `seedypod` when present
- rewrites udev rules, Mosquitto passwd/config, and sudoers
- optionally sets the hostname `seedypod` → `thryve` (so the unit answers at `thryve.local`)
- downloads `thryve-core.tar.gz` plus `hald` / `podvision` for this CPU from `kaniick/Thryve` releases, installs them, enables the new units, and starts them

`--migrate-only` does the path and unit rename and leaves the installed software as-is (useful if you will unpack a tarball yourself). `--keep-hostname` leaves `seedypod.local` alone.

Watch the unit come back:

```sh
systemctl is-active thryve-core.service hald.service
curl -fsS http://127.0.0.1:3000/api/system | head
# then open http://thryve.local/ (or http://<the-unit-ip>/)
```

In Apple Home, remove the old seedypod bridge if it still appears, then pair Thryve again from Settings → HomeKit.

## Rollback

The snapshot is under `/var/lib/thryve-migrate-backup-<timestamp>` (the script prints the path). To go back to the seedypod layout and binaries from that snapshot:

```sh
sudo /bin/bash /var/lib/thryve-migrate-backup-<timestamp>/rollback.sh
```

That stops Thryve units, copies the snapshot back over `/opt/seedypod`, `/etc/seedypod` and `/var/lib/seedypod`, re-enables the old systemd units, and starts them. Thryve units are disabled. If you already re-paired HomeKit, you will need to pair the old bridge again.

If `rollback.sh` is missing, the same directory still has the raw trees: stop the new units, copy them back by hand, `systemctl daemon-reload`, enable and start `seedypod-core.service` and `hald.service`.

## Tagging a stable release later

This fork's default branch is `dev`. Merging a PR into `dev` does **not** create `v2.0.0`; it starts the Dev release workflow, which publishes the rolling `dev-latest` prerelease (core tarball plus `hald` and `podvision` for armv6 and aarch64). That is enough for the migration command with `--tag dev-latest`.

To cut a stable release afterwards, push a tag (do this only when you are ready; do not tag from the rebrand PR itself):

```sh
git checkout dev
git pull
git tag -a v2.0.0 -m "Thryve v2.0.0"
git push origin v2.0.0
```

The Analyze & Release workflow runs on `v*` tags and uploads `thryve-core.tar.gz` and the HAL binaries to that GitHub release. (Pushing to a `main` branch still uses semantic-release, as upstream does.)

## After migration, later updates

Once Thryve is installed, the web UI updater and `sudo thryve-update --now` pull from `kaniick/Thryve` (stable = latest tag, or the `dev` channel = `dev-latest`). `SEEDYPOD_*` environment variables are still honoured if the matching `THRYVE_*` name is unset.

## Weak pump / water not reaching the top

seedypod capped the pump at **30 % duty** (`limits.pump_max_duty`) on a 50 Hz software PWM, and every run used that. Thryve keeps **30 % as the default**, and lets you raise it yourself in **Settings → Pump** when water doesn't reach the top.

What the research says to try: the stock Gardyn firmware switches GPIO24 **plain on (100 %)** for each run, about 10.6 W while it lifts water (`docs/hardware/pin-map.md`, read from a stock card). garden-of-eden also defaults to speed 100 (`DEFAULT_PUMP_SPEED`, and its cron examples run `--speed 100`); its README's 30 % cap is an unmeasured "likely too much current" note. The Gardyn 3.0 pump is a 12 V brushless DC pump (TD40A-1248A, 950 mA, 430 cm max head) with its own driver, and chopping its supply at 30 % gives it well under a third of its power. A centrifugal pump's head also falls off faster than its speed. So if the stock SD card lifts water to the top on your unit, expect to need **70–100 %**. Start at 100 % (what stock runs) with the soft start on, and come down only if the Pi misbehaves.

What changed:

- **Duty cycle in Settings → Pump**: a slider from 10 % up to hald's cap, saved when you let go. Every run core sends (schedules, the Run buttons, Autopilot, HomeKit, the Home Assistant bridge, REST, MCP) runs at it, and none goes above it. hald's own paths (the button's double press, and Home Assistant talking to hald directly) use `limits.pump_default_duty`, also 30 %.
- **hald's cap is now 100 %** (`limits.pump_max_duty`), so you *can* go higher than 30 % when you choose. Set it lower in `hal.toml` for a hard ceiling. If your `hal.toml` has an uncommented `pump_max_duty = 30`, the slider stops at 30 and says so: remove that line or raise it, then `sudo systemctl restart hald`.
- **Soft start**, a toggle in Settings → Pump (on by default) with a ramp time from 0.5 to 10 s (default 1.5 s). Each start ramps from 15 % of its duty to all of it, so the pump's inrush doesn't brown the Pi out. Off switches straight on, as stock does. A stop, the end of a run or a safety trip always cuts the pump at once, mid-ramp or not. hald's own default for its paths is `limits.pump_soft_start_ms` (1500, where 0 means none).
- **At 100 % the pin is held high**, as stock does, rather than pulsed by the software-PWM thread. Below 100 % it's still 50 Hz software PWM: GPIO24 has no hardware PWM channel on a Pi (the light has GPIO18), and a faster software PWM would cost a single-core Pi Zero a lot of CPU.
- **Run for 30 s** button. It goes through the same guard as every run: it's refused on a low tank or a latched fault, it's bounded, and it never runs dry.
- The same settings are at `GET`/`POST /api/pump/power`, `PATCH /api/settings` (`pumpPower`, `pumpSoftStart`, `pumpSoftStartMs`) and the MCP tools `pump_power` and `set_pump_power`.
- Safety is unchanged. Every run is bounded by `pump_max_run_s`. The dry-run interlock and over-temp cutoff still refuse and trip. Faults still latch. The INA219 current guard, if you set `pump_dry_current_a`, now waits out the ramp as well as its grace.

### Testing on the unit after migrating

With water in the tank. SSH in and run these on the unit; add `-H "X-API-Key: …"` if you set an API key and run them from another machine.

```sh
# what hald enforces: expect "pump_max_duty": 100.0, "pump_default_duty": 30.0, "pump_soft_start_ms": 1500
hald --config /etc/thryve/hal.toml --check 2>/dev/null | grep -A10 '"limits"'

# core's duty, hald's cap, and the soft start
curl -fsS http://127.0.0.1:3000/api/pump/power

# try the stock level, with the soft start on
curl -fsS -X POST http://127.0.0.1:3000/api/pump/power \
  -H 'content-type: application/json' -d '{"power":100,"softStart":true,"softStartMs":1500}'

# a 30-second run at that duty; watch the water reach the top
curl -fsS -X POST http://127.0.0.1:3000/api/pump/run-once \
  -H 'content-type: application/json' -d '{"durationS":30}'
curl -fsS -X POST http://127.0.0.1:3000/api/pump/stop -H 'content-type: application/json' -d '{}'
```

Or use Settings → Pump: drag the slider, then **Run for 30 s**.

While the pump runs, `curl -fsS http://127.0.0.1:3001/state` shows its level and, with the INA219, `pump_v` and `pump_a`.

### Tuning

- **Water short of the top:** raise the duty in steps of 10 until it reaches the top, then keep the lowest value that does. If it's still short at 100 %, the cause is hardware: check the intake strainer, the tubing and outlet for clogs, that the intake is under water, and the 12 V supply under load.
- **If the Pi reboots (or hald restarts) when the pump starts, lower the power or lengthen the ramp.** Lengthen the ramp first, since that keeps the duty once the pump is up to speed. Turn the soft start on if it's off, try 3 s, then 5 s:

```sh
curl -fsS -X POST http://127.0.0.1:3000/api/pump/power \
  -H 'content-type: application/json' -d '{"softStart":true,"softStartMs":3000}'
# still rebooting: lower the duty
curl -fsS -X POST http://127.0.0.1:3000/api/pump/power \
  -H 'content-type: application/json' -d '{"power":80}'
```

- To change hald's own defaults (the button, Home Assistant direct) or its hard ceiling, edit `[limits]` in `/etc/thryve/hal.toml` (`pump_default_duty`, `pump_soft_start_ms`, `pump_max_duty`) and run `sudo systemctl restart hald`.
- After a reboot, `journalctl -u hald -b -1` shows whether the last boot ended while the pump was starting.

Never run the pump dry: keep water in the tank for every test.
