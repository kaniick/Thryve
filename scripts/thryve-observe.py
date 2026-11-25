#!/usr/bin/env python3
"""Read-only gateway probes, run on a second device on the Pi's LAN."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPException
from ipaddress import IPv4Address
import json
import socket
import time


def finish(start, result, **fields):
    return {"result": result, "ms": round((time.monotonic() - start) * 1000), **fields}


def probe_http(host, port, path, timeout):
    start = time.monotonic()
    connection = HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request("GET", path, headers={"Accept": "application/json", "Connection": "close"})
        response = connection.getresponse()
        fields = {"http": response.status}
        if response.status != 200:
            return finish(start, "http_error", **fields)
        body = response.read(4097)
        if len(body) > 4096:
            return finish(start, "unexpected_response", **fields)
        try:
            data = json.loads(body)
        except (ValueError, UnicodeError):
            return finish(start, "unexpected_response", **fields)
        if not isinstance(data, dict) or data.get("ok") is not True:
            return finish(start, "unexpected_response", **fields)
        if type(data.get("uptime_s")) is int:
            fields["uptime_s"] = data["uptime_s"]
        if type(data.get("mqtt_connected")) is bool:
            fields["mqtt_connected"] = data["mqtt_connected"]
        return finish(start, "ok", **fields)
    except TimeoutError:
        return finish(start, "timeout")
    except ConnectionRefusedError:
        return finish(start, "refused")
    except (OSError, HTTPException) as error:
        return finish(start, type(error).__name__)
    finally:
        connection.close()


def probe_ssh(host, timeout, port=22):
    # Connect and look for the server identification. No SSH keys, login or commands.
    start = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout) as conn:
            data = bytearray()
            while len(data) < 512:
                remaining = timeout - (time.monotonic() - start)
                if remaining <= 0:
                    return finish(start, "timeout")
                conn.settimeout(remaining)
                part = conn.recv(512 - len(data))
                if not part:
                    break
                data.extend(part)
                if any(line.startswith(b"SSH-") for line in data.splitlines()):
                    return finish(start, "ok")
            return finish(start, "unexpected_banner")
    except TimeoutError:
        return finish(start, "timeout")
    except ConnectionRefusedError:
        return finish(start, "refused")
    except OSError as error:
        return finish(start, type(error).__name__)


def observe(host, interval, duration):
    # Default to <= one SSH connection each 30s when healthy so the Pi's
    # journal is not filled with banner-only connections. Probe on symptoms too.
    started = time.monotonic()
    next_ssh = started
    with ThreadPoolExecutor(max_workers=3) as pool:
        while True:
            now = time.monotonic()
            if now - started >= duration:
                break
            ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
            core = pool.submit(probe_http, host, 3000, "/api/healthcheck", 2)
            hald = pool.submit(probe_http, host, 3001, "/health", 2)
            ssh = pool.submit(probe_ssh, host, 2) if now >= next_ssh else None
            row = {"ts": ts, "host": host, "core": core.result(), "hald": hald.result()}
            if ssh is None and any(row[key]["result"] != "ok" for key in ("core", "hald")):
                ssh = pool.submit(probe_ssh, host, 2)
            row["ssh"] = None if ssh is None else ssh.result()
            if ssh is not None:
                next_ssh = time.monotonic() + 30
            print(json.dumps(row, separators=(",", ":")), flush=True)
            pause = min(now + interval, started + duration) - time.monotonic()
            if pause > 0:
                time.sleep(pause)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ip", type=IPv4Address, help="Pi's numeric IPv4 on the same LAN, not .local")
    parser.add_argument("--interval", type=int, default=10, help="seconds between samples (5–300)")
    parser.add_argument("--duration", type=int, default=900, help="seconds to run (5–86400)")
    args = parser.parse_args()
    if not 5 <= args.interval <= 300 or not 5 <= args.duration <= 86400:
        parser.error("interval must be 5–300 seconds and duration must be 5–86400 seconds")
    try:
        observe(str(args.ip), args.interval, args.duration)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
