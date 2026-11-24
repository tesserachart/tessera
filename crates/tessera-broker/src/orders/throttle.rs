use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use parking_lot::Mutex;
use tessera_core::Timestamp;
use tessera_core::ids::AccountId;

pub const ORDERS_PER_SECOND: usize = 6;
pub const PAUSE: Duration = Duration::from_secs(10);
const SECOND: i64 = 1_000_000_000;

#[derive(Debug, Default)]
struct Window {
    sent: VecDeque<Timestamp>,
    paused_until: Option<Timestamp>,
}

#[derive(Debug, Default)]
pub struct Throttle {
    accounts: Mutex<HashMap<AccountId, Window>>,
}

impl Throttle {
    pub fn paused(&self, account: &AccountId, now: Timestamp) -> Option<Timestamp> {
        self.accounts
            .lock()
            .get(account)
            .and_then(|w| w.paused_until)
            .filter(|until| now < *until)
    }

    pub fn admit(&self, account: &AccountId, now: Timestamp) -> Result<(), Timestamp> {
        let mut accounts = self.accounts.lock();
        let w = accounts.entry(account.clone()).or_default();
        if let Some(until) = w.paused_until.filter(|until| now < *until) {
            return Err(until);
        }
        while w.sent.front().is_some_and(|t| now.0 - t.0 >= SECOND) {
            w.sent.pop_front();
        }
        if w.sent.len() >= ORDERS_PER_SECOND {
            let pause = i64::try_from(PAUSE.as_nanos()).unwrap_or(i64::MAX);
            let until = now.add_nanos(pause);
            w.paused_until = Some(until);
            w.sent.clear();
            return Err(until);
        }
        w.sent.push_back(now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: i64) -> Timestamp {
        Timestamp(1_791_000_000 * SECOND + ms * 1_000_000)
    }

    #[test]
    fn six_a_second_go_and_the_seventh_pauses_the_account_for_ten_seconds() {
        let t = Throttle::default();
        let a = AccountId::new("paper-main");
        let b = AccountId::new("paper-2");
        for i in 0..6 {
            assert_eq!(t.admit(&a, at(i * 100)), Ok(()), "order {}", i + 1);
        }
        assert_eq!(t.admit(&a, at(650)), Err(at(10_650)));
        assert_eq!(t.paused(&a, at(5_000)), Some(at(10_650)));
        assert_eq!(t.admit(&a, at(10_649)), Err(at(10_650)));
        assert_eq!(t.admit(&b, at(700)), Ok(()), "each account counts its own");
        assert_eq!(t.paused(&a, at(10_650)), None);
        assert_eq!(t.admit(&a, at(10_650)), Ok(()));
    }

    #[test]
    fn a_steady_six_a_second_never_pauses() {
        let t = Throttle::default();
        let a = AccountId::new("paper-main");
        for i in 0..60 {
            assert_eq!(t.admit(&a, at(i * 170)), Ok(()), "order {}", i + 1);
        }
    }
}
