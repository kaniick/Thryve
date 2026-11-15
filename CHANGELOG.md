# Changelog

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
