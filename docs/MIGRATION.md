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

This is not caused by the rebrand. seedypod v1.5.0 and current Thryve use the same pump drive: **software PWM at 50 Hz on GPIO24**, with **duty capped at 30%** (`limits.pump_max_duty`). The cap is intentional — the Gardyn board can brown out above about 30%. Scheduled runs that omit a speed use that cap. The INA219 dry-current guard is **off** until you set `pump_dry_current_a` in `hal.toml`, so it is not cutting the pump short by default.

There is no software bug that secretly runs the pump slower than 30%. If water is not reaching the top of the tower, check hardware first, with water in the tank:

- clogged tubing, outlet, or the intake strainer
- intake not submerged, or air in the line
- impeller debris or a failing pump
- 12 V supply sag while the pump and lights are on (measure at the board during a run)

To see what the unit is doing (SSH, on the unit, tank must have water):

```sh
# live HAL picture: duty, voltage, current
curl -fsS http://127.0.0.1:3001/system
curl -fsS http://127.0.0.1:3001/state

# cap in config (path is /etc/seedypod/hal.toml before migration)
grep -n pump_max_duty /etc/thryve/hal.toml || grep -n pump_max_duty /etc/seedypod/hal.toml
```

A 15-second run at the current cap, via the REST API (core on :3000; add `-H "x-api-key: …"` if you set a key):

```sh
curl -fsS -X POST http://127.0.0.1:3000/api/pump/run-once \
  -H 'content-type: application/json' \
  -d '{"durationS":15}'
```

Raising the cap is possible but can brown out the board. Do it only with water in the tank, watching `pump_v` / `pump_a` and that the Pi stays up:

```sh
# example: 35%. Keep this conservative.
sudo sed -i 's/^#\? *pump_max_duty.*/pump_max_duty = 35.0/' /etc/thryve/hal.toml
sudo systemctl restart hald
# then another short run-once, and watch voltage
```

If a short run at 30% already lifts water to the top, the schedule length or frequency is the issue, not duty. If 30% does not, and 35% still does not, treat it as hardware.
