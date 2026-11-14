---
type: "Guide"
title: "thryve OS first-boot checklist"
description: "What to time and check the first time thryve OS boots on a real unit, and how it compares with the two script installs."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-06T23:30:00+00:00"}
sources: [{"resource": "/INSTALLATION.md", "title": "Installation"}, {"resource": "/adr/0021-sd-card-wear-and-recovery.md", "title": "ADR 0021: SD card wear and fast recovery"}]
---

# thryve OS first-boot checklist

CI checks the image inside a chroot under ARM emulation, and `scripts/image/boot-test`
boots it under QEMU's `raspi0`, which has no Wi-Fi, I²C, GPIO, cameras or real SD
timing. This list is what only a real unit can prove. Record the times in
[How long it takes](../INSTALLATION.md#how-long-it-takes).

| Path | Time to core serving pages |
|---|---|
| Script, compiling `better-sqlite3` | about 60 minutes, measured |
| Script, prebuilt `better-sqlite3` | about 6 minutes of scripts, plus the first boot and a reboot; measured as a redeploy |
| thryve OS | to measure here |

## Before power on

1. `scripts/check-image thryve-os.img.xz` passes.
2. Flash through Imager's custom repository with a login, an SSH key and 2.4 GHz Wi-Fi.
   Check that only the Zero boards and **thryve OS** are offered, and that the
   customisation steps appear.
3. `scripts/check-image --card /Volumes/bootfs` prints the login and network you set.
4. `ssh-keygen -R thryve.local`.

## Timing points

Start a stopwatch at power on (T0). Watch from the Mac:

```sh
while ! dns-sd -G v4 thryve.local | grep -m1 -q Add; do sleep 1; done; date   # T1
while ! nc -z thryve.local 22; do sleep 2; done; date                         # T2
while ! curl -fs -o /dev/null http://thryve.local/; do sleep 2; done; date    # T3
```

| Point | What | Script install, for comparison |
|---|---|---|
| T1 | `thryve.local` answers | before SSH |
| T2 | SSH opens | about 3 minutes |
| T3 | `http://thryve.local/` serves **Welcome** | |
| T4 | `systemctl is-system-running` says `running`. Under QEMU it says `degraded`, from `udisks2` and `thryve-usb-recover`, which has no USB there: check `systemctl --failed` for those on a real unit | |

Then a reboot: time power off to T3 again (about 4 minutes on a script install).

## On the unit

```sh
systemd-analyze; systemd-analyze blame | head -15
journalctl -b -u thryve-first-boot --no-pager
```

- [ ] No `sudo` needed for anything so far, and nothing compiled.
- [ ] `df -h /` shows the whole card, and `lsblk` shows `mmcblk0p2` filling it.
- [ ] `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` differs between two cards.
- [ ] `cat /var/lib/thryve-image/unit.env` shows `gardyn-<serial>`, it matches
      `hald --check`, and core shows live sensors.
- [ ] `systemctl status hald thryve-core mosquitto thryve-port80` are all active.
- [ ] `ps -o user= -C hald` says `thryve-hal`; `ps -o user= -C node` says `thryve-core`.
- [ ] `ls /dev/i2c-1` and the sensors read in the app, with no reboot since first boot.
- [ ] The light dims in the app (hardware PWM on GPIO18), with no reboot since first boot.
- [ ] `cat /proc/swaps` shows `/dev/zram0`; `journalctl --disk-usage` reports RAM use only;
      `findmnt -no OPTIONS /` has `noatime`.
- [ ] `ls -l /dev/thryve/` names the cameras, from `thryve-camera-rules.service`.
- [ ] `systemctl status thryve-first-boot` after a reboot says the condition wasn't met.
- [ ] `ls /etc/cloud/cloud-init.disabled` exists after first boot with Wi-Fi up. If Wi-Fi came
      up after cloud-init finished, it appears after the next boot instead. The network
      comes back after a reboot with it off.
- [ ] An SSH login opens with the logo.
- [ ] **Settings → About** shows the board and version; a capture and its analysis work.
- [ ] `sudo` asks for the password you set in Imager.

## Second card, nothing customised

Flash with Imager's customisation skipped, or with `dd`.

- [ ] It boots with no login and no network, and `thryve.local` doesn't appear.
- [ ] Hold the button for 10 seconds: `thryve-setup-xxxx` appears. This is the check
      that the Wi-Fi radio isn't blocked on a card with no country set.
- [ ] Join it, open `http://10.42.0.1:3000/wifi`, join your network. Core's account drives
      this, so it also proves the polkit rule for `thryve-core`.
- [ ] Power off, add `ssh` and `userconf.txt` to `bootfs`
      ([No login on the card](../INSTALLATION.md#no-login-on-the-card)) and log in.

## Third card, login named thryve

- [ ] Imager username `thryve`: the login works and `sudo` works, and hald still runs as
      `thryve-hal`.

## Update and restore

- [ ] Rerun both installers from the login ([Updating](../INSTALLATION.md#updating)).
      Nothing compiles, and `User=` in both units doesn't change.
- [ ] Restore a backup from **Welcome**; `hal.toml` and the unit's history come back.
- [ ] On a Pi Zero 2 W, if one's to hand: T0 to T3 again.
