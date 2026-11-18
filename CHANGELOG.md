# Changelog

## Unreleased

## 2.2.3 — 2026-11-17

- Sensors: clicking a card now opens that sensor's history view. In 2.2.2,
  `/sensors/:id` still showed the list because the parent route had no
  outlet (PR #33).

## 2.2.2 — 2026-11-17

- Settings → MCP access: the optional key is required only by MCP clients
  (`POST /api/mcp`, as `X-API-Key` or `Authorization: Bearer`). The web UI,
  tRPC, REST, WebSocket and stills on the LAN no longer need it, and the
  v2.2.1 sign-in screen and session cookie are removed. Analysis ingest and
  `/api/models` tokens are unchanged. `scripts/thryve-clear-api-key` still
  clears the key over loopback (PR #30).
- Settings → Pump: choose the dry-run guard (tank level, pump current, or
  both; there is no off), set the tank and current cutoffs, and use 60% of
  the last wet run. Values go over MQTT, are clamped to `hal.toml` bounds,
  persist in `state.json`, and win at boot if they are still in bounds.
  Narrowing a bound reclamps. A trusted low tank still refuses a start in
  every mode. `current` or `both` without a cutoff or a pump monitor falls
  back to level. Brown-out settings stay on the unit only. Keep any
  customized `*_min_*` / `*_max_*` keys in `hal.toml`; live value lines
  (`pump_dry_guard`, `pump_dry_current_a`, `distance_*`, and the like) can
  stay or be removed once Settings has saved (PR #32).
- Water → Today: the timeline and Recent runs show actual and manual pump
  runs, with a Manual label and actual vs planned duration (PR #32).
- Settings → Tank: ranger sample count, gap, and timeout apply on the next
  read without restarting hald, and a trusted-% shows how many of the last
  hour's tank-level readings were good (PR #32).
- The tank-level SERVICE alert (`setup_water_sensor`) raises only after a
  10-minute majority of suspect readings, and clears with hysteresis, so a
  dropped ping no longer flaps the toast (PR #32).
- A full tank is not treated as dry when the ranger drops a ping or returns
  a short echo: agreed answers near a recent trusted median stay trusted,
  and a start is not refused as unavailable while the last trusted level is
  well above the cutoff (PR #32).
- Sensors → Devices: an unfitted AM2320 on a unit that uses the DHT20 is
  shown muted as not fitted, and no longer inherits the other probe's
  reading or a red error (PR #32).
- Sensors: each card opens a history view with a 24h / 7d / 30d range and
  streamed CSV/JSON export for that sensor or all sensors (PR #32).

## 2.2.1 — 2026-11-17

- Settings → API access: the unit's own web UI stays reachable when an API
  key is set. The browser shows a sign-in screen and receives an HttpOnly,
  SameSite=Strict session cookie (also set automatically when you save a
  newly generated key). Scripts, REST, MCP and Home Assistant still send
  `X-API-Key` or a Bearer token. A 401 is shown as a sign-in (or a specific
  "isn't reachable") screen instead of "core unreachable". `X-Forwarded-For`
  is not trusted from a non-loopback client. If you are locked out, SSH in
  and run `/opt/thryve/scripts/thryve-clear-api-key` or the loopback curl in
  docs/INSTALLATION.md (PR #28).

## 2.2.0 — 2026-11-16

- Notifications: IF/THEN push rules for Pushover, Pushbullet, and an external
  Apprise API server (the unit does not install Python Apprise). Settings →
  Notifications holds the kill switch and quiet hours; the Notifications page
  edits channels and rules. Secrets are stored on the unit, returned masked,
  and kept out of logs and dataset exports. Starter rules (pump fault, tank
  low, unit offline) save disabled. See `docs/NOTIFICATIONS.md` (PR #22).
- Thryve iPhone app channel: APNs push (Key ID, Team ID, bundle ID, and a
  write-only `.p8` key) and watering Live Activity updates when the pump
  runs. Registered devices and activity tokens stay on the unit; a LAN
  notification feed works without an Apple key. Migration
  `0026_ios_notifications` (PR #24).
- Analysis → Pod bounds: opening the view lets you move and resize the boxes
  immediately, with **Save boxes**, **Reset to measured** and **Discard** in
  the toolbar, an unsaved-changes mark, and a toast on success or failure
  (PR #26).
- Settings → Home Assistant bridge: the existing **Test connection** button
  now tests the broker URL, credentials and TLS options entered in the form
  (an empty password keeps the saved one) and reports connected, auth
  refused, unreachable, timeout, DNS or TLS failures without exposing raw
  broker errors. The card explains that it only configures core's
  grow-event bridge — lights, pump and sensors come from the hardware
  daemon — and shows hald's current broker and whether it is connected.
  When `scripts/install` (or a later web update) has installed the
  helper, **Use this broker for hardware** writes the URL and credentials
  to `/etc/thryve/hal.toml`, points core at the same broker, and restarts
  hald. A unit updated from an earlier release needs a one-time
  `sudo scripts/install` before that button appears. Saving other settings
  no longer clears a stored MQTT password. After an update, `index.html`
  is served with `Cache-Control: no-cache, no-store, must-revalidate` so
  the browser does not keep a stale UI (PR #27).

## 2.1.1 — 2026-11-16

- Settings → Home Assistant bridge: **Test connection** uses the saved broker
  URL, credentials and TLS settings in a short-lived MQTT connection, with no
  discovery or command messages. Save any MQTT edits first; the result is
  actionable and does not expose raw broker errors (PR #15).
- Light: a switched-off curve, including Auto when it is off, can be removed
  from the list (with confirmation). Curves that will resume after Auto, and
  enabled curves, stay protected; the server rechecks before deleting (PR #16).

## 2.1.0 — 2026-11-16

Merges upstream seedypod/core work (PRs #255–#272) into Thryve, rebranded, on
top of our pump power, soft start, and pod-bounds editor.

### Analysis and vision

- Suggested labels with provenance, **Accept the rest**, and **Clear** to
  dismiss a suggestion. Suggestion dismissals are stored and travel in
  `thryve-dataset` v4.
- Pod cards and an **All pods** view for charts across the tower.
- Shared pod codes: a unit can share a confirmed code through a GitHub issue
  form; a bot opens a PR on `kaniick/Thryve`. The table of known codes ships
  in the release.
- Sprouting is treated as growing, matching how the model is trained.

### Pump and HAL

- Brown-out guard: stops the pump if the 12 V supply stays below 10.8 V for
  300 ms, or if the Pi reports under-voltage.
- Pump current is sampled every 100 ms while a run is on. Dry-run mode and
  cutoff stay in `hal.toml`; the app may only change the spin-up grace
  (within the unit's bounds). That grace includes the soft-start ramp.
- Stored pump duty (default 30%, Settings → Pump) is unchanged and is not
  overridden by an unnamed start. Soft-start toggle and ramp are unchanged.
- If a scheduled watering is refused, the scheduler retries every minute up
  to 15 times.
- systemd watchdog (10 s) and an `ExecStopPost` pump-off script
  (`/usr/local/lib/thryve/pump-off`). After this update, run
  `sudo scripts/install-hal` once on the unit so those unit files are
  installed; the web updater does not.

### Database

- `0023_label_source` and `0024_suggestion_dismissals` follow our
  `0022_pump_power` migration.

## 2.0.2 — 2026-11-16

- Plant catalog now includes every variety in Gardyn's public plant library
  (141 plants, up from 139). Added Pink Swiss Chard and Oopsy Daisy.
- Lime Basil and Mammoth Basil were already listed, but now have published
  care and harvest data and their own tower/thumbnail models, so they no
  longer appear as generic basil.
- Purslane and bare-root Strawberries are marked as currently sold yCubes.
- Every built-in plant now has a visual model in the Grow view.

## 2.0.1 — 2026-11-14

- Analysis → Pod bounds → Edit boxes: the outer box can be moved or resized,
  and the dashed cup area can be dragged on its own (or nudged with Alt+arrows).
  Per-camera calibration now stores the cup position so leaf-cover analysis
  attributes plants correctly. Existing boxes keep a centred cup by default.

## 2.0.0 — 2026-11-14

Thryve 2.0 is the first stable release of this fork. It is a rebranded, modified
continuation of seedypod v1.5.0, published from `kaniick/Thryve`. Units already
running seedypod can migrate without reflashing; units on `dev-latest` can
update to this release from Settings → Updates by switching the channel to
**Stable**.

### Rebrand

- The product, packages, hostnames, mDNS (`_thryve._tcp`), MQTT prefixes,
  systemd units, file paths and environment variables are Thryve throughout.
- Official plant icon and wordmark (transparent backgrounds) in the web UI,
  favicon, docs site, iOS app icon, SSH login logo and Raspberry Pi Imager.
- Discord links and the hosted Vercel demo have been removed; help points at
  GitHub Issues and the docs at https://kaniick.github.io/Thryve-docs/.
- The iPhone app lives at [kaniick/Thryve-ios](https://github.com/kaniick/Thryve-ios).

### Pump and watering

- Pump duty defaults to 30%, as seedypod did, and can be raised in
  Settings → Pump when water does not reach the top.
- PumpGuard and DoseGuard still bound every run.

### Updates and install

- Software updates (Settings → Updates) pull only from
  `kaniick/Thryve` GitHub releases. **Stable** is the latest `vX.Y.Z` release;
  **Dev** is the rolling `dev-latest` prerelease.
- `thryve-migrate` moves a seedypod v1.5.0 unit onto Thryve names and then
  installs a Thryve release, without reflashing the card.
- Thryve OS images and an Imager repository are published with each release.

### Planner

- The planner can fill empty pods outside preferred light zones when ideal and
  recommended slots are already used, and it keeps that overflow policy when
  a plan is saved, reopened and applied.
