#!/usr/bin/env python3
"""Summarize or compare read-only thryve-observe.py logs without contacting the unit."""
import argparse
from collections import Counter
from datetime import datetime, timezone
from ipaddress import IPv4Address
import json
from pathlib import Path


PROBES = ("core", "hald", "ssh")


def stamp(ts):
    return ts.isoformat(timespec="milliseconds")


def probe_summary(probes, failures):
    probes.sort()
    ok = len(probes)
    failed = sum(failures.values())
    # Nearest rank, over successful samples only. Timeouts are counted separately.
    p95 = probes[(95 * ok + 99) // 100 - 1] if ok else None
    return {"checked": ok + failed, "ok": ok, "failures": dict(failures), "p95_ms": p95, "max_ms": probes[-1] if ok else None}


def summarize(path, interval):
    host = first = last = None
    probes = {name: [] for name in PROBES}
    failures = {name: Counter() for name in PROBES}
    patterns = Counter()
    samples = gaps = 0
    longest_gap = 0.0
    last_uptime = None
    hald_uptime_drops = []
    first_failed = last_failed = None
    mqtt_disconnected = mqtt_checked = 0
    with path.open(encoding="utf-8") as rows:
        for number, line in enumerate(rows, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("a sample must be an object")
                ts = datetime.fromisoformat(row["ts"].replace("Z", "+00:00"))
                if ts.tzinfo is None:
                    raise ValueError("timestamp needs an explicit offset")
                ts = ts.astimezone(timezone.utc)
                addr = str(IPv4Address(row["host"]))
                if host is not None and host != addr:
                    raise ValueError("mixed gateways in one log")
                if last is not None and ts <= last:
                    raise ValueError("duplicate or out-of-order timestamp")
                states = {}
                for name in PROBES:
                    probe = row[name]
                    if name == "ssh" and probe is None:
                        states[name] = None
                        continue
                    if not isinstance(probe, dict) or not isinstance(probe.get("result"), str) or not probe["result"]:
                        raise ValueError(f"invalid {name} result")
                    ms = probe.get("ms")
                    if type(ms) is not int or ms < 0:
                        raise ValueError(f"invalid {name} latency")
                    state = states[name] = probe["result"] == "ok"
                    if state:
                        probes[name].append(ms)
                    else:
                        failures[name][probe["result"]] += 1
                if states["hald"]:
                    uptime = row["hald"].get("uptime_s")
                    if type(uptime) is int and uptime >= 0:
                        if last_uptime is not None and uptime < last_uptime:
                            hald_uptime_drops.append(stamp(ts))
                        last_uptime = uptime
                    mqtt = row["hald"].get("mqtt_connected")
                    if type(mqtt) is bool:
                        mqtt_checked += 1
                        mqtt_disconnected += int(not mqtt)
            except (KeyError, AttributeError, TypeError, ValueError) as error:
                raise ValueError(f"{path}:{number}: {error}") from error
            if last is not None:
                gap = (ts - last).total_seconds()
                longest_gap = max(longest_gap, gap)
                if gap > 2 * interval:
                    gaps += 1
            if False in states.values():
                if states == {"core": False, "hald": True, "ssh": True}:
                    pattern = "core_only"
                elif states == {"core": True, "hald": True, "ssh": False}:
                    pattern = "ssh_only"
                elif all(state is False for state in states.values()):
                    pattern = "all_three"
                else:
                    pattern = "other"
                patterns[pattern] += 1
                first_failed = first_failed or stamp(ts)
                last_failed = stamp(ts)
            samples += 1
            host = addr
            first = first or ts
            last = ts
    if first is None:
        raise ValueError(f"{path}: no samples")
    return {
        "host": host, "from": stamp(first), "to": stamp(last),
        "observed_seconds": (last - first).total_seconds(), "samples": samples,
        "coverage": {"expected_interval_s": interval, "gaps_over_twice_interval": gaps, "longest_gap_s": longest_gap},
        "services": {name: probe_summary(probes[name], failures[name]) for name in PROBES},
        "failure_patterns": dict(patterns), "first_failed_at": first_failed, "last_failed_at": last_failed,
        "hald_uptime_drops": hald_uptime_drops,
        "hald_mqtt": {"checked": mqtt_checked, "disconnected": mqtt_disconnected},
    }


def show(label, report):
    print(f"{label} on {report['host']}  {report['from']} → {report['to']}")
    coverage = report["coverage"]
    print(f"  {report['samples']} samples across {report['observed_seconds']:g}s. "
          f"{coverage['gaps_over_twice_interval']} gaps over {2 * coverage['expected_interval_s']}s "
          f"(longest {coverage['longest_gap_s']:g}s).")
    for name, service in report["services"].items():
        p95 = service["p95_ms"]
        latency = f"p95 {p95} ms, max {service['max_ms']} ms" if p95 is not None else "no successful latency"
        reason = ", ".join(f"{kind}={n}" for kind, n in service["failures"].items())
        print(f"  {name}: {service['ok']}/{service['checked']} successful checks, {latency}" +
              (f" ({reason})" if reason else ""))
    if report["failure_patterns"]:
        patterns = ", ".join(f"{kind}={n}" for kind, n in report["failure_patterns"].items())
        print(f"  Failure samples: {patterns}. First {report['first_failed_at']}, last {report['last_failed_at']}.")
    mqtt = report["hald_mqtt"]
    print(f"  HAL MQTT disconnected on {mqtt['disconnected']}/{mqtt['checked']} reported checks. "
          f"HAL uptime drops: {len(report['hald_uptime_drops'])} (not proof of a Pi reboot).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path, help="candidate JSONL log")
    parser.add_argument("--baseline", type=Path, help="earlier JSONL log from the same gateway")
    parser.add_argument("--interval", type=int, default=10, help="candidate probe interval, in seconds (default 10)")
    parser.add_argument("--baseline-interval", type=int, help="different interval for the baseline, in seconds")
    parser.add_argument("--json", action="store_true", help="machine-readable report")
    args = parser.parse_args()
    if not 5 <= args.interval <= 300 or (args.baseline_interval is not None and
                                          (not args.baseline or not 5 <= args.baseline_interval <= 300)):
        parser.error("intervals must be 5–300 seconds, and --baseline-interval needs --baseline")
    try:
        report = {"candidate": summarize(args.log, args.interval)}
        if args.baseline:
            before = summarize(args.baseline, args.baseline_interval or args.interval)
            if before["host"] != report["candidate"]["host"]:
                raise ValueError("baseline and candidate are from different gateway addresses")
            report["baseline"] = before
    except (OSError, ValueError) as error:
        parser.error(str(error))
    if args.json:
        print(json.dumps(report))
    else:
        if args.baseline:
            show("Baseline", report["baseline"])
        show("Candidate", report["candidate"])
        print("SSH counts actual banner checks only. Coverage and successful latency do not prove watering or lighting ran.")


if __name__ == "__main__":
    main()
