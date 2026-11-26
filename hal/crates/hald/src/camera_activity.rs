//! Capture overlap for tank alert classification only. Never used by PumpGuard.
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Default)]
pub(crate) struct Mark {
    active: usize,
    started: u64,
}

#[derive(Clone, Default)]
pub(crate) struct CameraActivity(Arc<Mutex<Mark>>);

pub(crate) struct Capturing {
    activity: CameraActivity,
}

impl CameraActivity {
    pub(crate) fn begin(&self) -> Capturing {
        let mut mark = self.0.lock().unwrap_or_else(|e| e.into_inner());
        mark.active += 1;
        mark.started = mark.started.wrapping_add(1);
        Capturing {
            activity: self.clone(),
        }
    }

    pub(crate) fn mark(&self) -> Mark {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn overlapped(&self, before: Mark) -> bool {
        let after = self.mark();
        before.active > 0 || after.active > 0 || before.started != after.started
    }
}

impl Drop for Capturing {
    fn drop(&mut self) {
        self.activity.0.lock().unwrap_or_else(|e| e.into_inner()).active -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_a_capture_that_started_and_finished_during_the_read() {
        let activity = CameraActivity::default();
        let start = activity.mark();
        assert!(!activity.overlapped(start));
        drop(activity.clone().begin());
        assert!(activity.overlapped(start));
        assert!(!activity.overlapped(activity.mark()));
        let first = activity.begin();
        let second = activity.begin();
        drop(first);
        assert!(activity.overlapped(activity.mark()));
        let mark = activity.mark();
        drop(second);
        assert!(activity.overlapped(mark));
        assert!(!activity.overlapped(activity.mark()));
    }
}
