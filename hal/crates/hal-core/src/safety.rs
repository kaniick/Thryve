//! Pump safety guard (ADR-0009, modelled on sleepypod ADR-0022).
//!
//! Every pump command — from MQTT, HTTP, the button, or a schedule — passes
//! through [`PumpGuard::request`]. The guard is pure and clock-injected so the
//! whole policy is unit-testable without hardware:
//!
//! 1. **Duty clamp** — `level` is clamped to `max_duty` (default 100 %, so an
//!    owner may choose full power, which is how the stock Gardyn firmware
//!    drives the pump). A start that names no level runs at `default_duty`
//!    (30 %, Thryve's Settings default; core names the level for every run
//!    it sends). A start ramps up over its soft start
//!    ([`PumpGuard::output`]) so the motor's inrush can't brown the Pi out.
//! 2. **Bounded runs** — every start carries a deadline ≤ `max_run_s`; there is
//!    no unbounded "on".
//! 3. **Dry-run interlock** — a start is refused when the water distance (median
//!    of N samples, supplied by the caller) exceeds `water_low_cm`. A running
//!    pump stops when trusted readings stay low for [`LEVEL_CONFIRM`], or when
//!    no trusted reading comes for [`DRY_CONFIRM`] (the ranger is gone).
//!    When the last trusted reading is still far above the cutoff, that
//!    absence uses [`DEFAULT_DRY_LEVEL_ABSENT`] (30 s) instead, so a dropped
//!    ping or a missing telemetry round does not stop the pump.
//!    It also stops when its current says it is pulling air: past a spin-up
//!    grace of `dry_grace_ms`, at least [`DRY_MIN_READS`] reads of the pump
//!    monitor in a row, covering `dry_after_ms`, came back below
//!    `dry_current_a` (#220). It raises the same dry-run fault. hald feeds the
//!    guard fast while the pump runs (the current every 100 ms), so the guard
//!    counts reads as well as time.
//! 4. **Brown-out** — past the same spin-up grace, at least
//!    [`DRY_MIN_READS`] reads in a row of the pump supply (the INA219's bus
//!    voltage) below `brownout_v`, covering `brownout_ms`, stop the pump. So do
//!    two reads in a row of the Pi's own under-voltage flag, `brownout_ms` or
//!    more apart. A missing read never trips it.
//! 5. **Over-temperature cutoff** — a start is refused, and a running pump is
//!    stopped, when the PCB temperature is above `over_temp_c`.
//! 6. **Latched faults** — a stop caused by (3), (4) or (5) while running latches
//!    the pump off until [`PumpGuard::acknowledge`] is called. Auto-recovery is
//!    deliberately not offered: a pump that tripped is a hardware signal, not
//!    something to retry at 3 a.m. (sleepypod ADR-0022).

mod dosing;

use std::time::{Duration, Instant};

use crate::contract::{ActuatorCommand, DryGuard};
pub use dosing::{DoseGuard, DoseLedger, DoseLimits, DoseRefusal};

#[derive(Debug, Clone, PartialEq)]
pub struct PumpLimits {
    pub max_run_s: u64,
    pub max_duty: f64,
    /// The level of a start that names none (the button, HA without a speed), under `max_duty`.
    pub default_duty: f64,
    pub water_low_cm: Option<f64>,
    pub over_temp_c: Option<f64>,
    /// Below this pump current (A), past the spin-up grace, the pump is pulling
    /// air. `None` turns the current guard off.
    pub dry_current_a: Option<f64>,
    /// How long the current reads must stay below `dry_current_a` to trip; at
    /// least [`DRY_MIN_READS`] of them, however short this is.
    pub dry_after_ms: u64,
    /// How long after a start the current isn't judged, while the pump spins up and primes.
    /// The soft-start ramp is added on top.
    pub dry_grace_ms: u64,
    /// How long a running pump may go without a trusted reading before a
    /// dry-run, when the last trusted distance is still far above the cutoff.
    /// A lost or suspect ranger with no such reading still uses [`DRY_CONFIRM`].
    pub dry_level_absent_ms: u64,
    /// Soft start: how long a start takes to ramp from [`RAMP_FROM`] of its level to
    /// all of it, so the motor's inrush doesn't brown the board out. 0 starts at once.
    pub soft_start_ms: u64,
    /// Which guard watches a running pump, and whether a low tank refuses a
    /// start: the one in effect, from [`resolve_dry_guard`]. `Current` ignores
    /// the tank level; `Level` ignores the current.
    pub dry_guard: DryGuard,
    /// Below this supply voltage (V), past the spin-up grace, the pump is
    /// browning the board out. `None` turns the voltage check off.
    pub brownout_v: Option<f64>,
    /// How long the supply must stay below `brownout_v`, or the Pi report
    /// under-voltage, to trip; at least [`DRY_MIN_READS`] voltage reads.
    pub brownout_ms: u64,
}

impl Default for PumpLimits {
    fn default() -> Self {
        Self {
            max_run_s: 900,
            max_duty: DEFAULT_MAX_DUTY,
            default_duty: DEFAULT_DUTY,
            water_low_cm: Some(16.0),
            over_temp_c: Some(36.0),
            dry_current_a: None,
            dry_after_ms: 300,
            dry_grace_ms: 1000,
            dry_level_absent_ms: DEFAULT_DRY_LEVEL_ABSENT.as_millis() as u64,
            soft_start_ms: DEFAULT_SOFT_START_MS,
            dry_guard: DryGuard::Both,
            brownout_v: Some(10.8),
            brownout_ms: 300,
        }
    }
}

/// The most any run may drive by default: full power, so an owner can choose it.
/// Gardyn's stock firmware drives the pump fully on.
pub const DEFAULT_MAX_DUTY: f64 = 100.0;

/// What a start that names no level runs at. Core's pump power (Settings › Pump)
/// names the level for every run it sends.
pub const DEFAULT_DUTY: f64 = 30.0;

/// The default soft start, 1.5 s: long enough to spread a small DC pump's inrush
/// over dozens of PWM periods. The dry-current grace is lengthened by the ramp.
pub const DEFAULT_SOFT_START_MS: u64 = 1500;

/// The longest soft start a config may ask for.
pub const MAX_SOFT_START_MS: u64 = 10_000;

/// The share of its level a ramp starts at: enough that the pump is on from the
/// first write, little enough that the stalled motor draws a fraction of its inrush.
pub const RAMP_FROM: f64 = 0.15;

/// The dry-run guard hald runs, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedGuard {
    pub mode: DryGuard,
    pub why: String,
    /// It isn't what hal.toml asked for, or it leaves the pump less guarded: worth a warning.
    pub warn: bool,
}

/// From what hal.toml asks for and what the unit has, the dry-run guard to run.
/// It never leaves the pump with none it was asked for: `current` without a
/// cutoff or a pump monitor falls back to `level`, as does `both`.
pub fn resolve_dry_guard(
    asked: DryGuard,
    cutoff: Option<f64>,
    monitor: bool,
    water_low: bool,
) -> ResolvedGuard {
    let missing = match (cutoff.is_some(), monitor) {
        (true, true) => None,
        (false, true) => Some("pump_dry_current_a"),
        (true, false) => Some("a pump monitor (ina219)"),
        (false, false) => Some("pump_dry_current_a and a pump monitor (ina219)"),
    };
    let (mode, why, warn) = match (asked, missing) {
        (DryGuard::Level, _) => (DryGuard::Level, "tank level, as hal.toml sets".to_owned(), false),
        (DryGuard::Current, None) => (
            DryGuard::Current,
            "pump current only; a trusted low tank still refuses a start".to_owned(),
            false,
        ),
        (DryGuard::Both, None) => (DryGuard::Both, "tank level + pump current".to_owned(), false),
        (DryGuard::Current, Some(m)) => (
            DryGuard::Level,
            format!("pump_dry_guard = \"current\" needs {m}: falling back to the tank level"),
            true,
        ),
        (DryGuard::Both, Some(m)) => (DryGuard::Level, format!("tank level only: no {m}"), true),
    };
    if mode == DryGuard::Level && !water_low {
        let why = format!("{why}; water_low_cm is unset, so no dry-run guard is on");
        return ResolvedGuard {
            mode,
            why,
            warn: true,
        };
    }
    ResolvedGuard { mode, why, warn }
}

/// What the brown-out guard watches, in words, for `hald --check` and the log:
/// the supply voltage needs the cutoff and a pump monitor; the Pi's flag, a
/// readable `get_throttled`.
pub fn describe_brownout(v: Option<f64>, ms: u64, monitor: bool, pi_flag: bool) -> String {
    let secs = amps(ms as f64 / 1000.0);
    let supply = v
        .filter(|_| monitor)
        .map(|v| format!("supply below {} V for {secs} s", amps(v)));
    match (supply, pi_flag) {
        (Some(s), true) => format!("{s}, or the Pi's under-voltage flag"),
        (Some(s), false) => s,
        (None, true) => format!("the Pi's under-voltage flag for {secs} s only"),
        (None, false) if v.is_none() => "off: pump_brownout_v = 0".to_owned(),
        (None, false) => {
            "off: no pump monitor (ina219), and the Pi's under-voltage flag isn't read".to_owned()
        }
    }
}

/// Why a command was refused. Serialised into `ActuatorState.fault` / error replies.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("pump fault latched: {0}; acknowledge before restarting")]
    Latched(String),
    #[error("refused: water level low (dry-run interlock)")]
    WaterLow,
    #[error("refused: board over temperature")]
    OverTemp,
}

/// Live environment the guard needs at decision time.
#[derive(Debug, Clone, Copy, Default)]
pub struct Env {
    /// Median water distance (cm), `None` if the sensor is unavailable.
    pub water_distance_cm: Option<f64>,
    /// Too few pings agreed on that distance: while running it counts as no reading.
    pub water_suspect: bool,
    /// The distance was read since the guard last ticked. The current is read
    /// for every tick, the ranger less often, and one reading must count once.
    pub water_fresh: bool,
    /// PCB temperature (°C), `None` if unavailable.
    pub pcb_temp_c: Option<f64>,
    /// The board's own over-temperature alert line (GPIO25) is asserted.
    pub over_temp_signal: bool,
    /// Pump current (A) from the pump monitor, `None` if there is none or the read failed.
    pub pump_current_a: Option<f64>,
    /// The pump supply (V), the monitor's bus voltage from the same read as the
    /// current; `None` if there is none or the read failed.
    pub supply_v: Option<f64>,
    /// The Pi's under-voltage flag, on the tick it was read: `None` between
    /// reads (it's read once a second) and when it can't be read.
    pub under_voltage: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Drive the pump at `level` until `deadline`.
    Run { level: f64, deadline_in: Duration },
    /// Turn the pump off.
    Stop,
}

/// How long trusted readings must say the water is low while the pump runs
/// before it trips. One reading is never enough: the first starts the count.
pub const LEVEL_CONFIRM: Duration = Duration::from_millis(500);

/// How long the running pump may go without a trusted reading before it trips:
/// the ranger is gone, or hears only stray echoes. It drops a read now and then,
/// most often with the pump stirring the tank; one lost read must not latch a
/// dry-run on a full tank.
pub const DRY_CONFIRM: Duration = Duration::from_secs(3);

/// When the last trusted tank reading is still far above the cutoff, wait this
/// long without a trusted reading before treating the ranger as gone. Long
/// enough to cover a dropped telemetry round (the unit has had a 22 s gap on
/// a full tank) without stopping the pump or raising `water_low`.
pub const DEFAULT_DRY_LEVEL_ABSENT: Duration = Duration::from_secs(30);

/// A last trusted distance this far below `water_low_cm` means the tank is
/// still safely wet: missing or suspect readings must not refuse a start,
/// trip a dry-run, or raise `water_low` until the ranger-gone window elapses.
pub const TANK_SAFE_MARGIN_CM: f64 = 2.0;

/// The fewest low current reads in a row that trip the current guard.
pub const DRY_MIN_READS: u32 = 3;

/// In `current` mode, how long the running pump may go without a reading of its
/// current. There's no other dry-run guard then, so a silent monitor stops it.
pub const CURRENT_LOST: Duration = Duration::from_secs(2);

/// The fault a silent pump monitor latches in `current` mode. It waits for a person.
pub const MONITOR_LOST: &str = "monitor-lost";

/// The fault a dry pump latches, from either guard. The current guard adds why.
pub const DRY_RUN: &str = "dry-run";

/// The fault a sagging supply latches. It waits for a person.
pub const BROWN_OUT: &str = "brown-out";

/// Whether a latched fault is a dry-run (from the level or the current), which
/// clears itself once the water reads good, unlike the others.
pub fn is_dry_run(fault: &str) -> bool {
    fault == DRY_RUN || fault.starts_with("dry-run:")
}

/// Amps (or seconds) for a fault message: `0.4`, `1.25`, `0`.
fn amps(a: f64) -> String {
    let s = format!("{a:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

#[derive(Debug)]
pub struct PumpGuard {
    limits: PumpLimits,
    level: f64,
    running_until: Option<Instant>,
    fault: Option<String>,
    /// When the running pump first saw the water low, missing or suspect, in this run of such readings.
    dry_since: Option<Instant>,
    /// When trusted readings first said the water is low, in this run of them.
    low_since: Option<Instant>,
    /// When this run started, for the current guard's spin-up grace.
    started: Option<Instant>,
    /// This run's soft start, from its command or `limits.soft_start_ms`.
    ramp: Duration,
    /// When the pump current first read below `dry_current_a`, in this run of such reads.
    starved_since: Option<Instant>,
    /// How many reads in a row have been below `dry_current_a`.
    starved_reads: u32,
    /// The last reading of the pump current this run, or its start.
    current_seen: Option<Instant>,
    /// When the supply first read below `brownout_v`, in this run of such reads.
    sag_since: Option<Instant>,
    /// How many voltage reads in this run of them have been below `brownout_v`.
    sag_reads: u32,
    /// The lowest supply voltage in this run of low reads.
    sag_low: f64,
    /// When the Pi first reported under-voltage, in this run of such reads.
    uv_since: Option<Instant>,
    /// How many reads of the Pi's flag in a row have reported under-voltage.
    uv_reads: u32,
    /// Last trusted (non-suspect) water distance, used so a flaky ranger on a
    /// still-wet tank does not fail safe as if the sensor were gone.
    last_trusted_cm: Option<f64>,
}

impl PumpGuard {
    pub fn new(limits: PumpLimits) -> Self {
        Self {
            limits,
            level: 0.0,
            running_until: None,
            fault: None,
            dry_since: None,
            low_since: None,
            started: None,
            ramp: Duration::ZERO,
            starved_since: None,
            starved_reads: 0,
            current_seen: None,
            sag_since: None,
            sag_reads: 0,
            sag_low: f64::INFINITY,
            uv_since: None,
            uv_reads: 0,
            last_trusted_cm: None,
        }
    }

    pub fn limits(&self) -> &PumpLimits {
        &self.limits
    }

    /// The spin-up grace, already clamped by the caller into hal.toml's bounds.
    /// A run under way is judged by the new one from its next read.
    pub fn set_dry_grace_ms(&mut self, ms: u64) {
        self.limits.dry_grace_ms = ms;
    }

    pub fn set_dry_level_absent_ms(&mut self, ms: u64) {
        self.limits.dry_level_absent_ms = ms;
    }

    pub fn set_water_low_cm(&mut self, cm: Option<f64>) {
        self.limits.water_low_cm = cm;
    }

    pub fn set_dry_current_a(&mut self, a: Option<f64>) {
        self.limits.dry_current_a = a;
    }

    pub fn set_dry_guard(&mut self, mode: DryGuard) {
        self.limits.dry_guard = mode;
    }

    /// Note a trusted distance from the environment.
    fn note_trusted(&mut self, env: Env) {
        if let Some(d) = env.water_distance_cm.filter(|_| !env.water_suspect) {
            self.last_trusted_cm = Some(d);
        }
    }

    /// The last trusted reading is still clearly above the cutoff (a shorter
    /// distance than `water_low_cm` by a margin).
    fn last_trusted_is_safe(&self) -> bool {
        match (self.limits.water_low_cm, self.last_trusted_cm) {
            (Some(low), Some(d)) => d + TANK_SAFE_MARGIN_CM < low,
            _ => false,
        }
    }

    /// How long a running pump may go without a trusted reading before a dry-run.
    fn ranger_gone_after(&self) -> Duration {
        if self.last_trusted_is_safe() {
            Duration::from_millis(self.limits.dry_level_absent_ms.max(1))
        } else {
            DRY_CONFIRM
        }
    }

    fn level_on(&self) -> bool {
        self.limits.dry_guard != DryGuard::Current
    }

    fn current_on(&self) -> bool {
        self.limits.dry_guard != DryGuard::Level && self.limits.dry_current_a.is_some()
    }

    pub fn fault(&self) -> Option<&str> {
        self.fault.as_deref()
    }

    pub fn level(&self) -> f64 {
        self.level
    }

    /// The duty to drive right now: the run's level, scaled down while the soft
    /// start ramps up. 0 when not running. Never above the clamped level.
    pub fn output(&self, now: Instant) -> f64 {
        if !self.is_running(now) {
            return 0.0;
        }
        let ramp = self.ramp;
        let Some(started) = self.started else {
            return self.level;
        };
        let t = now.saturating_duration_since(started).as_secs_f64() / ramp.as_secs_f64();
        if ramp.is_zero() || t >= 1.0 || !t.is_finite() {
            return self.level;
        }
        self.level * (RAMP_FROM + (1.0 - RAMP_FROM) * t)
    }

    /// Whether a running pump is still on its soft-start ramp.
    pub fn ramping(&self, now: Instant) -> bool {
        self.is_running(now)
            && self
                .started
                .is_some_and(|s| now.saturating_duration_since(s) < self.ramp)
    }

    pub fn is_running(&self, now: Instant) -> bool {
        self.running_until.is_some_and(|t| t > now)
    }

    pub fn remaining(&self, now: Instant) -> Option<u64> {
        self.running_until
            .map(|t| t.saturating_duration_since(now).as_secs())
    }

    /// Evaluate a command. Returns what the driver should do, or why not.
    pub fn request(&mut self, cmd: &ActuatorCommand, env: Env, now: Instant) -> Result<Decision, Refusal> {
        let want_on = match (cmd.on, cmd.level) {
            (Some(on), _) => on,
            (None, Some(l)) => l > 0.0,
            (None, None) => self.is_running(now),
        };

        if !want_on {
            self.running_until = None;
            self.level = 0.0;
            self.started = None;
            self.ramp = Duration::ZERO;
            self.reset_starved();
            self.reset_brownout();
            return Ok(Decision::Stop);
        }

        if let Some(f) = &self.fault {
            return Err(Refusal::Latched(f.clone()));
        }
        self.note_trusted(env);
        if self.tank_blocks_start(env) {
            return Err(Refusal::WaterLow);
        }
        if self.is_hot(env) {
            return Err(Refusal::OverTemp);
        }

        let level = cmd.level.unwrap_or(if self.level > 0.0 {
            self.level
        } else {
            self.limits.default_duty.min(self.limits.max_duty)
        });
        let level = level.clamp(0.0, self.limits.max_duty);
        let secs = cmd
            .duration_s
            .unwrap_or(self.limits.max_run_s)
            .min(self.limits.max_run_s);
        let deadline_in = Duration::from_secs(secs);
        // A longer run asked for mid-run keeps its spin-up and its count of low reads.
        if !self.is_running(now) {
            self.started = Some(now);
            self.current_seen = Some(now);
            self.reset_starved();
            self.reset_brownout();
            let ms = cmd.soft_start_ms.unwrap_or(self.limits.soft_start_ms);
            self.ramp = Duration::from_millis(ms.min(MAX_SOFT_START_MS));
        }
        self.level = level;
        self.running_until = Some(now + deadline_in);
        self.dry_since = None;
        self.low_since = None;
        Ok(Decision::Run { level, deadline_in })
    }

    /// Periodic check while running. Returns `Some(Stop)` when the pump must be
    /// turned off: deadline reached (clean) or a fault condition (latched).
    pub fn tick(&mut self, env: Env, now: Instant) -> Option<Decision> {
        if !self.is_running(now) {
            if self.running_until.is_some() {
                // Deadline passed: clean end of a bounded run.
                self.running_until = None;
                self.level = 0.0;
                self.started = None;
                self.ramp = Duration::ZERO;
                self.reset_starved();
                self.reset_brownout();
                return Some(Decision::Stop);
            }
            return None;
        }
        if self.level_on() && env.water_fresh && self.tank_ran_dry(env, now) {
            return Some(self.trip(DRY_RUN));
        }
        if let Some(why) = self.monitor_lost(env, now) {
            return Some(self.trip(&why));
        }
        // Before the current guard: a sagging supply draws less too, and should be named for what it is.
        if let Some(why) = self.browning_out(env, now) {
            return Some(self.trip(&why));
        }
        if let Some(why) = self.pulling_air(env, now) {
            return Some(self.trip(&why));
        }
        if self.is_hot(env) {
            return Some(self.trip("over-temp"));
        }
        None
    }

    /// The level guard, on a fresh reading: trusted readings at or past the limit
    /// for [`LEVEL_CONFIRM`], or no trusted reading at all for [`DRY_CONFIRM`].
    /// A suspect reading proves nothing either way: it neither confirms the
    /// water low nor says it is back.
    fn tank_ran_dry(&mut self, env: Env, now: Instant) -> bool {
        let Some(low) = self.limits.water_low_cm else {
            return false;
        };
        self.note_trusted(env);
        match env.water_distance_cm.filter(|_| !env.water_suspect) {
            Some(d) if d < low => {
                self.dry_since = None;
                self.low_since = None;
                false
            }
            Some(_) => {
                self.dry_since.get_or_insert(now);
                let since = *self.low_since.get_or_insert(now);
                now.duration_since(since) >= LEVEL_CONFIRM
            }
            None => {
                self.low_since = None;
                let since = *self.dry_since.get_or_insert(now);
                now.duration_since(since) >= self.ranger_gone_after()
            }
        }
    }

    /// A start is refused on a trusted reading at or past the cutoff, in every
    /// guard mode. Missing or suspect readings refuse only when the last trusted
    /// distance is not still safely above the cutoff.
    fn tank_blocks_start(&self, env: Env) -> bool {
        let Some(low) = self.limits.water_low_cm else {
            return false;
        };
        match env.water_distance_cm.filter(|_| !env.water_suspect) {
            Some(d) => d >= low,
            None => !self.last_trusted_is_safe(),
        }
    }

    /// The current guard: past the spin-up grace, at least [`DRY_MIN_READS`]
    /// reads of the pump current in a row, covering `dry_after_ms`, came back
    /// below `dry_current_a`. A lost read is no evidence of a dry pump, so it
    /// starts the count again and can't trip it.
    fn pulling_air(&mut self, env: Env, now: Instant) -> Option<String> {
        if !self.current_on() {
            return None;
        }
        let (Some(min), Some(started)) = (self.limits.dry_current_a, self.started) else {
            return None;
        };
        if !self.past_grace(now) {
            return None;
        }
        let _ = started;
        match env.pump_current_a {
            Some(a) if a < min => {
                let since = *self.starved_since.get_or_insert(now);
                self.starved_reads += 1;
                let after = self.limits.dry_after_ms;
                let long_enough = now.duration_since(since) >= Duration::from_millis(after);
                (self.starved_reads >= DRY_MIN_READS && long_enough).then(|| {
                    format!(
                        "{DRY_RUN}: pump drew {} A, below {} A for {} s: it's pulling air",
                        amps(a),
                        amps(min),
                        amps(after as f64 / 1000.0)
                    )
                })
            }
            _ => {
                self.reset_starved();
                None
            }
        }
    }

    /// In `current` mode the monitor is the only dry-run guard, so going more
    /// than [`CURRENT_LOST`] without a reading stops the pump. In `both`, a lost
    /// read isn't a dry pump: the level guard is still watching.
    fn monitor_lost(&mut self, env: Env, now: Instant) -> Option<String> {
        if env.pump_current_a.is_some() {
            self.current_seen = Some(now);
            return None;
        }
        let seen = self.current_seen?;
        (self.limits.dry_guard == DryGuard::Current && now.duration_since(seen) > CURRENT_LOST).then(|| {
            format!(
                "{MONITOR_LOST}: no reading of the pump current for {} s, and it's the only dry-run guard",
                CURRENT_LOST.as_secs()
            )
        })
    }

    fn reset_starved(&mut self) {
        self.starved_since = None;
        self.starved_reads = 0;
    }

    /// Past the spin-up grace, which has the inrush in it.
    fn past_grace(&self, now: Instant) -> bool {
        self.started.is_some_and(|s| {
            now.duration_since(s) >= Duration::from_millis(self.limits.dry_grace_ms) + self.ramp
        })
    }

    /// The brown-out guard: at least [`DRY_MIN_READS`] reads of the supply below
    /// `brownout_v`, covering `brownout_ms`, or two reads in a row of the Pi's
    /// under-voltage flag at least `brownout_ms` apart. A good read starts the
    /// count again. A missing read neither counts nor clears it: a supply
    /// sagging far enough can take the monitor's reads with it, and a read that
    /// didn't come is no evidence either way.
    fn browning_out(&mut self, env: Env, now: Instant) -> Option<String> {
        if !self.past_grace(now) {
            return None;
        }
        let after = Duration::from_millis(self.limits.brownout_ms);
        match (self.limits.brownout_v, env.supply_v) {
            (Some(min), Some(v)) if v < min => {
                let since = *self.sag_since.get_or_insert(now);
                self.sag_reads += 1;
                self.sag_low = self.sag_low.min(v);
                if self.sag_reads >= DRY_MIN_READS && now.duration_since(since) >= after {
                    return Some(format!(
                        "{BROWN_OUT}: supply fell to {:.1} V for {} s",
                        self.sag_low,
                        amps(after.as_secs_f64())
                    ));
                }
            }
            (_, Some(_)) => {
                self.sag_since = None;
                self.sag_reads = 0;
                self.sag_low = f64::INFINITY;
            }
            (_, None) => {}
        }
        match env.under_voltage {
            Some(true) => {
                let since = *self.uv_since.get_or_insert(now);
                self.uv_reads += 1;
                let held = now.duration_since(since);
                (self.uv_reads >= 2 && held >= after).then(|| {
                    format!(
                        "{BROWN_OUT}: the Pi reported under-voltage for {} s",
                        amps(held.as_secs_f64())
                    )
                })
            }
            Some(false) => {
                self.uv_since = None;
                self.uv_reads = 0;
                None
            }
            None => None,
        }
    }

    fn reset_brownout(&mut self) {
        self.sag_since = None;
        self.sag_reads = 0;
        self.sag_low = f64::INFINITY;
        self.uv_since = None;
        self.uv_reads = 0;
    }

    /// Latch a fault the guard didn't see itself (the driver wouldn't stop the
    /// pump), ending the run. It clears only via [`PumpGuard::acknowledge`].
    pub fn latch(&mut self, reason: &str) {
        self.trip(reason);
    }

    /// Clear a latched fault. The caller is responsible for having fixed the cause.
    pub fn acknowledge(&mut self) {
        self.fault = None;
    }

    fn trip(&mut self, reason: &str) -> Decision {
        self.fault = Some(reason.to_owned());
        self.dry_since = None;
        self.low_since = None;
        self.started = None;
        self.ramp = Duration::ZERO;
        self.reset_starved();
        self.reset_brownout();
        self.running_until = None;
        self.level = 0.0;
        Decision::Stop
    }

    #[allow(dead_code)]
    fn is_dry(&self, env: Env) -> bool {
        match (self.limits.water_low_cm, env.water_distance_cm) {
            (Some(low), Some(d)) => d >= low,
            // Fail safe: if the interlock is configured but the sensor is gone, refuse.
            (Some(_), None) => true,
            (None, _) => false,
        }
    }

    fn is_hot(&self, env: Env) -> bool {
        env.over_temp_signal
            || matches!((self.limits.over_temp_c, env.pcb_temp_c), (Some(max), Some(t)) if t >= max)
    }
}

/// Median of a small sample set; the guard is fed this, never a single ping
/// (upstream bug #111: guard and alert disagreed because one used a raw read).
/// With an even count it takes the lower middle value, not their mean: a
/// ranger's errors only lengthen (a stray echo, a timer preempted mid-pulse),
/// so one good ping and one bad must not average to a level nobody measured.
pub fn median(samples: &mut [f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = samples.len();
    Some(samples[(n - 1) / 2])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> PumpGuard {
        PumpGuard::new(PumpLimits {
            max_run_s: 900,
            max_duty: 30.0,
            water_low_cm: Some(16.0),
            over_temp_c: Some(36.0),
            soft_start_ms: 0,
            ..PumpLimits::default()
        })
    }
    fn wet() -> Env {
        Env {
            water_distance_cm: Some(7.0),
            water_suspect: false,
            water_fresh: true,
            pcb_temp_c: Some(30.0),
            over_temp_signal: false,
            pump_current_a: Some(1.87),
            supply_v: Some(12.2),
            under_voltage: None,
        }
    }
    fn at(d: Option<f64>) -> Env {
        Env {
            water_distance_cm: d,
            ..wet()
        }
    }
    fn on(level: Option<f64>, duration_s: Option<u64>) -> ActuatorCommand {
        ActuatorCommand {
            on: Some(true),
            level,
            duration_s,
            soft_start_ms: None,
        }
    }
    fn off() -> ActuatorCommand {
        ActuatorCommand {
            on: Some(false),
            level: None,
            duration_s: None,
            soft_start_ms: None,
        }
    }

    #[test]
    fn clamps_duty_to_max() {
        let mut g = guard();
        let d = g.request(&on(Some(100.0), None), wet(), Instant::now()).unwrap();
        assert_eq!(
            d,
            Decision::Run {
                level: 30.0,
                deadline_in: Duration::from_secs(900)
            }
        );
    }

    #[test]
    fn every_run_is_bounded_by_max_run() {
        let mut g = guard();
        let d = g.request(&on(None, Some(36_000)), wet(), Instant::now()).unwrap();
        assert!(matches!(d, Decision::Run { deadline_in, .. } if deadline_in == Duration::from_secs(900)));
    }

    #[test]
    fn bounded_run_ends_cleanly_without_a_fault() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, Some(10)), wet(), t0).unwrap();
        assert!(g.tick(wet(), t0 + Duration::from_secs(5)).is_none());
        assert_eq!(g.tick(wet(), t0 + Duration::from_secs(11)), Some(Decision::Stop));
        assert_eq!(g.fault(), None);
        assert!(!g.is_running(t0 + Duration::from_secs(12)));
    }

    #[test]
    fn refuses_start_when_dry_or_sensor_missing() {
        let mut g = guard();
        assert_eq!(
            g.request(&on(None, None), at(Some(17.0)), Instant::now()),
            Err(Refusal::WaterLow)
        );
        assert_eq!(
            g.request(&on(None, None), at(None), Instant::now()),
            Err(Refusal::WaterLow)
        );
    }

    #[test]
    fn refuses_start_when_hot() {
        let mut g = guard();
        let hot = Env {
            pcb_temp_c: Some(36.5),
            ..wet()
        };
        assert_eq!(
            g.request(&on(None, None), hot, Instant::now()),
            Err(Refusal::OverTemp)
        );
    }

    #[test]
    fn over_temp_signal_refuses_and_trips_even_without_a_temperature_limit() {
        let mut g = PumpGuard::new(PumpLimits {
            over_temp_c: None,
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let signalled = Env {
            over_temp_signal: true,
            ..wet()
        };
        assert_eq!(
            g.tick(signalled, t0 + Duration::from_secs(1)),
            Some(Decision::Stop)
        );
        assert_eq!(g.fault(), Some("over-temp"));
        g.acknowledge();
        assert_eq!(
            g.request(&on(None, None), signalled, t0 + Duration::from_secs(2)),
            Err(Refusal::OverTemp)
        );
    }

    #[test]
    fn a_lost_read_or_a_blip_while_running_does_not_trip() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let lost = at(None);
        // The unit's dry-run on a 3-gallon tank: one read lost mid-run.
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(5)), None);
        assert_eq!(g.tick(wet(), t0 + Duration::from_secs(6)), None);
        // Low again later starts the count afresh.
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(10)), None);
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(12)), None);
        assert_eq!(g.fault(), None);
        // Last trusted is still a wet tank: a few seconds of silence is not a dry-run.
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(13)), None);
        assert_eq!(g.fault(), None);
        // Only after the longer ranger-gone window, starting at the 10 s loss.
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(39)), None);
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(40)), Some(Decision::Stop));
        assert_eq!(g.fault(), Some("dry-run"));
    }

    #[test]
    fn running_dry_trips_on_two_trusted_low_readings_and_latches_until_acknowledged() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let dry = at(Some(16.0));
        let t1 = t0 + Duration::from_secs(60);
        assert_eq!(g.tick(dry, t1), None);
        assert_eq!(g.tick(dry, t1 + Duration::from_millis(400)), None);
        assert_eq!(g.tick(dry, t1 + LEVEL_CONFIRM), Some(Decision::Stop));
        assert_eq!(g.fault(), Some("dry-run"));
        // Even with water back, the latch holds.
        assert!(matches!(
            g.request(&on(None, None), wet(), t0 + Duration::from_secs(61)),
            Err(Refusal::Latched(_))
        ));
        g.acknowledge();
        assert!(g
            .request(&on(None, None), wet(), t0 + Duration::from_secs(62))
            .is_ok());
    }

    #[test]
    fn one_reading_counts_once_however_often_the_guard_ticks() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let low = at(Some(18.0));
        let stale = Env {
            water_fresh: false,
            ..low
        };
        let ms = |n| t0 + Duration::from_millis(n);
        assert_eq!(g.tick(low, ms(1000)), None);
        // Ticks between ranger reads carry the same reading: they confirm nothing.
        for n in (1100..=3900).step_by(100) {
            assert_eq!(g.tick(stale, ms(n)), None, "{n} ms");
        }
        // The next reading is the second: now it trips.
        assert_eq!(g.tick(low, ms(4000)), Some(Decision::Stop));
    }

    #[test]
    fn suspect_readings_neither_confirm_the_water_low_nor_say_it_is_back() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let suspect = |d| Env {
            water_suspect: true,
            ..at(Some(d))
        };
        let s = |n| t0 + Duration::from_secs(n);
        // Suspect lows don't trip in LEVEL_CONFIRM: a stray echo reads long.
        assert_eq!(g.tick(suspect(40.0), s(1)), None);
        assert_eq!(g.tick(suspect(40.0), s(2)), None);
        // A suspect good one doesn't clear the count either.
        assert_eq!(g.tick(suspect(7.0), s(3)), None);
        assert_eq!(g.fault(), None);
        // Last trusted is still a wet tank: DRY_CONFIRM is not enough to trip.
        assert_eq!(g.tick(suspect(7.0), s(4)), None);
        assert_eq!(g.fault(), None);
        // Only after the longer ranger-gone window.
        assert_eq!(g.tick(suspect(7.0), s(30)), None);
        assert_eq!(g.tick(suspect(7.0), s(31)), Some(Decision::Stop));
        assert_eq!(g.fault(), Some("dry-run"));
        // A trusted good reading does clear it.
        g.acknowledge();
        g.request(&on(None, None), wet(), s(10)).unwrap();
        assert_eq!(g.tick(suspect(40.0), s(11)), None);
        assert_eq!(g.tick(wet(), s(12)), None);
        assert_eq!(g.tick(suspect(40.0), s(14)), None);
        assert_eq!(g.tick(at(Some(17.0)), s(15)), None);
        assert_eq!(g.fault(), None);
    }

    /// The unit's full-tank telemetry, 2026-11-17 UTC: good 8.04–8.11 cm,
    /// intermittent "suspect" rounds at the same surface, a 22 s missing
    /// round, and a 3.67 cm short stray. A running pump must not dry-run, and
    /// a start mid-sequence must not be refused.
    #[test]
    fn a_full_tank_stream_with_drops_a_gap_and_a_short_stray_does_not_dry_run() {
        let mut g = guard();
        let t0 = Instant::now();
        let at_ts = |secs: f64| t0 + Duration::from_secs_f64(secs);
        // Seconds from 04:13:16, matching the published stream.
        let rounds: &[(f64, Option<f64>, bool)] = &[
            (0.0, Some(8.07), false),
            (10.0, Some(8.09), false),
            (20.0, Some(8.05), false),
            (30.0, Some(8.11), false),
            (40.0, Some(8.04), false),
            (50.0, Some(8.10), false),
            (60.0, Some(8.08), false),
            (70.0, Some(8.07), false),
            // Thin rounds at 8.08/8.06 were published "suspect"; the median
            // now trusts them (same surface as the last good 8.04–8.11 cm).
            (80.0, Some(8.08), false),  // 04:14:36
            (91.0, Some(8.06), false),  // 04:14:47
            (101.0, None, false),       // 04:14:57 missing round (22 s gap)
            (113.0, Some(8.06), false), // 04:15:09
            (123.0, Some(8.07), false),
            (133.0, Some(8.09), false),
            (143.0, Some(8.05), false),
            (153.0, Some(8.10), false),
            (167.0, Some(8.08), false), // 04:16:03
            (178.0, Some(3.67), true),  // 04:16:14 short stray: not trusted
            (188.0, Some(8.07), false),
        ];
        g.request(&on(None, Some(900)), at(Some(8.07)), t0).unwrap();
        for &(secs, d, suspect) in rounds {
            let env = Env {
                water_suspect: suspect || d.is_none(),
                water_fresh: true,
                ..at(d)
            };
            assert_eq!(g.tick(env, at_ts(secs)), None, "tripped at +{secs} s, d={d:?}");
            assert_eq!(g.fault(), None, "fault at +{secs} s");
        }
        assert!(g.is_running(at_ts(188.0)));

        // A start asked in the 22 s gap, on a thin 8.06, or on the 3.67 stray,
        // is accepted: the last trusted reading is still a full tank.
        for &(secs, d, suspect) in rounds {
            if !matches!(secs, 91.0 | 101.0 | 113.0 | 178.0) {
                continue;
            }
            let mut g2 = guard();
            let seed = at(Some(8.07));
            g2.request(&on(None, Some(5)), seed, t0).unwrap();
            g2.request(&off(), seed, at_ts(1.0)).unwrap();
            let env = Env {
                water_suspect: suspect || d.is_none(),
                water_fresh: true,
                ..at(d)
            };
            assert!(
                g2.request(&on(None, Some(5)), env, at_ts(secs)).is_ok(),
                "start refused at +{secs} s, d={d:?}"
            );
        }
    }

    #[test]
    fn stop_always_works_even_when_latched() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        g.latch("stop-failed: test");
        assert_eq!(g.fault(), Some("stop-failed: test"));
        assert!(!g.is_running(t0));
        assert!(!is_dry_run(g.fault().unwrap()));
        assert_eq!(
            g.request(&off(), wet(), t0 + Duration::from_secs(2)),
            Ok(Decision::Stop)
        );
    }

    #[test]
    fn interlock_disabled_when_unconfigured() {
        let mut g = PumpGuard::new(PumpLimits {
            water_low_cm: None,
            over_temp_c: None,
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let env = Env {
            pcb_temp_c: None,
            pump_current_a: None,
            ..at(None)
        };
        let t0 = Instant::now();
        assert!(g.request(&on(None, None), env, t0).is_ok());
        for n in 1..10 {
            assert_eq!(g.tick(env, t0 + Duration::from_secs(n)), None);
        }
    }

    // ---- which guard: pump_dry_guard ------------------------------------------

    fn mode(m: DryGuard) -> PumpGuard {
        PumpGuard::new(PumpLimits {
            dry_current_a: Some(1.2),
            dry_guard: m,
            soft_start_ms: 0,
            ..PumpLimits::default()
        })
    }

    fn air() -> Env {
        Env {
            pump_current_a: Some(0.3),
            ..wet()
        }
    }

    #[test]
    fn level_mode_watches_the_tank_and_never_the_current() {
        let mut g = mode(DryGuard::Level);
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        assert_eq!(
            g.request(&on(None, None), at(Some(17.0)), t0),
            Err(Refusal::WaterLow)
        );
        g.request(&on(None, None), wet(), t0).unwrap();
        for n in 1..60 {
            assert_eq!(g.tick(air(), ms(n * 100)), None, "{n}");
        }
        assert_eq!(g.tick(at(Some(17.0)), ms(6000)), None);
        assert_eq!(g.tick(at(Some(17.0)), ms(6500)), Some(Decision::Stop));
        assert_eq!(g.fault(), Some(DRY_RUN));
    }

    #[test]
    fn current_mode_watches_the_current_and_never_the_tank() {
        let mut g = mode(DryGuard::Current);
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        // A trusted low tank refuses a start in every mode. A silent ranger
        // after a wet reading does not, and a low or silent tank does not stop a run.
        assert_eq!(
            g.request(&on(None, None), at(Some(17.0)), t0),
            Err(Refusal::WaterLow)
        );
        g.request(&on(None, None), wet(), t0).unwrap();
        g.request(&off(), wet(), ms(10)).unwrap();
        g.request(&on(None, None), at(None), ms(20)).unwrap();
        for n in 1..60 {
            assert_eq!(g.tick(at(Some(40.0)), ms(20 + n * 100)), None, "{n}");
            assert_eq!(g.tick(at(None), ms(20 + n * 100 + 50)), None, "{n}");
        }
        for n in [6000, 6100, 6200] {
            assert_eq!(g.tick(air(), ms(n)), None);
        }
        assert_eq!(g.tick(air(), ms(6300)), Some(Decision::Stop));
        assert!(g.fault().unwrap().contains("pulling air"));
    }

    #[test]
    fn both_mode_stops_on_either_guard() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let mut g = mode(DryGuard::Both);
        assert_eq!(
            g.request(&on(None, None), at(Some(17.0)), t0),
            Err(Refusal::WaterLow)
        );
        g.request(&on(None, None), wet(), t0).unwrap();
        assert_eq!(g.tick(at(Some(17.0)), ms(2000)), None);
        assert_eq!(g.tick(at(Some(17.0)), ms(2500)), Some(Decision::Stop));
        let mut g = mode(DryGuard::Both);
        g.request(&on(None, None), wet(), t0).unwrap();
        for n in [1000, 1100, 1200] {
            assert_eq!(g.tick(air(), ms(n)), None);
        }
        assert_eq!(g.tick(air(), ms(1300)), Some(Decision::Stop));
    }

    #[test]
    fn in_current_mode_a_silent_monitor_stops_the_pump_and_in_both_it_does_not() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let lost = Env {
            pump_current_a: None,
            ..wet()
        };
        let mut g = mode(DryGuard::Current);
        g.request(&on(None, None), wet(), t0).unwrap();
        assert_eq!(g.tick(lost, ms(1000)), None);
        // A reading starts the 2 s again.
        assert_eq!(g.tick(wet(), ms(1500)), None);
        assert_eq!(g.tick(lost, ms(3000)), None);
        assert_eq!(g.tick(lost, ms(3500)), None);
        assert_eq!(g.tick(lost, ms(3600)), Some(Decision::Stop));
        let f = g.fault().unwrap();
        assert!(f.starts_with(MONITOR_LOST), "{f}");
        assert!(!is_dry_run(f), "it waits for a person");
        // A new run counts from its start, whatever the last one saw.
        g.acknowledge();
        g.request(&on(None, None), wet(), ms(10_000)).unwrap();
        assert_eq!(g.tick(lost, ms(11_900)), None);
        assert_eq!(g.tick(lost, ms(12_100)), Some(Decision::Stop));
        // In both, the level guard still watches: lost reads are no dry pump.
        let mut g = mode(DryGuard::Both);
        g.request(&on(None, None), wet(), t0).unwrap();
        for n in 1..600 {
            assert_eq!(g.tick(lost, ms(n * 100)), None, "{n}");
        }
    }

    #[test]
    fn a_new_grace_judges_the_run_from_its_next_read() {
        let mut g = current_guard();
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        g.set_dry_grace_ms(2000);
        assert_eq!(g.limits().dry_grace_ms, 2000);
        g.request(&on(None, None), wet(), t0).unwrap();
        for n in (1000..2000).step_by(100) {
            assert_eq!(g.tick(air(), ms(n)), None, "{n}");
        }
        g.set_dry_grace_ms(500);
        for n in [2000, 2100, 2200] {
            assert_eq!(g.tick(air(), ms(n)), None);
        }
        assert_eq!(g.tick(air(), ms(2300)), Some(Decision::Stop));
    }

    #[test]
    fn the_guard_falls_back_to_the_tank_level_and_says_why() {
        let r = |asked, cutoff, monitor, low| resolve_dry_guard(asked, cutoff, monitor, low);
        let ok = r(DryGuard::Both, Some(1.2), true, true);
        assert_eq!((ok.mode, ok.warn), (DryGuard::Both, false));
        assert_eq!(ok.why, "tank level + pump current");
        let c = r(DryGuard::Current, Some(1.2), true, false);
        assert_eq!(
            (c.mode, c.warn),
            (DryGuard::Current, false),
            "water_low_cm doesn't matter"
        );
        assert!(c.why.contains("a trusted low tank still refuses a start"));
        let l = r(DryGuard::Level, Some(1.2), true, true);
        assert_eq!((l.mode, l.warn), (DryGuard::Level, false));
        for (asked, cutoff, monitor, needs) in [
            (DryGuard::Current, None, true, "pump_dry_current_a"),
            (DryGuard::Current, Some(1.2), false, "a pump monitor (ina219)"),
            (
                DryGuard::Current,
                None,
                false,
                "pump_dry_current_a and a pump monitor (ina219)",
            ),
        ] {
            let f = r(asked, cutoff, monitor, true);
            assert_eq!((f.mode, f.warn), (DryGuard::Level, true));
            assert_eq!(
                f.why,
                format!("pump_dry_guard = \"current\" needs {needs}: falling back to the tank level")
            );
        }
        // Today's unit: both asked, no cutoff yet.
        let today = r(DryGuard::Both, None, true, true);
        assert_eq!((today.mode, today.warn), (DryGuard::Level, true));
        assert_eq!(today.why, "tank level only: no pump_dry_current_a");
        let none = r(DryGuard::Level, None, true, false);
        assert!(
            none.warn
                && none
                    .why
                    .ends_with("water_low_cm is unset, so no dry-run guard is on")
        );
    }

    // ---- the current guard (#220) -------------------------------------------

    /// Synthetic 30% traces at the capture rate (4 Hz) and the rate hald
    /// now feeds the guard (10 Hz). Measured 100% traces are tested separately.
    const WET_TRACES: &[(&str, &str)] = &[
        (
            "wet.synthetic",
            include_str!("../fixtures/pump_current/wet.synthetic.csv"),
        ),
        (
            "lost_reads.synthetic",
            include_str!("../fixtures/pump_current/lost_reads.synthetic.csv"),
        ),
        (
            "wet.10hz.synthetic",
            include_str!("../fixtures/pump_current/wet.10hz.synthetic.csv"),
        ),
        (
            "lost_reads.10hz.synthetic",
            include_str!("../fixtures/pump_current/lost_reads.10hz.synthetic.csv"),
        ),
    ];
    /// Dry traces and the time between their reads (ms).
    const DRY_TRACES: &[(&str, &str, u64)] = &[
        (
            "dry.synthetic",
            include_str!("../fixtures/pump_current/dry.synthetic.csv"),
            250,
        ),
        (
            "dry.10hz.synthetic",
            include_str!("../fixtures/pump_current/dry.10hz.synthetic.csv"),
            100,
        ),
    ];

    /// The cutoff the traces are judged against: well under the 1.87 A seen wet at 30 % duty.
    fn current_guard() -> PumpGuard {
        PumpGuard::new(PumpLimits {
            dry_current_a: Some(1.2),
            soft_start_ms: 0,
            ..PumpLimits::default()
        })
    }

    /// `(ms since the start, pump_a)` per sample; an empty `pump_a` is a failed read.
    fn trace(csv: &str) -> Vec<(u64, Option<f64>)> {
        let mut rows = csv
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'));
        let header: Vec<&str> = rows.next().expect("a header row").split(',').collect();
        let col = |name| header.iter().position(|h| *h == name).expect(name);
        let (t, a) = (col("t_s"), col("pump_a"));
        rows.map(|l| {
            let f: Vec<&str> = l.split(',').collect();
            let s: f64 = f[t].parse().expect("t_s");
            ((s * 1000.0).round() as u64, f[a].trim().parse().ok())
        })
        .collect()
    }

    /// Plays a trace through a running pump with a full tank: when (ms) it tripped and why.
    fn replay(g: &mut PumpGuard, csv: &str) -> Option<(u64, String)> {
        replay_with(g, csv, &on(None, None))
    }

    fn replay_with(g: &mut PumpGuard, csv: &str, command: &ActuatorCommand) -> Option<(u64, String)> {
        let t0 = Instant::now();
        g.request(command, wet(), t0).unwrap();
        trace(csv).into_iter().find_map(|(ms, a)| {
            let env = Env {
                pump_current_a: a,
                ..wet()
            };
            let stop = g.tick(env, t0 + Duration::from_millis(ms));
            stop.map(|_| (ms, g.fault().unwrap_or("no fault").to_owned()))
        })
    }

    // Seedypod's supervised wet and air-locked runs at 100% duty, 2026-11-16.
    // Replay only. The trace profile is not a default or a calibration for another pump.
    // Source: https://github.com/seedypod/core/pull/275
    const MEASURED_WET: &str = include_str!("../fixtures/pump_current/wet.unit-2026-11-16.csv");
    const MEASURED_DRY: &str = include_str!("../fixtures/pump_current/dry.unit-2026-11-16.csv");

    fn measured_guard(grace_ms: u64) -> PumpGuard {
        PumpGuard::new(PumpLimits {
            dry_current_a: Some(0.8),
            dry_grace_ms: grace_ms,
            soft_start_ms: 0,
            ..PumpLimits::default()
        })
    }

    #[test]
    fn measured_wet_run_distinguishes_spin_up_from_a_dry_fault() {
        assert!(trace(MEASURED_WET).len() > 100);
        let full_duty = on(Some(100.0), Some(180));
        assert_eq!(
            replay_with(&mut measured_guard(3000), MEASURED_WET, &full_duty),
            None
        );
        let (at, fault) = replay_with(&mut measured_guard(1000), MEASURED_WET, &full_duty)
            .expect("the recorded wet pump was still spinning up");
        assert!((1000..3000).contains(&at), "tripped at {at} ms");
        assert!(is_dry_run(&fault), "{fault}");
    }

    #[test]
    fn measured_air_locked_run_trips_after_the_intake_loses_water() {
        assert!(trace(MEASURED_DRY).len() > 100);
        let (at, fault) = replay_with(
            &mut measured_guard(3000),
            MEASURED_DRY,
            &on(Some(100.0), Some(180)),
        )
        .expect("the guard must trip when the measured current drops");
        // Wet for 30 s; readings are consistently below the cutoff after ~31.07 s.
        assert!((31_000..=32_100).contains(&at), "tripped at {at} ms");
        assert!(is_dry_run(&fault), "{fault}");
        assert!(fault.contains("below 0.8 A"), "{fault}");
    }

    #[test]
    fn wet_traces_never_trip_the_current_guard() {
        for (name, csv) in WET_TRACES {
            assert!(trace(csv).len() > 100, "{name} is too short to mean anything");
            let mut g = current_guard();
            assert_eq!(replay(&mut g, csv), None, "{name}");
        }
    }

    #[test]
    fn dry_traces_trip_within_the_grace_and_the_confirm_time() {
        for (name, csv, every) in DRY_TRACES {
            let mut g = current_guard();
            let (at, fault) = replay(&mut g, csv).unwrap_or_else(|| panic!("{name} never tripped"));
            let l = g.limits().clone();
            assert!(at >= l.dry_grace_ms + l.dry_after_ms, "{name} tripped at {at} ms");
            // The first read judged lands within one read of the grace ending.
            assert!(
                at <= l.dry_grace_ms + l.dry_after_ms.max(*every * (DRY_MIN_READS as u64 - 1)) + every,
                "{name} tripped late, at {at} ms"
            );
            assert!(is_dry_run(&fault), "{fault}");
            assert!(
                fault.contains("below 1.2 A for 0.3 s: it's pulling air"),
                "{fault}"
            );
        }
        // At 10 Hz: the grace, then 0.3 s of low reads.
        let (at, _) = replay(&mut current_guard(), DRY_TRACES[1].1).unwrap();
        assert_eq!(at, 1300);
    }

    #[test]
    fn the_fault_names_the_current_and_latches_like_a_dry_run() {
        let mut g = current_guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let air = Env {
            pump_current_a: Some(0.4),
            ..wet()
        };
        let ms = |n| t0 + Duration::from_millis(n);
        // Spin-up: nothing is judged in the grace, however low.
        for n in (100..1000).step_by(100) {
            assert_eq!(g.tick(air, ms(n)), None, "{n} ms");
        }
        assert_eq!(g.tick(air, ms(1000)), None);
        assert_eq!(g.tick(air, ms(1100)), None);
        assert_eq!(g.tick(air, ms(1200)), None);
        assert_eq!(g.tick(air, ms(1300)), Some(Decision::Stop));
        assert_eq!(
            g.fault(),
            Some("dry-run: pump drew 0.4 A, below 1.2 A for 0.3 s: it's pulling air")
        );
        assert!(!g.is_running(ms(1300)));
        assert!(matches!(
            g.request(&on(None, None), wet(), ms(2000)),
            Err(Refusal::Latched(f)) if f.contains("pulling air")
        ));
        g.acknowledge();
        assert!(g.request(&on(None, None), wet(), ms(3000)).is_ok());
    }

    #[test]
    fn it_takes_three_low_reads_in_a_row_however_slowly_they_come() {
        let mut g = PumpGuard::new(PumpLimits {
            dry_current_a: Some(1.2),
            dry_after_ms: 100,
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let air = Env {
            pump_current_a: Some(0.4),
            ..wet()
        };
        let s = |n| t0 + Duration::from_secs(n);
        assert_eq!(g.tick(air, s(2)), None);
        assert_eq!(g.tick(air, s(3)), None);
        assert_eq!(g.tick(air, s(4)), Some(Decision::Stop));
        assert!(g.fault().unwrap().contains("for 0.1 s"));
    }

    #[test]
    fn a_lost_or_good_read_starts_the_current_count_again() {
        let mut g = current_guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let at = |a| Env {
            pump_current_a: a,
            ..wet()
        };
        let ms = |n| t0 + Duration::from_millis(n);
        assert_eq!(g.tick(at(Some(0.3)), ms(1000)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(1100)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(1200)), None);
        assert_eq!(g.tick(at(None), ms(1300)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(1400)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(1500)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(1600)), None);
        assert_eq!(g.tick(at(Some(1.5)), ms(1700)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(1800)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(1900)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(2000)), None);
        assert_eq!(g.tick(at(Some(0.3)), ms(2100)), Some(Decision::Stop));
        assert_eq!(
            g.fault(),
            Some("dry-run: pump drew 0.3 A, below 1.2 A for 0.3 s: it's pulling air")
        );
    }

    #[test]
    fn a_monitor_that_reads_nothing_never_trips_the_current_guard() {
        let mut g = current_guard();
        let t0 = Instant::now();
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        let lost = Env {
            pump_current_a: None,
            ..wet()
        };
        for n in (100..59_000).step_by(100) {
            assert_eq!(g.tick(lost, t0 + Duration::from_millis(n)), None, "{n} ms");
        }
        assert_eq!(g.fault(), None);
    }

    #[test]
    fn a_longer_run_asked_for_mid_run_keeps_counting_and_a_new_run_gets_its_grace() {
        let mut g = current_guard();
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let air = Env {
            pump_current_a: Some(0.2),
            ..wet()
        };
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        assert_eq!(g.tick(air, ms(1000)), None);
        assert_eq!(g.tick(air, ms(1100)), None);
        g.request(&on(None, Some(120)), wet(), ms(1150)).unwrap();
        assert_eq!(g.tick(air, ms(1200)), None);
        assert_eq!(g.tick(air, ms(1300)), Some(Decision::Stop));
        g.acknowledge();
        // Stopped by hand mid-count, a new run spins up again before it's judged.
        g.request(&on(None, Some(60)), wet(), ms(5000)).unwrap();
        assert_eq!(g.tick(air, ms(6000)), None);
        assert_eq!(g.tick(air, ms(6100)), None);
        g.request(&off(), wet(), ms(6150)).unwrap();
        g.request(&on(None, Some(60)), wet(), ms(6200)).unwrap();
        for n in (6300..7200).step_by(100) {
            assert_eq!(g.tick(air, ms(n)), None, "{n} ms");
        }
        assert_eq!(g.tick(air, ms(7200)), None);
        assert_eq!(g.tick(air, ms(7300)), None);
        assert_eq!(g.tick(air, ms(7400)), None);
        assert_eq!(g.tick(air, ms(7500)), Some(Decision::Stop));
    }

    #[test]
    fn a_run_ending_mid_count_leaves_the_next_one_a_fresh_grace() {
        let mut g = current_guard();
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let air = Env {
            pump_current_a: Some(0.2),
            ..wet()
        };
        g.request(&on(None, Some(2)), wet(), t0).unwrap();
        assert_eq!(g.tick(air, ms(1800)), None);
        assert_eq!(g.tick(air, ms(1900)), None);
        assert_eq!(g.tick(air, ms(2000)), Some(Decision::Stop));
        assert_eq!(g.fault(), None);
        g.request(&on(None, Some(60)), wet(), ms(2100)).unwrap();
        assert_eq!(g.tick(air, ms(2200)), None);
        assert_eq!(g.tick(air, ms(3000)), None);
        assert_eq!(g.tick(air, ms(3100)), None);
        assert_eq!(g.tick(air, ms(3200)), None);
        assert_eq!(g.tick(air, ms(3300)), None);
        assert_eq!(g.tick(air, ms(3400)), Some(Decision::Stop));
    }

    #[test]
    fn the_current_guard_is_off_unless_a_cutoff_is_set() {
        let mut g = guard();
        assert_eq!(g.limits().dry_current_a, None);
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let air = Env {
            pump_current_a: Some(0.0),
            ..wet()
        };
        for n in 1..600 {
            assert_eq!(g.tick(air, t0 + Duration::from_millis(n * 100)), None);
        }
    }

    #[test]
    fn dry_run_faults_are_told_apart_from_the_others() {
        assert!(is_dry_run("dry-run"));
        assert!(is_dry_run(
            "dry-run: pump drew 0 A, below 1.2 A for 0.3 s: it's pulling air"
        ));
        assert!(!is_dry_run("over-temp"));
        assert!(!is_dry_run("dry-runner"));
        assert_eq!(amps(0.4), "0.4");
        assert_eq!(amps(1.25), "1.25");
        assert_eq!(amps(0.0), "0");
        assert_eq!(amps(2.0), "2");
    }

    // ---- duty and brown-out ---------------------------------------------------

    #[test]
    fn defaults_run_at_30_percent_may_go_to_full_power_and_ramp() {
        let l = PumpLimits::default();
        assert_eq!(l.max_duty, 100.0);
        assert_eq!(l.soft_start_ms, 1500);
        assert_eq!(l.default_duty, 30.0);
        let mut g = PumpGuard::new(l);
        let t0 = Instant::now();
        // A run without a speed (the button, HA) keeps the 30 % default...
        assert!(matches!(
            g.request(&on(None, Some(60)), wet(), t0),
            Ok(Decision::Run { level, .. }) if level == 30.0
        ));
        // ...and one that asks for full power may have it.
        assert!(matches!(
            g.request(&on(Some(100.0), Some(60)), wet(), t0),
            Ok(Decision::Run { level, .. }) if level == 100.0
        ));
        // A request above the cap is clamped.
        assert!(matches!(
            g.request(&on(Some(150.0), Some(60)), wet(), t0),
            Ok(Decision::Run { level, .. }) if level == 100.0
        ));
    }

    #[test]
    fn the_soft_start_lengthens_the_current_grace() {
        let mut g = PumpGuard::new(PumpLimits {
            dry_current_a: Some(1.2),
            dry_grace_ms: 1000,
            dry_after_ms: 300,
            soft_start_ms: 2000,
            dry_guard: DryGuard::Current,
            water_low_cm: None,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        g.request(&on(None, None), wet(), t0).unwrap();
        let air = Env {
            pump_current_a: Some(0.2),
            ..wet()
        };
        // 1 s grace + 2 s ramp: nothing is judged before 3 s.
        assert_eq!(g.tick(air, ms(2_900)), None);
        assert_eq!(g.tick(air, ms(3_000)), None); // first low read, just past grace
        assert_eq!(g.tick(air, ms(3_100)), None);
        assert_eq!(g.tick(air, ms(3_200)), None);
        assert_eq!(g.tick(air, ms(3_300)), Some(Decision::Stop));
        assert!(g.fault().is_some_and(is_dry_run));
    }

    #[test]
    fn a_start_ramps_up_to_its_level_and_never_past_it() {
        let mut g = PumpGuard::new(PumpLimits {
            soft_start_ms: 1000,
            water_low_cm: None,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        assert_eq!(g.output(t0), 0.0, "off is off");
        g.request(&on(Some(80.0), Some(60)), wet(), t0).unwrap();
        assert!(g.ramping(t0));
        let first = g.output(t0);
        assert!((first - 80.0 * RAMP_FROM).abs() < 1e-9, "starts at {first}");
        let mut last = first;
        for n in (50..1000).step_by(50) {
            let o = g.output(ms(n));
            assert!(o > last && o < 80.0, "{o} at {n} ms");
            last = o;
        }
        assert!(!g.ramping(ms(1000)));
        assert_eq!(g.output(ms(1000)), 80.0);
        assert_eq!(g.output(ms(30_000)), 80.0);
        g.request(&on(Some(40.0), Some(60)), wet(), ms(30_000)).unwrap();
        assert_eq!(g.output(ms(30_000)), 40.0);
        assert_eq!(g.request(&off(), wet(), ms(31_000)), Ok(Decision::Stop));
        g.request(&on(Some(80.0), Some(60)), wet(), ms(100_000)).unwrap();
        assert!(g.ramping(ms(100_100)));
        assert!(g.output(ms(100_100)) < 80.0);
        assert_eq!(g.request(&off(), wet(), ms(100_100)), Ok(Decision::Stop));
        assert_eq!(g.output(ms(100_100)), 0.0);
        assert!(!g.ramping(ms(100_100)));
    }

    #[test]
    fn no_soft_start_drives_the_level_at_once() {
        let mut g = PumpGuard::new(PumpLimits {
            soft_start_ms: 0,
            water_low_cm: None,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        assert!(!g.ramping(t0));
        assert_eq!(g.output(t0), 30.0);
    }

    #[test]
    fn a_start_may_choose_its_own_soft_start_or_none() {
        let mut g = PumpGuard::new(PumpLimits {
            soft_start_ms: 1500,
            water_low_cm: None,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let cmd = |soft| ActuatorCommand {
            on: Some(true),
            level: Some(100.0),
            duration_s: Some(60),
            soft_start_ms: soft,
        };
        g.request(&cmd(Some(0)), wet(), t0).unwrap();
        assert!(!g.ramping(t0));
        assert_eq!(g.output(t0), 100.0);
        g.request(&cmd(Some(5000)), wet(), ms(10)).unwrap();
        assert_eq!(g.output(ms(10)), 100.0);
        g.request(&off(), wet(), ms(20)).unwrap();
        g.request(&cmd(Some(60_000)), wet(), ms(1000)).unwrap();
        assert!(g.ramping(ms(1000 + MAX_SOFT_START_MS - 1)));
        assert!(!g.ramping(ms(1000 + MAX_SOFT_START_MS)));
        g.request(&off(), wet(), ms(20_000)).unwrap();
        g.request(&cmd(None), wet(), ms(30_000)).unwrap();
        assert!(g.ramping(ms(31_499)));
        assert!(!g.ramping(ms(31_500)));
    }

    fn supply(v: Option<f64>) -> Env {
        Env { supply_v: v, ..wet() }
    }

    fn pi(flag: Option<bool>) -> Env {
        Env {
            under_voltage: flag,
            ..wet()
        }
    }

    #[test]
    fn a_sagging_supply_stops_the_pump_past_the_grace_and_latches_until_acknowledged() {
        let mut g = PumpGuard::new(PumpLimits {
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        // The inrush in the spin-up grace isn't judged, however deep.
        for n in (100..1000).step_by(100) {
            assert_eq!(g.tick(supply(Some(9.0)), ms(n)), None, "{n} ms");
        }
        assert_eq!(g.tick(supply(Some(10.4)), ms(1000)), None);
        assert_eq!(g.tick(supply(Some(10.2)), ms(1100)), None);
        assert_eq!(g.tick(supply(Some(10.5)), ms(1200)), None);
        assert_eq!(g.tick(supply(Some(10.6)), ms(1300)), Some(Decision::Stop));
        let f = g.fault().unwrap();
        assert_eq!(f, "brown-out: supply fell to 10.2 V for 0.3 s");
        assert!(!is_dry_run(f), "it waits for a person");
        assert!(matches!(
            g.request(&on(None, None), wet(), ms(2000)),
            Err(Refusal::Latched(f)) if f.starts_with(BROWN_OUT)
        ));
        g.acknowledge();
        assert!(g.request(&on(None, None), wet(), ms(3000)).is_ok());
    }

    #[test]
    fn a_good_read_starts_the_sag_count_again_and_a_missing_one_never_trips_it() {
        let mut g = PumpGuard::new(PumpLimits {
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        assert_eq!(g.tick(supply(Some(10.0)), ms(1000)), None);
        assert_eq!(g.tick(supply(Some(10.0)), ms(1100)), None);
        assert_eq!(g.tick(supply(Some(12.1)), ms(1200)), None);
        assert_eq!(g.tick(supply(Some(10.0)), ms(1300)), None);
        assert_eq!(g.tick(supply(Some(10.0)), ms(1400)), None);
        // A lost read neither counts nor clears: the next low one is the third.
        assert_eq!(g.tick(supply(None), ms(1500)), None);
        assert_eq!(g.tick(supply(None), ms(1600)), None);
        assert_eq!(g.tick(supply(Some(10.0)), ms(1700)), Some(Decision::Stop));
        g.acknowledge();
        // A monitor that reads nothing never trips it.
        g.request(&on(None, Some(60)), wet(), ms(5000)).unwrap();
        for n in (5100..30_000).step_by(100) {
            assert_eq!(g.tick(supply(None), ms(n)), None, "{n} ms");
        }
        assert_eq!(g.fault(), None);
    }

    #[test]
    fn it_takes_three_low_supply_reads_however_long_they_take_and_a_new_run_counts_afresh() {
        let mut g = PumpGuard::new(PumpLimits {
            brownout_ms: 100,
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        let s = |n| t0 + Duration::from_secs(n);
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        assert_eq!(g.tick(supply(Some(10.0)), s(2)), None);
        assert_eq!(g.tick(supply(Some(10.0)), s(3)), None);
        // Stopped mid-count: the next run spins up and counts from nothing.
        g.request(&off(), wet(), s(4)).unwrap();
        g.request(&on(None, Some(60)), wet(), s(5)).unwrap();
        assert_eq!(g.tick(supply(Some(10.0)), s(7)), None);
        assert_eq!(g.tick(supply(Some(10.0)), s(8)), None);
        assert_eq!(g.tick(supply(Some(9.96)), s(9)), Some(Decision::Stop));
        assert_eq!(g.fault(), Some("brown-out: supply fell to 10.0 V for 0.1 s"));
    }

    #[test]
    fn without_a_cutoff_the_supply_is_not_judged() {
        let mut g = PumpGuard::new(PumpLimits {
            brownout_v: None,
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        for n in 1..300 {
            assert_eq!(
                g.tick(supply(Some(6.0)), t0 + Duration::from_millis(n * 100)),
                None
            );
        }
    }

    #[test]
    fn a_sag_that_also_starves_the_current_is_named_a_brown_out() {
        let mut g = current_guard();
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        let both = Env {
            supply_v: Some(9.5),
            pump_current_a: Some(0.3),
            ..wet()
        };
        for n in [1000, 1100, 1200] {
            assert_eq!(g.tick(both, ms(n)), None);
        }
        assert_eq!(g.tick(both, ms(1300)), Some(Decision::Stop));
        assert!(g.fault().unwrap().starts_with("brown-out: supply fell to 9.5 V"));
    }

    #[test]
    fn the_pis_under_voltage_flag_trips_on_two_reads_in_a_row() {
        let mut g = PumpGuard::new(PumpLimits {
            soft_start_ms: 0,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        // In the grace it isn't judged.
        assert_eq!(g.tick(pi(Some(true)), ms(500)), None);
        assert_eq!(g.tick(pi(Some(true)), ms(1000)), None);
        // Between reads there's no flag: that neither counts nor clears.
        for n in (1100..2000).step_by(100) {
            assert_eq!(g.tick(pi(None), ms(n)), None, "{n} ms");
        }
        // A clear read starts the count again.
        assert_eq!(g.tick(pi(Some(false)), ms(2000)), None);
        assert_eq!(g.tick(pi(Some(true)), ms(3000)), None);
        assert_eq!(g.tick(pi(Some(true)), ms(4000)), Some(Decision::Stop));
        assert_eq!(
            g.fault(),
            Some("brown-out: the Pi reported under-voltage for 1 s")
        );
        // Two reads closer together than brownout_ms aren't enough.
        g.acknowledge();
        g.request(&on(None, Some(60)), wet(), ms(10_000)).unwrap();
        assert_eq!(g.tick(pi(Some(true)), ms(11_000)), None);
        assert_eq!(g.tick(pi(Some(true)), ms(11_100)), None);
        assert_eq!(g.tick(pi(Some(true)), ms(11_300)), Some(Decision::Stop));
    }

    #[test]
    fn the_brown_out_guard_says_what_it_watches() {
        let d = describe_brownout;
        assert_eq!(
            d(Some(10.8), 300, true, true),
            "supply below 10.8 V for 0.3 s, or the Pi's under-voltage flag"
        );
        assert_eq!(d(Some(10.8), 300, true, false), "supply below 10.8 V for 0.3 s");
        assert_eq!(
            d(Some(10.8), 300, false, true),
            "the Pi's under-voltage flag for 0.3 s only"
        );
        assert_eq!(d(None, 300, true, false), "off: pump_brownout_v = 0");
        assert!(d(Some(10.8), 300, false, false).starts_with("off: no pump monitor"));
    }

    #[test]
    fn median_handles_odd_even_and_empty() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&mut [4.0, 1.0, 3.0, 2.0]), Some(2.0));
        assert_eq!(median(&mut [53.0, 12.7]), Some(12.7));
        assert_eq!(median(&mut []), None);
    }
}
