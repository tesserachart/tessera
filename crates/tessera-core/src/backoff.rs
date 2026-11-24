use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Backoff {
    first: Duration,
    longest: Duration,
    jitter: f64,
}

impl Backoff {
    pub const fn new(first: Duration, longest: Duration) -> Self {
        Self {
            first,
            longest,
            jitter: 0.0,
        }
    }

    pub const fn with_jitter(self, spread: f64) -> Self {
        Self {
            jitter: spread,
            ..self
        }
    }

    pub fn delay(&self, attempt: u32) -> Duration {
        let doubling = 2u32.saturating_pow(attempt.saturating_sub(1));
        let wait = self.first.saturating_mul(doubling).min(self.longest);
        if self.jitter == 0.0 {
            return wait;
        }
        wait.mul_f64(1.0 - self.jitter + 2.0 * self.jitter * unit_noise())
    }
}

fn unit_noise() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    f64::from(nanos % 10_000) / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEC: Duration = Duration::from_secs(1);

    #[test]
    fn each_attempt_doubles_the_wait_up_to_the_longest() {
        let b = Backoff::new(30 * SEC, 15 * 60 * SEC);
        let waits: Vec<u64> = [0, 1, 2, 5, 6, 40, u32::MAX]
            .map(|n| b.delay(n).as_secs())
            .to_vec();
        assert_eq!(waits, [30, 30, 60, 480, 900, 900, 900]);
    }

    #[test]
    fn jitter_spreads_the_wait_both_ways() {
        let b = Backoff::new(SEC, 60 * SEC).with_jitter(0.2);
        for (attempt, base) in [
            (1u32, 1_000u128),
            (2, 2_000),
            (4, 8_000),
            (7, 60_000),
            (30, 60_000),
        ] {
            let ms = b.delay(attempt).as_millis();
            assert!(
                ms >= base * 8 / 10 && ms <= base * 12 / 10,
                "attempt {attempt}: {ms} ms"
            );
        }
    }
}
