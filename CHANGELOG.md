# Changelog

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
