---
type: "Guide"
title: "Notifications"
description: "IF/THEN push rules for Pushover, Pushbullet and an external Apprise API: channels, templates, cooldown, quiet hours and how secrets are stored."
status: "draft"
generated: {"by": "grok-bot", "at": "2026-11-16T19:00:00+00:00"}
sources: [{"resource": "/adr/0013-ha-bridge.md", "title": "ADR 0013: Core-level MQTT bridge for Home Assistant"}, {"resource": "/adr/0020-autopilot-reactive-automations.md", "title": "ADR 0020: Autopilot — reactive automations"}]
---

# Notifications

Schedules and Autopilot can already act on the unit (and Autopilot's *notify*
action still only raises an **in-app alert**). Notifications are a separate
set of IF/THEN rules whose only job is to **push a message off the unit** —
to [Pushover](https://pushover.net), [Pushbullet](https://www.pushbullet.com),
or an [Apprise API](https://github.com/caronc/apprise-api) server you run.

Open **Notifications** in the sidebar, or **Settings → Notifications** for
the kill switch and quiet hours.

## Channels

Add a channel first. Tokens and keys stay on the unit. The API and MCP tools
return them **masked** (last four characters only). They are never written to
the journal, and they are not included in a dataset export. A full **backup**
of the unit includes them, like the MQTT password, so keep backups private.

### Pushover

1. In the [Pushover dashboard](https://pushover.net), copy your **user key**.
2. Create an [application](https://pushover.net/apps/build) and copy its
   **API token**.
3. In Thryve, Notifications → Add channel → Pushover. Paste the user key and
   token. Optionally restrict the message to one device, pick a sound, and
   set emergency retry/expire (used when a rule's priority is *emergency*).
4. **Send test**. You should get a message titled `Thryve: test (…)` on the
   phone or desktop client.

Pushover priorities from a rule: lowest −2, low −1, normal 0, high 1,
emergency 2 (with retry/expire).

### Pushbullet

Paste an **access token** from Pushbullet settings. You may also set a device
iden or a channel tag. **Send test** posts a note.

### Apprise

Thryve does **not** install the Python Apprise package on the Pi. It talks
HTTP to an [Apprise API](https://github.com/caronc/apprise-api) server you
run, for example:

```bash
docker run --name apprise -p 8000:8000 caronc/apprise:latest
```

Then in the channel: set the API URL (`http://apprise.local:8000`), an
optional config key (`POST /notify/{key}`), an optional API key if you locked
the server down, and/or raw Apprise URLs (these often contain tokens and are
stored as secrets).

## Rules

A rule is the same shape as Autopilot, minus hardware actions:

| Part | Choices |
|---|---|
| **When** | An event (pump fault, dry-run, brown-out, alert raised/cleared, pod needs attention or is ready to harvest, a care task is due, light on/off, an update is available, the unit goes offline or comes back, a camera/analysis finding); a sensor threshold (tank level, air or water temperature, humidity, EC, pH); a reading changing; a time of day; or every N minutes. |
| **If** | Optional conditions: a time window, days of the week, value comparisons, or a reading sustained for N minutes (the Autopilot condition AST). |
| **Then** | Notify one or more channels (or every enabled channel) with a title and message template, at a priority. |

Templates accept `{{unit.name}}`, `{{eventLabel}}`, `{{alert.kind}}`,
`{{alert.detail}}`, `{{sensor.water_level_pct}}` (and other sensor ids),
`{{pod.slot}}`, `{{pod.plant}}`, `{{update.tag}}`, `{{time}}` and `{{date}}`.

Starter templates (Pump fault, Tank low, Unit offline) save **disabled**
until you turn one on.

## Rate limits and quiet hours

- **Cooldown** (default 60 minutes) and **dedup**: a flapping tank sensor
  does not spam. The same episode is sent once; a new episode can fire after
  the cooldown.
- **Repeat while it still holds** turns that into a reminder after each
  cooldown.
- **Quiet hours** can be set for the whole unit (Settings → Notifications)
  and tightened per rule. Rules can **ignore quiet hours** (the pump-fault
  starter does). A pulse event that fires during quiet hours is held and sent
  when they end.

The **kill switch** on the Notifications page (and in Settings) stops every
rule. Test sends still go through, so you can check a channel while rules are
off.

## API and MCP

REST/OpenAPI lives under `/api` (see `/api/openapi.json`, tag
`notifications`). tRPC procedures are on `notifications.*`. Secrets are
write-only: omitted fields keep the stored value; an empty string clears one.

MCP tools: `list_notification_channels`, `set_notification_channel`,
`remove_notification_channel`, `test_notification_channel`,
`list_notification_rules`, `set_notification_rule`,
`remove_notification_rule`, `test_notification_rule`,
`set_notifications_enabled`. Test tools send a real push; confirm with the
person first.

Autopilot's `notify` action is unchanged: it still only raises an in-app
alert. A Notifications rule on **alert raised** can then push that alert if
you want it on your phone.
