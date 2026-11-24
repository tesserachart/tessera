use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;
use std::sync::Arc;

pub trait Weigh {
    fn weight(&self) -> usize;
}

impl<T: Weigh + ?Sized> Weigh for Arc<T> {
    fn weight(&self) -> usize {
        (**self).weight()
    }
}

pub struct ByteLru<K, V> {
    budget: usize,
    bytes: usize,
    clock: u64,
    slots: HashMap<K, Slot<V>>,
    order: BTreeMap<u64, K>,
    pinned: Option<fn(&V) -> bool>,
}

struct Slot<V> {
    value: V,
    bytes: usize,
    used: u64,
}

impl<K, V> std::fmt::Debug for ByteLru<K, V> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ByteLru")
            .field("entries", &self.slots.len())
            .field("bytes", &self.bytes)
            .field("budget", &self.budget)
            .finish()
    }
}

impl<K: Eq + Hash + Clone, V: Weigh> ByteLru<K, V> {
    pub fn new(budget: usize) -> Self {
        Self {
            budget,
            bytes: 0,
            clock: 0,
            slots: HashMap::new(),
            order: BTreeMap::new(),
            pinned: None,
        }
    }

    pub fn pinning(budget: usize, pinned: fn(&V) -> bool) -> Self {
        Self {
            pinned: Some(pinned),
            ..Self::new(budget)
        }
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        self.touch(key);
        self.slots.get(key).map(|s| &s.value)
    }

    pub fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.touch(key);
        self.slots.get_mut(key).map(|s| &mut s.value)
    }

    pub fn peek(&self, key: &K) -> Option<&V> {
        self.slots.get(key).map(|s| &s.value)
    }

    pub fn contains(&self, key: &K) -> bool {
        self.slots.contains_key(key)
    }

    pub fn insert(&mut self, key: K, value: V) -> Vec<(K, V)> {
        let mut out: Vec<(K, V)> = self
            .remove(&key)
            .map(|v| (key.clone(), v))
            .into_iter()
            .collect();
        self.clock += 1;
        let bytes = value.weight();
        self.bytes += bytes;
        self.order.insert(self.clock, key.clone());
        self.slots.insert(
            key,
            Slot {
                value,
                bytes,
                used: self.clock,
            },
        );
        out.extend(self.evict());
        out
    }

    pub fn resize(&mut self, key: &K) -> Vec<(K, V)> {
        if let Some(slot) = self.slots.get_mut(key) {
            let bytes = slot.value.weight();
            self.bytes = self.bytes - slot.bytes + bytes;
            slot.bytes = bytes;
        }
        self.evict()
    }

    pub fn remove(&mut self, key: &K) -> Option<V> {
        let slot = self.slots.remove(key)?;
        self.order.remove(&slot.used);
        self.bytes -= slot.bytes;
        Some(slot.value)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.slots.values().map(|s| &s.value)
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    fn touch(&mut self, key: &K) {
        let Some(slot) = self.slots.get_mut(key) else {
            return;
        };
        self.clock += 1;
        if let Some(k) = self.order.remove(&slot.used) {
            self.order.insert(self.clock, k);
        }
        slot.used = self.clock;
    }

    fn idle_bytes(&self) -> usize {
        match self.pinned {
            None => self.bytes,
            Some(pinned) => self
                .slots
                .values()
                .filter(|s| !pinned(&s.value))
                .map(|s| s.bytes)
                .sum(),
        }
    }

    fn evict(&mut self) -> Vec<(K, V)> {
        let mut idle = self.idle_bytes();
        if idle <= self.budget {
            return Vec::new();
        }
        let oldest: Vec<K> = self.order.values().cloned().collect();
        let mut out = Vec::new();
        for key in oldest {
            if idle <= self.budget {
                break;
            }
            let pinned = self
                .pinned
                .is_some_and(|p| self.slots.get(&key).is_some_and(|s| p(&s.value)));
            if pinned {
                continue;
            }
            if let Some(slot) = self.slots.get(&key) {
                idle -= slot.bytes;
            }
            if let Some(v) = self.remove(&key) {
                out.push((key, v));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct Blob(usize);

    impl Weigh for Blob {
        fn weight(&self) -> usize {
            self.0
        }
    }

    struct Held {
        bytes: AtomicUsize,
    }

    impl Weigh for Held {
        fn weight(&self) -> usize {
            self.bytes.load(Ordering::Relaxed)
        }
    }

    fn held(bytes: usize) -> Arc<Held> {
        Arc::new(Held {
            bytes: AtomicUsize::new(bytes),
        })
    }

    fn keys<V>(out: &[(&'static str, V)]) -> Vec<&'static str> {
        out.iter().map(|(k, _)| *k).collect()
    }

    #[test]
    fn the_least_recently_used_go_first_and_come_back_to_the_caller() {
        let mut lru = ByteLru::new(30);
        assert!(lru.insert("a", Blob(10)).is_empty());
        assert!(lru.insert("b", Blob(10)).is_empty());
        assert!(lru.insert("c", Blob(10)).is_empty());
        assert!(lru.get(&"a").is_some());
        let out = lru.insert("d", Blob(10));
        assert_eq!(keys(&out), ["b"], "b was used least recently");
        assert_eq!(out[0].1.0, 10, "the evicted value is handed back");
        assert_eq!((lru.len(), lru.bytes()), (3, 30));
        let out = lru.insert("e", Blob(15));
        assert_eq!(keys(&out), ["c", "a"]);
        assert!(lru.contains(&"d") && lru.contains(&"e"));
        assert_eq!(lru.bytes(), 25);
    }

    #[test]
    fn a_value_that_grows_pushes_others_out() {
        let mut lru = ByteLru::new(100);
        let a = held(10);
        lru.insert("a", Arc::clone(&a));
        lru.insert("b", held(40));
        lru.insert("c", held(40));
        assert!(lru.get(&"a").is_some());
        a.bytes.store(50, Ordering::Relaxed);
        assert_eq!(
            lru.bytes(),
            90,
            "a weighs what it weighed when last measured"
        );
        let out = lru.resize(&"a");
        assert_eq!(keys(&out), ["b"]);
        assert_eq!(lru.bytes(), 90);
    }

    #[test]
    fn pinned_values_stay_and_are_not_counted_against_the_budget() {
        let mut lru = ByteLru::pinning(50, |v: &Arc<Held>| Arc::strong_count(v) > 1);
        let shown = held(40);
        lru.insert("shown", Arc::clone(&shown));
        lru.insert("idle", held(30));
        assert_eq!(
            lru.len(),
            2,
            "a pinned value leaves the whole budget to the rest"
        );
        let out = lru.insert("later", held(30));
        assert_eq!(keys(&out), ["idle"]);
        assert!(lru.contains(&"shown"));
        drop(shown);
        let out = lru.insert("last", held(30));
        assert_eq!(
            keys(&out),
            ["shown", "later"],
            "unpinned, it ages like any other"
        );
    }

    #[test]
    fn a_value_heavier_than_the_budget_comes_straight_back() {
        let mut lru = ByteLru::new(10);
        lru.insert("small", Blob(5));
        let out = lru.insert("huge", Blob(11));
        assert_eq!(keys(&out), ["small", "huge"]);
        assert!(lru.is_empty());
        assert_eq!(lru.bytes(), 0);
    }

    #[test]
    fn inserting_a_key_again_replaces_its_value() {
        let mut lru = ByteLru::new(100);
        lru.insert("a", Blob(10));
        let out = lru.insert("a", Blob(20));
        assert_eq!(keys(&out), ["a"]);
        assert_eq!(out[0].1.0, 10);
        assert_eq!((lru.len(), lru.bytes()), (1, 20));
        assert_eq!(lru.remove(&"a").map(|b| b.0), Some(20));
        assert_eq!(lru.bytes(), 0);
    }
}
