use std::sync::Arc;
#[cfg(any(test, feature = "test-support"))]
use std::sync::atomic::{AtomicI64, Ordering};

use crate::time::Timestamp;

pub trait Clock: Send + Sync + std::fmt::Debug {
    fn now(&self) -> Timestamp;
}

pub type SharedClock = Arc<dyn Clock>;

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Default)]
pub struct ManualClock {
    now: AtomicI64,
}

#[cfg(any(test, feature = "test-support"))]
impl ManualClock {
    pub fn new(start: Timestamp) -> Self {
        Self {
            now: AtomicI64::new(start.0),
        }
    }

    pub fn set(&self, t: Timestamp) {
        self.now.store(t.0, Ordering::SeqCst);
    }

    pub fn advance(&self, nanos: i64) {
        self.now.fetch_add(nanos, Ordering::SeqCst);
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Clock for ManualClock {
    fn now(&self) -> Timestamp {
        Timestamp(self.now.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::NANOS_PER_SEC;

    #[test]
    fn a_manual_clock_moves_when_told() {
        let c = ManualClock::new(Timestamp::from_secs(10));
        c.advance(5 * NANOS_PER_SEC);
        assert_eq!(c.now(), Timestamp::from_secs(15));
        c.set(Timestamp::from_secs(3));
        assert_eq!(c.now(), Timestamp::from_secs(3));
    }
}
