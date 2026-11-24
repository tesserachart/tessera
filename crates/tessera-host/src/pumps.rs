use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use tokio::task::JoinHandle;

type Table<K> = Mutex<HashMap<K, (usize, JoinHandle<()>)>>;

pub struct Pumps<K> {
    table: Arc<Table<K>>,
}

impl<K> Default for Pumps<K> {
    fn default() -> Self {
        Self {
            table: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl<K: std::fmt::Debug> std::fmt::Debug for Pumps<K> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pumps")
            .field("running", &self.table.lock().len())
            .finish()
    }
}

pub struct PumpGuard<K: Eq + Hash> {
    table: Weak<Table<K>>,
    key: Option<K>,
}

impl<K: Eq + Hash + std::fmt::Debug> std::fmt::Debug for PumpGuard<K> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("PumpGuard").field(&self.key).finish()
    }
}

impl<K: Eq + Hash> Drop for PumpGuard<K> {
    fn drop(&mut self) {
        let (Some(table), Some(key)) = (self.table.upgrade(), self.key.take()) else {
            return;
        };
        let mut t = table.lock();
        if let Some((refs, _)) = t.get_mut(&key) {
            *refs -= 1;
            if *refs == 0
                && let Some((_, task)) = t.remove(&key)
            {
                task.abort();
            }
        }
    }
}

impl<K: Eq + Hash + Clone> Pumps<K> {
    pub fn new() -> Self {
        Self {
            table: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn acquire<E>(
        &self,
        key: K,
        start: impl FnOnce() -> Result<JoinHandle<()>, E>,
    ) -> Result<PumpGuard<K>, E> {
        let mut t = self.table.lock();
        match t.get_mut(&key) {
            Some((refs, task)) if task.is_finished() => {
                *task = start()?;
                *refs += 1;
            }
            Some((refs, _)) => *refs += 1,
            None => {
                let task = start()?;
                t.insert(key.clone(), (1, task));
            }
        }
        Ok(PumpGuard {
            table: Arc::downgrade(&self.table),
            key: Some(key),
        })
    }

    pub fn len(&self) -> usize {
        self.table.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pumps_are_shared_and_stop_with_the_last_guard() {
        let pumps: Pumps<&str> = Pumps::new();
        let mut starts = 0;
        let mut start = || {
            starts += 1;
            Ok::<_, ()>(tokio::spawn(std::future::pending::<()>()))
        };
        let a = pumps.acquire("QQQ", &mut start).unwrap();
        let b = pumps.acquire("QQQ", &mut start).unwrap();
        let c = pumps.acquire("SPY", &mut start).unwrap();
        assert_eq!((pumps.len(), starts), (2, 2));
        drop(a);
        assert_eq!(pumps.len(), 2);
        drop(b);
        assert_eq!(pumps.len(), 1);
        drop(c);
        assert!(pumps.is_empty());
        assert!(
            pumps
                .acquire("ES", || Err::<JoinHandle<()>, _>("refused"))
                .is_err()
        );
        assert!(pumps.is_empty());
    }

    #[tokio::test]
    async fn a_pump_that_ended_on_its_own_starts_again_for_the_next_subscriber() {
        let pumps: Pumps<&str> = Pumps::new();
        let mut starts = 0;
        let mut start = || {
            starts += 1;
            Ok::<_, ()>(tokio::spawn(async {}))
        };
        let first = pumps.acquire("QQQ", &mut start).unwrap();
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let _second = pumps.acquire("QQQ", &mut start).unwrap();
        assert_eq!(starts, 2, "the dead pump is not shared");
        drop(first);
        assert_eq!(pumps.len(), 1, "the second subscriber keeps its pump");
    }
}
