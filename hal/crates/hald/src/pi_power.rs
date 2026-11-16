//! The Pi's own under-voltage flag, for the pump's brown-out guard. The
//! firmware driver exposes `get_throttled` in sysfs, readable without root, so
//! hald reads it there rather than running `vcgencmd get_throttled`.

use std::path::Path;

/// Bit 0 of `get_throttled`: the supply is under-voltage now.
const UNDER_VOLTAGE_NOW: u32 = 0x1;

/// The flags as sysfs (`50005`) or `vcgencmd` (`throttled=0x50005`) print them.
pub fn parse(text: &str) -> Option<u32> {
    let t = text.trim();
    let t = t.strip_prefix("throttled=").unwrap_or(t);
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    u32::from_str_radix(t, 16).ok()
}

/// Whether the Pi reports under-voltage now; `None` if the flag can't be read.
pub fn under_voltage(path: &Path) -> Option<bool> {
    let flags = parse(&std::fs::read_to_string(path).ok()?)?;
    Some(flags & UNDER_VOLTAGE_NOW != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_spellings_and_reads_bit_zero() {
        assert_eq!(parse("50005\n"), Some(0x50005));
        assert_eq!(parse("throttled=0x50000"), Some(0x50000));
        assert_eq!(parse("0X1"), Some(1));
        assert_eq!(parse("0"), Some(0));
        assert_eq!(parse("nope"), None);
        let dir = std::env::temp_dir().join(format!("hald-throttled-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("get_throttled");
        std::fs::write(&p, "50005\n").unwrap();
        assert_eq!(under_voltage(&p), Some(true));
        // Under-voltage since boot only (bit 16) isn't under-voltage now.
        std::fs::write(&p, "50000\n").unwrap();
        assert_eq!(under_voltage(&p), Some(false));
        std::fs::write(&p, "garbage").unwrap();
        assert_eq!(under_voltage(&p), None);
        assert_eq!(under_voltage(&dir.join("missing")), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
