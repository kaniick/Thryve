---
type: "Guide"
title: "Debugging"
description: "SSH, hald --check, journalctl, I²C probing, latched faults, simulator."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "/adr/index.md", "title": "Architecture decision records"}]
---

# Debugging

- `ssh <your-login>@thryve.local`, with the username you gave Raspberry Pi Imager: there's no default `pi` ([Installation → The login](INSTALLATION.md#the-login)).
- `hald --check` validates `hal.toml`; `journalctl -u hald -f` streams the daemon.
- **A watchdog kill.** hald pings systemd from its engine loop; if the loop hangs for 10 s, systemd kills it and restarts it ([hal.md → Watchdog](hardware/hal.md#watchdog)). In `journalctl -u hald` that reads `hald.service: Watchdog timeout (limit 10s)!`, then `Killing process … with signal SIGABRT`, `Failed with result 'watchdog'`, the `pump-off: GPIO24 driven low (pinctrl)` line from the pump-off script, and `Scheduled restart job`. `systemctl show hald -p NRestarts -p WatchdogUSec` counts restarts and shows the limit (`0` means the unit has no watchdog: rerun `sudo scripts/install-hal`). The lines before the timeout show what the loop was last doing. `pump-off: couldn't drive GPIO24 low` means none of `pinctrl`, `raspi-gpio`, sysfs GPIO or `gpioset` worked for hald's user.
- `journalctl -u thryve-core -f` for core; `curl localhost:3000/api/system`.
- **Logs only last until reboot.** `install-hal` keeps the journal in RAM to spare the SD card (ADR-0021). Alerts and faults are still in the database (**Alerts**, `GET /api/alerts`). To chase a crash that needs logs from before a reboot, keep the journal on the card for a while, then turn it back off:

  ```sh
  sudo mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nStorage=persistent\n' | sudo tee /etc/systemd/journald.conf.d/99-debug-persistent.conf
  sudo systemctl restart systemd-journald      # logs now survive reboots
  # … reproduce, reboot, then: journalctl -b -1 -u hald -u thryve-core
  sudo rm /etc/systemd/journald.conf.d/99-debug-persistent.conf && sudo systemctl restart systemd-journald
  ```
- **A line per boot survives.** Each boot adds one line to `/var/lib/thryve/boot-log`, written once USB recovery has finished (90 s or more in) and before any reboot for the USB hub. Download it from **Status**, or `curl localhost:3000/api/system/boot-log`. It keeps about the last 500 boots.

  ```text
  2026-11-07T04:42:17Z clock=synced up=92 boot=ab12cd34 core_s=41 hub=0 hprt0=0x00001c00 cameras=0 reboots=2 clean=1 temp=48.3 errors=3 outcome=reboot
  ```

  `clock=stale` means the unit hadn't reached a time server, so the timestamp may be wrong; `up` is seconds since boot either way. `core_s` is when core's service came up. `hub` is whether the USB hub came up by itself, and `hprt0` is the port register (`0x00001c00` is the stuck SE1 state). `reboots` counts reboots in a row for a missing hub. `clean=0` means the last shutdown wasn't clean, going by ext4 replaying its journal. `errors` counts log lines at error level so far this boot. `outcome` is what recovery did: `up`, `recovered`, `reboot`, `held` (a reboot was needed but not safe), `gave-up` or `none`. `-` means not known. There are no network names, addresses or log text in it.
- **Logs are quiet by default.** On a unit, core and `hald` keep warnings and errors, so pump faults, refusals and raised alerts always show, and drop the routine lines before formatting them. The journal is already in RAM, so this saves CPU and memory rather than card wear. For more, open a timed window; it ends by itself and goes back to what was set:

  ```sh
  curl -X POST localhost:3000/api/system/logging -H 'content-type: application/json' -d '{"debugMinutes":30}'   # everything, for 30 minutes (240 at most)
  curl -X POST localhost:3000/api/system/logging -H 'content-type: application/json' -d '{"debugMinutes":0}'    # end it now
  curl localhost:3000/api/system/logging                                                                        # see what's in force
  ```

  `{"mode":"off"}` keeps errors alone, and `{"mode":"quiet"}` puts it back. That differs from sleepypod's `off`, which keeps nothing, on purpose: a device running a pump must not go silent about a failure. A crash report still reaches the journal. `@homebridge/ciao` is the one known gap: its `FATAL` line goes to `console.log` just before it exits the process, so outside a debug window you only see core exit and restart. The setting is `recording-policy.json` beside the database, read at most once a second, so a change takes effect in about a second with no restart. A damaged file counts as `quiet`, and a `debugUntil` more than 240 minutes away counts as no window. With core on another machine, `hald` stays quiet unless you write that file on the unit (`{"loggingMode":"quiet","debugUntil":<epoch ms>}`). In a debug window `hald` logs what `RUST_LOG` allows, `info` by default. `hald` needs `install-hal` run once for this; until then it logs as before.
- **Core stalls but the Pi is up.** Run these from the unit, during a stall if possible:

  ```sh
  curl -sS --max-time 3 http://127.0.0.1:3000/api/healthcheck
  curl -sS --max-time 3 http://127.0.0.1:3001/health
  curl -sS --max-time 3 http://127.0.0.1:3000/api/system/performance
  sudo journalctl -u thryve-core -b --grep='event loop delayed'
  ```

  The performance endpoint reports the last completed ~30-second window: event-loop utilization (0–1, not CPU load), p95 lag and maximum lag in milliseconds. `core: null` means no window has finished. The journal records windows where the main loop fell at least 1 second behind. A HAL health response is not proof that the pump or light ran on schedule. If SSH and HTTP both disappear, test the unit's numeric IP from the LAN and check the Wi-Fi association and kernel journal independently.
- **Benchmark Core without touching a garden.** Run `node --import tsx tests/perf/core-read-paths.mts` from a checkout with dependencies installed. It creates a temporary synthetic database and measures care checks, settings reads, tank quality, and history sampling. Use the same machine and Node version for comparison. Before rollout to an ARMv6 unit, compare local HTTP and SSH availability across a normal light/watering cycle, and verify that the scheduled runs still happen.
- **Core takes a while after a restart.** It's one bundle (`scripts/build-server.mjs`), because a cold start used to go on resolving `node_modules`. A stack trace points into `server/dist/*.js`, with source maps beside it. The MCP and OpenAPI stacks load on first use, so the first `/api/mcp` or REST call after a restart is slower than the next. V8's compile cache lives in `/var/cache/thryve/compile-cache`, written once a minute after the first start of a version; deleting it is always safe.
- **A restore that didn't finish.** The helper logs each step to `/var/lib/thryve-restore/status.json`. When the web UI starts the restore, it runs as a transient unit: `journalctl -u 'thryve-restore-*'`. `sudo thryve-restore --status` prints the last run. "restore isn't installed" means `scripts/install` hasn't put the helper and its sudoers rule in place; `sudo -n -l /usr/local/sbin/thryve-restore` as the core user should print the path. `sudo thryve-restore --undo` puts back what the last restore replaced. A failed restore puts the old files back by itself.
- **SD card writes:** **Settings → Storage** (or `GET /api/storage/flash`) shows writes per day. To see who is writing, `sudo iotop -ao` or `cat /proc/<pid>/io`; **Settings → SD card → Database** (or `GET /api/storage/database`) splits the database's share by table. `swapon --show` should list only `/dev/zram0`.
- `sudo i2cdetect -y 1` — expect 0x40 (INA219), 0x48 (PCT2075), and 0x38 (DHT20, 3.0+). The AM2320 (1.0/2.0, 0x5C) does **not** answer `i2cdetect`.
- A pump that refuses to start with `fault: "dry-run"` is latched: refill, then acknowledge from the UI, HA, or `POST /api/alerts/{id}/acknowledge` (the id is in `GET /api/alerts`). A doser stuck on `fault: "lockout"` works the same way through the `dose_fault` alert.
- `mosquitto_sub -t 'thryve/#' -v` shows everything `hald` publishes.
- **A pump brown-out.** `brown-out: supply fell to 10.2 V for 0.3 s` (or `brown-out: the Pi reported under-voltage for 1 s`) means the pump's supply sagged under load and hald stopped it; it waits for an acknowledge. Check the power supply and its barrel plug first. `vcgencmd get_throttled` (or `cat /sys/devices/platform/soc/soc:firmware/get_throttled`, which hald reads) prints the Pi's flags in hex: bit 0 (`0x1`) is under-voltage now, bit 16 (`0x10000`) under-voltage at some point since boot; `throttled=0x0` is a clean supply. `hald --check` shows the guard (`pump_brownout_guard`) and whether the flag can be read (`pump_brownout_pi_readable`). If a board browns out at full duty, lower the pump's duty in Settings → Pump, or in `/etc/thryve/hal.toml` (`[limits] pump_max_duty = 60`, say), `sudo systemctl restart hald`, and run the pump from Water: it should lift water to the top without tripping. Go no lower than it takes: below 100 the pump is on 50 Hz PWM, and some pumps then can't lift to the top of the tower. `pump_brownout_v` moves the cutoff (6–12 V, 0 for off).
- **Recording the pump's current** (temporary, #220). `hald --pump-trace <file>` (or `HAL_PUMP_TRACE`) appends the INA219's V, A and W at 4 Hz while the pump runs, and for 2 s after, as CSV: a `# run <time>` line, then `t_s,duty,pump_v,pump_a,pump_w`, with a failed read left blank. The INA219 caches its reading for 500 ms, so that's at least 2 fresh readings a second. (The guard itself skips that cache: it reads the current every 100 ms while the pump runs and stops a pump pulling air about 0.3 s past the 1 s grace, `pump_dry_after_ms` / `pump_dry_grace_ms`. The INA219 averages 128 samples, 68 ms, so a read isn't one random point of the PWM cycle. Which guard runs is `[limits] pump_dry_guard`; `hald --check` prints the one in effect and why, e.g. `"pump_dry_guard": "level"`, `"pump_dry_guard_why": "tank level only: no pump_dry_current_a"`, and `journalctl -u hald | grep 'dry-run guard'` shows it at each start. The grace can also be set on Water, under the pump strip, within `pump_dry_grace_min_ms`–`pump_dry_grace_max_ms`; `GET /api/system` shows the value in effect.) To record a wet run and a short, supervised dry run:

  ```sh
  sudo systemctl edit hald        # add: [Service]  Environment=HAL_PUMP_TRACE=/var/lib/thryve/pump-trace.csv
  sudo systemctl restart hald
  # run the pump from Water, intake in the water; then a dry run of 10 s or less, standing by to stop it
  sudo systemctl revert hald && sudo systemctl restart hald
  ```

  Each run goes in as its own file under `hal/crates/hal-core/fixtures/pump_current/` (`wet.csv`, `dry.csv`) and into `WET_TRACES` / `DRY_TRACES` in `safety.rs`.
- Simulate without hardware: `pnpm dev` runs core against an in-process simulator (no `HAL_MQTT_URL`), with the web UI on :5173. `pnpm dev:sim` does the same with a week of seeded history, pods, a grow cycle and Autopilot rules (`SEED_DEMO=1`, data in `./data/sim`, simulated time at 60×); delete `./data/sim` to start over. For the full chain, run `hald --sim --time-scale 60` and point core at it with `HAL_MQTT_URL`.
