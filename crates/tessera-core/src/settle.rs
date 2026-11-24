use std::fmt::Debug;
use std::future::Future;
use std::time::Duration;

use tokio::time::Instant;

pub const STALL: Duration = Duration::from_secs(15);
pub const CEILING: Duration = Duration::from_secs(45);
const POLL: Duration = Duration::from_millis(10);

pub async fn settle<T>(what: &str, mut look: impl FnMut() -> T, done: impl Fn(&T) -> bool) -> T
where
    T: Debug + PartialEq,
{
    settle_async(what, || std::future::ready(look()), done).await
}

pub async fn settle_async<T, F, Fut>(what: &str, mut look: F, done: impl Fn(&T) -> bool) -> T
where
    T: Debug + PartialEq,
    F: FnMut() -> Fut,
    Fut: Future<Output = T>,
{
    let began = Instant::now();
    let mut seen = look().await;
    let mut changed = began;
    loop {
        if done(&seen) {
            return seen;
        }
        assert!(
            changed.elapsed() < STALL,
            "{what}: stalled for {STALL:?} at {seen:?}"
        );
        assert!(
            began.elapsed() < CEILING,
            "{what}: still moving after {CEILING:?}, now at {seen:?}"
        );
        tokio::time::sleep(POLL).await;
        let now = look().await;
        if now != seen {
            seen = now;
            changed = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn it_returns_what_it_saw_once_the_condition_holds() {
        let n = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&n);
        tokio::spawn(async move {
            for _ in 0..3 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        let seen = settle("three ticks", || n.load(Ordering::SeqCst), |n| *n == 3).await;
        assert_eq!(seen, 3);
    }

    #[tokio::test(start_paused = true)]
    #[should_panic(expected = "a stuck count: stalled for 15s at 1")]
    async fn a_stalled_look_fails_with_the_state_it_last_saw() {
        settle("a stuck count", || 1, |n| *n == 2).await;
    }

    #[tokio::test(start_paused = true)]
    async fn progress_resets_the_stall_but_not_the_ceiling() {
        let started = Instant::now();
        let outcome = tokio::spawn(async move {
            settle(
                "a count that never arrives",
                || started.elapsed().as_secs() / 10,
                |n| *n == u64::MAX,
            )
            .await
        })
        .await;
        assert!(outcome.is_err());
        assert!(started.elapsed() >= CEILING);
        assert!(started.elapsed() < CEILING + STALL);
    }
}
