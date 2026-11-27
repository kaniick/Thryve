---
type: "Guide"
title: "Garden journal"
description: "Review garden activity and outages, follow individual yCubes, run a LAN vision worker, and check the tower before travel."
status: "draft"
generated: {"by": "ChatGPT", "at": "2026-11-27T00:00:00Z"}
sources: [{"resource": "/ANALYSIS.md", "title": "Capture analysis"}, {"resource": "/DEBUGGING.md", "title": "Debugging"}, {"resource": "/MCP.md", "title": "MCP"}]
---

# Garden journal

Use **Garden → Garden journal** or open it from **System → Status**. All checks
are read-only. The journal does not change watering, lighting, camera scheduling
or the pump guard.

## Garden Activity

Activity combines scheduled watering attempts, pump and light reports, tank
warnings, failed analysis frames, camera restart attempts, and gateway/Core
starts. Expand the time window to seven days for an incident or narrow the
display to items needing attention. Older events may fall outside the history
retained by their source. A pump or light report means the hardware reported a
state, not that water actually flowed or that the lamps emitted light.

**Download incident report** saves a JSON timeline of the entire selected
window, including any observer transitions you imported, regardless of the
display filter. It does not include credentials, photos, a database dump,
or the raw probe log. Keep the original observer JSONL for individual
latencies and any deeper comparison with the unit journal.

### Observe from Proxmox

Run the observer on a separate LAN Linux host, such as the Proxmox Utility
container, so it can continue recording if the Pi stops responding. It needs
reachability to TCP 3000 (Core), 3001 (HAL health), and 22 (SSH banner), but
needs no credentials or shell access to the Pi. It does not request photos or
send commands. A failed probe means the observer could not reach that service,
not that the Pi necessarily froze.

After placing this checkout under `/opt/thryve` on the Utility CT, create a
dedicated account once and install the systemd unit:

```sh
id thryve-worker >/dev/null 2>&1 || sudo useradd --system --user-group --shell /usr/sbin/nologin thryve-worker
sudo install -m 0644 /opt/thryve/scripts/services/thryve-observer@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thryve-observer@10.10.20.202.service
```

Substitute the tower's numeric IP. The unit writes one UTC-day JSONL file per
target in `/var/lib/thryve-observer` and keeps seven days. Copy the relevant
files from the CT and choose **Add off-device observer logs** in Garden
Activity. The browser correlates timestamps and shows changes, including
observer coverage gaps. Imported logs are not sent to or stored by the Pi.
Keep the Utility CT and Pi clocks aligned before comparing events.

## Plant history

Go to **Grow → Pod → Open plant history**. The entry follows a yCube across
confirmed moves, including confirmed swaps and plan replant operations. Changes
to pod notes become care events and **Mark harvested** adds an event without
discarding earlier cuts. Archived plants stay in **Past plants** after you clear
a slot. When replacing a yCube with another of the same variety and sow date,
clear the old pod and then record the new one so the journal can tell them apart.

Photos stay tied to their physical camera and slot. The journal shows only
retained photos taken during a recorded stay in each slot. Crops use the current
pod boxes. The migration adopts already planted yCubes with their saved sow
dates and notes, but starts verified occupancy at migration time. It does not
claim to know which slots they occupied before the upgrade.

## Local vision worker

The worker pulls already-stored JPEGs and pod boxes over your LAN. It submits
scores under an independent analyser ID and version. It never captures a new
image, changes a schedule, or makes its analyser primary. **Analysis → Methods
→ Review off-device comparisons** compares the remote score with the built-in
green-cover baseline on the same still. When available it pairs an earlier,
comparable photo of the same plant in the same slot. A difference is evidence
to review, not a health diagnosis.

Enable result ingest in **Settings → Off-device storage and analysis** on the
tower. Copy that token to the worker host, not to a repository.

On the same Utility CT, install the checkout's production dependencies with
the repository's Node and pnpm versions. The worker only imports the bundled
JPEG dependency, so native package build scripts aren't needed for this use.
Install the worker unit, then set its environment file as root:

```sh
cd /opt/thryve
pnpm install --prod --frozen-lockfile --ignore-scripts
sudo install -m 0644 scripts/services/thryve-vision-worker.service /etc/systemd/system/
sudo install -d -m 0755 /etc/thryve
sudoedit /etc/thryve/vision-worker.env
sudo chmod 0600 /etc/thryve/vision-worker.env
```

```ini
THRYVE_URL=http://10.10.20.202:3000
THRYVE_INGEST_TOKEN=replace-with-your-ingest-token
THRYVE_ANALYZER_ID=utility-green
THRYVE_ANALYZER_VERSION=1
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now thryve-vision-worker.service
sudo journalctl -u thryve-vision-worker -n 30 --no-pager
```

The sample unit requires Node 22 or newer on the systemd service's PATH.
It scans up to 96 recent captures every three minutes, processes at most eight
per pass, and saves progress atomically in its systemd state directory. A bad
or dark image is skipped, a network or ingest failure is retried, and a change
to the unit's pod geometry requeues captures in the scan window. For an
explicit one-shot historical pass, run the script with `--limit 500 --rescore`
without `--watch`. Choose the same ID and version only if you intend to replace
those analyser results. See [Capture analysis](ANALYSIS.md#plug-in-an-off-device-analyser).

The built-in scorer is a stricter excess-green method for comparison. To use
a heavier local model, set `THRYVE_SCORER_FILE` to a module on the worker host.
Export a sync or async `score(image, rect, context)` function that returns
a fraction from zero to one, or null when there is no usable score. `image`
contains decoded RGBA data and dimensions, `rect` is the clipped pixel crop,
and `context` identifies the capture, slot, camera and timestamp. Give model
changes a new analyser version so you can compare them separately in Methods.
Only run scorer files you trust on your worker host.

## Trip check

The default checks the next 72 hours. Pick a return time up to seven days
ahead for a particular trip. The result includes:

- Tank runway to the care threshold, based only on fresh tank readings and
  matched trusted history after a refill. Unknown is not an all-clear.
- The most recent observed completed pump run, with any later fault or early
  stop called out separately.
- The last photo from each equipped camera and whether uploads are quiet.
- Chores currently due or expected within the window.

Home Assistant discovers **Garden readiness (72 hours)** when the existing
Core MQTT bridge is connected. Inspect its attributes for evidence and
timestamps. It refreshes every 15 minutes and expires if reports stop.
For S.A.R.A.H., reconnect or refresh the Thryve MCP tool list and use
`garden_readiness`. The optional `until` is an ISO timestamp with timezone
offset. LAN clients can make the same request at `GET /api/garden/readiness`.
