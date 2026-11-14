//! systemd's notify protocol (`sd_notify(3)`) without libsystemd: `READY=1` once
//! the engine runs, `WATCHDOG=1` from the engine's own tick. A pinger on a side
//! thread would keep pinging through a hung loop, so there is none: when the loop
//! stops ticking the pings stop, and `WatchdogSec=` in hald.service has systemd
//! kill and restart hald. Without `NOTIFY_SOCKET` (`--sim`, tests, macOS) it does
//! nothing.

use std::ffi::OsStr;
use std::os::unix::net::{SocketAddr, UnixDatagram};

pub struct Notifier {
    socket: Option<(UnixDatagram, SocketAddr)>,
    /// `WATCHDOG_USEC` is set: systemd expects pings.
    watchdog: bool,
}

impl Notifier {
    pub fn from_env() -> Self {
        Self::new(
            std::env::var_os("NOTIFY_SOCKET").as_deref(),
            std::env::var_os("WATCHDOG_USEC").is_some(),
        )
    }

    pub fn new(path: Option<&OsStr>, watchdog: bool) -> Self {
        let socket = path.and_then(|p| Some((UnixDatagram::unbound().ok()?, address(p)?)));
        Self { socket, watchdog }
    }

    /// The engine has booted; systemd now counts hald as started and arms the watchdog.
    pub fn ready(&self) {
        self.send("READY=1");
    }

    /// Called once per engine tick. Each tick pings: a datagram a second costs nothing.
    pub fn watchdog(&self) {
        if self.watchdog {
            self.send("WATCHDOG=1");
        }
    }

    fn send(&self, msg: &str) {
        if let Some((sock, addr)) = &self.socket {
            if let Err(e) = sock.send_to_addr(msg.as_bytes(), addr) {
                tracing::debug!(%e, msg, "sd_notify failed");
            }
        }
    }
}

/// A path, or on Linux `@name` for an abstract socket.
fn address(path: &OsStr) -> Option<SocketAddr> {
    use std::os::unix::ffi::OsStrExt;
    match path.as_bytes() {
        [] => None,
        [b'@', name @ ..] => abstract_address(name),
        _ => SocketAddr::from_pathname(path).ok(),
    }
}

#[cfg(target_os = "linux")]
fn abstract_address(name: &[u8]) -> Option<SocketAddr> {
    use std::os::linux::net::SocketAddrExt;
    SocketAddr::from_abstract_name(name).ok()
}

#[cfg(not(target_os = "linux"))]
fn abstract_address(_name: &[u8]) -> Option<SocketAddr> {
    None
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// A stand-in for systemd's notify socket, in a short path (sun_path is ~104 bytes on macOS).
    pub struct FakeSystemd {
        pub path: PathBuf,
        sock: UnixDatagram,
    }

    impl FakeSystemd {
        pub fn new() -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "hald-notify-{}-{}.sock",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_file(&path);
            let sock = UnixDatagram::bind(&path).unwrap();
            sock.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
            Self { path, sock }
        }

        pub fn notifier(&self) -> Notifier {
            Notifier::new(Some(self.path.as_os_str()), true)
        }

        /// Every message sent so far.
        pub fn received(&self) -> Vec<String> {
            let mut out = Vec::new();
            let mut buf = [0u8; 256];
            while let Ok(n) = self.sock.recv(&mut buf) {
                out.push(String::from_utf8_lossy(&buf[..n]).into_owned());
            }
            out
        }
    }

    impl Drop for FakeSystemd {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    #[test]
    fn ready_then_a_ping_per_call() {
        let systemd = FakeSystemd::new();
        let n = systemd.notifier();
        n.ready();
        n.watchdog();
        n.watchdog();
        assert_eq!(systemd.received(), ["READY=1", "WATCHDOG=1", "WATCHDOG=1"]);
    }

    #[test]
    fn no_pings_when_systemd_has_no_watchdog() {
        let systemd = FakeSystemd::new();
        let n = Notifier::new(Some(systemd.path.as_os_str()), false);
        n.ready();
        n.watchdog();
        assert_eq!(systemd.received(), ["READY=1"]);
    }

    #[test]
    fn nothing_at_all_without_a_socket() {
        let n = Notifier::new(None, true);
        assert!(n.socket.is_none());
        n.ready();
        n.watchdog();
        assert!(Notifier::new(Some(OsStr::new("")), true).socket.is_none());
    }

    #[test]
    fn a_socket_that_went_away_is_not_an_error() {
        let path = {
            let systemd = FakeSystemd::new();
            systemd.path.clone()
        };
        let n = Notifier::new(Some(path.as_os_str()), true);
        n.ready();
        n.watchdog();
    }

    #[test]
    fn from_env_reads_the_unit_environment() {
        // The test runner has no NOTIFY_SOCKET unless it runs under systemd itself.
        let n = Notifier::from_env();
        assert_eq!(n.socket.is_some(), std::env::var_os("NOTIFY_SOCKET").is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn abstract_sockets_on_linux() {
        use std::os::linux::net::SocketAddrExt;
        let name = format!("hald-notify-test-{}", std::process::id());
        let addr = SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
        let sock = UnixDatagram::bind_addr(&addr).unwrap();
        sock.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
        let n = Notifier::new(Some(OsStr::new(&format!("@{name}"))), true);
        n.watchdog();
        let mut buf = [0u8; 64];
        let len = sock.recv(&mut buf).unwrap();
        assert_eq!(&buf[..len], b"WATCHDOG=1");
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn abstract_sockets_are_linux_only() {
        assert!(Notifier::new(Some(OsStr::new("@hald")), true).socket.is_none());
    }
}
