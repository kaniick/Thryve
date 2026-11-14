---
type: "Decision record"
title: "Pump safety limits"
description: "Defaults for max run, duty, dry-run threshold and over-temperature, and where each number came from."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:10:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden/blob/main/config.py", "title": "garden-of-eden config.py (MAX_PUMP_RUN_SECONDS, OVER_TEMP_HIGH, WATER_* defaults)"}, {"resource": "https://github.com/iot-root/garden-of-eden/blob/main/README.md", "title": "garden-of-eden README (pump duty note)"}]
---

# Pump safety limits

| Limit | Default | Provenance | Confidence |
|---|---|---|---|
| `pump_max_run_s` | 900 | Upstream: "follows the Gardyn and pump-vendor guidance" | medium — vendor doc not located |
| `pump_default_duty` | 30 % | seedypod's level, kept as the default; core's duty cycle (Settings → Pump) defaults to it too | — the owner raises it |
| `pump_max_duty` | 100 % (the cap, not the default) | Stock Gardyn firmware drives GPIO24 plain on (pin map, stock fw); garden-of-eden's `DEFAULT_PUMP_SPEED` is 100 and its cron examples run `--speed 100`. Its README's 30 % cap ("likely full on is too much current") is unmeasured, and on a Gardyn 3.0 30 % didn't lift water to the top while stock did (2026-11-14) | medium — confirm no brown-out at 100 % with the INA219 |
| `pump_soft_start_ms` | 1500 | Thryve's own: spreads the pump's inrush over ~75 periods of the 50 Hz PWM; stock switches straight on (0); Settings → Pump can turn it off or change it per run | low — tune on hardware |
| `water_low_cm` | 16 (distance sensor→surface) | Upstream: full ≈ 5 cm, empty ≈ 20 cm; low chosen with ~4 cm margin | low — calibrate per unit |
| `over_temp_c` | 36 (hysteresis 34) | Upstream `OVER_TEMP_HIGH` / `OVER_TEMP_HYSTERESIS` | medium |
| ultrasonic samples | 5 (median) | Upstream alert path; fixes #111 | high |

Each row becomes `stable` once measured on hardware and recorded with a `verified` attestation and a dated log entry.
