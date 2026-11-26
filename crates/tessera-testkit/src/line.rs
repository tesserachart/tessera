use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

const CHUNK: u32 = 1_000;

#[derive(Clone, Debug)]
pub struct Line {
    prints_per_second: NonZeroU32,
    turn: Arc<Mutex<()>>,
}

impl Line {
    pub fn new(prints_per_second: NonZeroU32) -> Self {
        Self {
            prints_per_second,
            turn: Arc::default(),
        }
    }

    pub async fn send(&self, prints: usize) {
        let mut left = u32::try_from(prints).unwrap_or(u32::MAX);
        while left > 0 {
            let chunk = left.min(CHUNK);
            let _turn = self.turn.lock().await;
            tokio::time::sleep(Duration::from_secs_f64(
                f64::from(chunk) / f64::from(self.prints_per_second.get()),
            ))
            .await;
            left -= chunk;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    fn line() -> Line {
        Line::new(NonZeroU32::new(10_000).expect("10,000 is not zero"))
    }

    #[tokio::test(start_paused = true)]
    async fn a_send_takes_its_prints_at_the_line_rate() {
        let began = Instant::now();
        line().send(100_000).await;
        assert_eq!(began.elapsed(), Duration::from_secs(10));
    }

    #[tokio::test(start_paused = true)]
    async fn sends_at_once_share_the_line() {
        let line = line();
        let began = Instant::now();
        let big = line.send(100_000);
        let small = async {
            line.send(10_000).await;
            began.elapsed()
        };
        let ((), small_done) = tokio::join!(big, small);
        assert_eq!(began.elapsed(), Duration::from_secs(11));
        assert!(
            small_done > Duration::from_secs(1) && small_done < Duration::from_secs(3),
            "the small send waited its turns beside the big one: {small_done:?}"
        );
    }
}
