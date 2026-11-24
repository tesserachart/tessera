use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pace {
    pub prints: u64,
    pub busy: Duration,
}

impl Pace {
    pub fn prints_per_second(&self) -> Option<f64> {
        let seconds = self.busy.as_secs_f64();
        (self.prints > 0 && seconds > 0.0).then(|| self.prints as f64 / seconds)
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Meter {
    closed: Pace,
    in_flight: u32,
    busy_since: Option<Instant>,
}

impl Meter {
    fn begin(&mut self, at: Instant) {
        if self.in_flight == 0 {
            self.busy_since = Some(at);
        }
        self.in_flight += 1;
    }

    fn end(&mut self, at: Instant, prints: u64) {
        self.closed.prints += prints;
        self.in_flight = self.in_flight.saturating_sub(1);
        if self.in_flight == 0
            && let Some(since) = self.busy_since.take()
        {
            self.closed.busy += at.saturating_duration_since(since);
        }
    }

    fn pace(&self, at: Instant) -> Pace {
        let open = self
            .busy_since
            .map_or(Duration::ZERO, |since| at.saturating_duration_since(since));
        Pace {
            prints: self.closed.prints,
            busy: self.closed.busy + open,
        }
    }
}

#[derive(Debug, Default)]
pub struct Paces {
    meters: Mutex<HashMap<String, Meter>>,
}

impl Paces {
    pub fn begin(&self, connection: &str) -> Flight<'_> {
        self.meters
            .lock()
            .entry(connection.to_owned())
            .or_default()
            .begin(Instant::now());
        Flight {
            paces: self,
            connection: connection.to_owned(),
            prints: 0,
        }
    }

    pub fn pace(&self, connection: &str) -> Pace {
        self.meters
            .lock()
            .get(connection)
            .map(|m| m.pace(Instant::now()))
            .unwrap_or_default()
    }
}

#[derive(Debug)]
pub struct Flight<'a> {
    paces: &'a Paces,
    connection: String,
    prints: u64,
}

impl Flight<'_> {
    pub fn answered(mut self, prints: usize) {
        self.prints = prints as u64;
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        if let Some(meter) = self.paces.meters.lock().get_mut(&self.connection) {
            meter.end(Instant::now(), self.prints);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    fn started() -> Instant {
        Instant::now()
    }

    #[test]
    fn nothing_asked_has_no_pace() {
        assert_eq!(Meter::default().pace(started()).prints_per_second(), None);
    }

    #[test]
    fn one_request_is_its_prints_over_its_time() {
        let t0 = started();
        let mut m = Meter::default();
        m.begin(t0);
        m.end(t0 + secs(4), 2_000);
        assert_eq!(m.pace(t0 + secs(100)).prints_per_second(), Some(500.0));
    }

    #[test]
    fn two_overlapping_requests_count_the_time_once() {
        let t0 = started();
        let mut m = Meter::default();
        m.begin(t0);
        m.begin(t0 + secs(1));
        m.end(t0 + secs(3), 1_000);
        m.end(t0 + secs(5), 1_000);
        assert_eq!(
            m.pace(t0 + secs(9)),
            Pace {
                prints: 2_000,
                busy: secs(5)
            }
        );
    }

    #[test]
    fn two_requests_back_to_back_count_both_times() {
        let t0 = started();
        let mut m = Meter::default();
        m.begin(t0);
        m.end(t0 + secs(2), 1_000);
        m.begin(t0 + secs(2));
        m.end(t0 + secs(6), 1_000);
        assert_eq!(
            m.pace(t0 + secs(9)),
            Pace {
                prints: 2_000,
                busy: secs(6)
            }
        );
    }

    #[test]
    fn idle_time_between_requests_is_not_busy_time() {
        let t0 = started();
        let mut m = Meter::default();
        m.begin(t0);
        m.end(t0 + secs(1), 100);
        m.begin(t0 + secs(50));
        m.end(t0 + secs(51), 100);
        assert_eq!(m.pace(t0 + secs(99)).busy, secs(2));
    }

    #[test]
    fn a_request_with_no_prints_still_counts_its_time() {
        let t0 = started();
        let mut m = Meter::default();
        m.begin(t0);
        m.end(t0 + secs(3), 0);
        m.begin(t0 + secs(3));
        m.end(t0 + secs(4), 900);
        assert_eq!(m.pace(t0 + secs(4)).prints_per_second(), Some(225.0));
    }

    #[test]
    fn a_request_in_flight_counts_the_time_so_far() {
        let t0 = started();
        let mut m = Meter::default();
        m.begin(t0);
        m.begin(t0 + secs(1));
        m.end(t0 + secs(2), 800);
        assert_eq!(m.pace(t0 + secs(4)).prints_per_second(), Some(200.0));
    }

    #[test]
    fn connections_are_measured_apart() {
        let paces = Paces::default();
        paces.begin("a").answered(10);
        assert!(paces.pace("a").prints > 0);
        assert_eq!(paces.pace("b"), Pace::default());
    }

    #[test]
    fn a_dropped_request_ends_its_flight() {
        let paces = Paces::default();
        drop(paces.begin("a"));
        let meters = paces.meters.lock();
        assert_eq!(meters["a"].in_flight, 0);
        assert!(meters["a"].busy_since.is_none());
    }
}
