---
type: "Decision record"
title: "ADR 0012: Deployment and trust model"
description: "Tarball releases with hald binaries, systemd units, LAN-only trust with an opt-in API key."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# ADR 0012: Deployment and trust model

**Status:** Accepted
**Date:** 2026-10-31

## Decision

- `main` releases via semantic-release with `thryve-core.tar.gz` and the
  cross-built `hald` binaries attached; `dev` keeps a rolling `dev-latest`.
- `scripts/install` (core) and `scripts/install-hal` (daemon) set up systemd
  units; `scripts/deploy` ships a local build over SSH.
- **LAN-only trust.** tRPC, REST, MCP and the WebSocket stream have no
  authentication by default. An optional API key (settings) protects
  non-loopback clients; loopback is always exempt so the unit's own UI and
  scripts keep working. Core makes no outbound connections except to brokers
  the operator configures.
- MQTT credentials are stored in plaintext in `device_settings`, for the
  reasons [sleepypod](https://sleepypod.github.io/core/settings/mqtt/) ADR 0019 gives: anyone with the database already owns
  the unit.

## Amendment (2026-11-17)

The unit's own web UI on the LAN cannot send `X-API-Key`. When a key is set,
the UI signs in once and receives an HttpOnly, SameSite=Strict session cookie
that `apiKeyGuard` accepts on `/api/*` (including `/api/ws` and stills).
Loopback remains exempt. `X-Forwarded-For` is honoured only when the socket
peer is already loopback (a local reverse proxy), so a LAN client cannot
spoof loopback to bypass the key. Saving a new key sets the session cookie
on that response so the current browser is not locked out. Recovery from SSH is
`curl -X PATCH http://127.0.0.1:3000/api/settings -H 'Content-Type: application/json' -d '{"apiKey":""}'`
or `/opt/thryve/scripts/thryve-clear-api-key`.

## Amendment (2026-11-17): MCP-only key

The optional key (`settings.apiKey`, Settings → MCP access) now protects
only `/api/mcp` and any path under it. tRPC, the REST facade, WebSocket,
stills and the web UI on the LAN are unauthenticated again, which is the
LAN-trust default this ADR started with. MCP clients send the key as
`X-API-Key` or `Authorization: Bearer`. Loopback remains exempt.
`X-Forwarded-For` is still honoured only when the socket peer is already
loopback. The v2.2.1 web UI session cookie and sign-in screen are removed.
Clear the key with `/opt/thryve/scripts/thryve-clear-api-key` or the
loopback curl in `docs/INSTALLATION.md`.

