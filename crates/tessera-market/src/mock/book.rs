use std::collections::BTreeMap;
use std::num::NonZeroU32;

use tessera_core::market::Aggressor;

use crate::rng::SplitMix;

const WALL_MIN_DISTANCE: usize = 3;
const WALLS_PER_SIDE: usize = 3;
const HOLD_LEVELS: i64 = 3;
const SWEEP_DECAY_SECS: f64 = 20.0;
const MAX_PRINTS_PER_TICK: u32 = 12;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BookParams {
    pub step: i64,
    pub spread: i64,
    pub depth: usize,
    pub size: f64,
    pub print_size: f64,
    pub rounds: [i64; 3],
    pub qty_decimals: u32,
}

impl BookParams {
    pub fn lot(&self) -> f64 {
        10f64.powi(-(self.qty_decimals as i32))
    }

    fn round(&self, v: f64) -> f64 {
        let p = 10f64.powi(self.qty_decimals as i32);
        (v * p).round() / p
    }

    fn roundness(&self, level: i64) -> usize {
        self.rounds
            .iter()
            .filter(|&&r| r > 0 && level % r == 0)
            .count()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Level {
    pub size: f64,
    target: f64,
    unit: f64,
    pub wall: f64,
    wall_until: i64,
    pub clip: f64,
    peak: f64,
    pub reserve: f64,
}

impl Level {
    pub fn displayed(&self) -> f64 {
        self.size + self.wall + self.clip
    }

    pub fn orders(&self) -> u32 {
        let ordinary = if self.size > 0.0 {
            ((self.size / self.unit.max(1e-12)).ceil() as u32).max(1)
        } else {
            0
        };
        ordinary + u32::from(self.wall > 0.0) + u32::from(self.clip > 0.0)
    }

    fn is_strong(&self) -> bool {
        self.wall > 0.0 || self.clip > 0.0 || self.reserve > 0.0
    }

    fn total(&self) -> f64 {
        self.displayed() + self.reserve
    }

    fn broken_volume(&self, coin: f64, u: f64) -> f64 {
        let wall = if coin < 0.5 { self.wall } else { 0.0 };
        self.size + self.clip + wall + self.reserve * 0.3 * u
    }

    fn ordinary_volume(&self, u: f64, coin: f64, allowance: f64, lot: f64) -> f64 {
        let share = (self.displayed() * u).min(allowance);
        if share >= lot {
            share
        } else if coin < share / lot {
            lot
        } else {
            0.0
        }
    }

    fn fill(&mut self, want: f64, p: &BookParams) -> f64 {
        let mut left = want;
        let take = |avail: &mut f64, left: &mut f64| {
            let t = avail.min(*left);
            *avail = p.round(*avail - t);
            *left = p.round(*left - t);
        };
        take(&mut self.size, &mut left);
        while left > 0.0 && (self.clip > 0.0 || self.reserve > 0.0) {
            if self.clip <= 0.0 {
                let refill = self.peak.min(self.reserve);
                if refill <= 0.0 {
                    break;
                }
                self.clip = refill;
                self.reserve = p.round(self.reserve - refill);
            }
            take(&mut self.clip, &mut left);
        }
        if self.clip <= 0.0 && self.reserve > 0.0 {
            self.clip = self.peak.min(self.reserve);
            self.reserve = p.round(self.reserve - self.clip);
        }
        if self.clip <= 0.0 && self.reserve <= 0.0 {
            self.peak = 0.0;
        }
        take(&mut self.wall, &mut left);
        p.round(want - left)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fill {
    pub ticks: i64,
    pub size: f64,
    pub aggressor: Aggressor,
    pub order: u32,
    pub burst_child: Option<NonZeroU32>,
}

fn taker(buy: bool) -> Aggressor {
    if buy { Aggressor::Buy } else { Aggressor::Sell }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TickInput {
    pub now: i64,
    pub dt: f64,
    pub target_ticks: i64,
    pub budget: f64,
    pub p_buy: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RestingLevel {
    pub ticks: i64,
    pub size: f64,
    pub orders: u32,
}

#[derive(Clone, Debug)]
pub struct Book {
    params: BookParams,
    bids: BTreeMap<i64, Level>,
    asks: BTreeMap<i64, Level>,
    rng: SplitMix,
    bias: f64,
}

impl Book {
    pub fn new(params: BookParams, rng_seed: u64) -> Self {
        Self {
            params,
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            rng: SplitMix::new(rng_seed),
            bias: 0.0,
        }
    }

    pub fn params(&self) -> &BookParams {
        &self.params
    }

    fn bid_level(&self) -> Option<i64> {
        self.bids.keys().next_back().copied()
    }

    fn ask_level(&self) -> Option<i64> {
        self.asks.keys().next().copied()
    }

    fn resting(&self, level: i64, l: &Level) -> RestingLevel {
        RestingLevel {
            ticks: level * self.params.step,
            size: l.displayed(),
            orders: l.orders(),
        }
    }

    pub fn best_bid(&self) -> Option<RestingLevel> {
        self.bids
            .iter()
            .next_back()
            .map(|(&k, l)| self.resting(k, l))
    }

    pub fn best_ask(&self) -> Option<RestingLevel> {
        self.asks.iter().next().map(|(&k, l)| self.resting(k, l))
    }

    pub fn bids(&self, n: usize) -> Vec<RestingLevel> {
        self.bids
            .iter()
            .rev()
            .take(n)
            .map(|(&k, l)| self.resting(k, l))
            .collect()
    }

    pub fn asks(&self, n: usize) -> Vec<RestingLevel> {
        self.asks
            .iter()
            .take(n)
            .map(|(&k, l)| self.resting(k, l))
            .collect()
    }

    fn mid(&self) -> Option<f64> {
        Some((self.bid_level()? + self.ask_level()?) as f64 / 2.0)
    }

    fn bid_for(&self, target: i64) -> i64 {
        target - self.params.spread / 2
    }

    fn level_of(&self, ticks: i64) -> i64 {
        let s = self.params.step;
        (ticks + s.div_euclid(2)).div_euclid(s)
    }

    fn draw_target(&mut self, d: usize, level: i64) -> f64 {
        let p = self.params;
        let d = d as f64;
        let shape = 1.0 + 1.4 * (1.0 - (-d / 3.0).exp()) + 0.5 * (d / 10.0).min(1.6);
        let round = [1.0, 1.3, 1.9, 2.6][p.roundness(level)];
        let noise = (0.45 * self.rng.normal() - 0.1).exp();
        p.round(p.size * shape * round * noise).max(p.lot())
    }

    fn new_level(&mut self, d: usize, level: i64, fill: f64) -> Level {
        let p = self.params;
        let target = self.draw_target(d, level);
        let unit = (p.size / 4.0).max(p.lot()) * (0.4 * self.rng.normal()).exp();
        Level {
            size: p.round(target * fill).max(p.lot()),
            target,
            unit,
            ..Level::default()
        }
    }

    pub fn reset(&mut self, target_ticks: i64, now: i64) {
        let target = self.level_of(target_ticks);
        self.bids.clear();
        self.asks.clear();
        self.bias = 0.0;
        let b = self.bid_for(target);
        let a = b + self.params.spread;
        for d in 0..self.params.depth {
            let lb = b - d as i64;
            let bid = self.new_level(d, lb, 1.0);
            self.bids.insert(lb, bid);
            let la = a + d as i64;
            let ask = self.new_level(d, la, 1.0);
            self.asks.insert(la, ask);
        }
        for buy in [true, false] {
            let n = self.rng.poisson(1.2);
            for _ in 0..n {
                let left = 10.0 + 190.0 * self.rng.uniform();
                self.spawn_wall(buy, now, left);
            }
        }
    }

    pub fn tick(&mut self, input: TickInput) -> Vec<Fill> {
        let p = self.params;
        let driver = self.level_of(input.target_ticks);
        let far = self
            .mid()
            .is_none_or(|m| (m - driver as f64).abs() > p.depth as f64 / 2.0);
        if far {
            self.reset(input.target_ticks, input.now);
            return Vec::new();
        }
        self.bias *= (-input.dt / SWEEP_DECAY_SECS).exp();
        let target = driver + self.bias.round() as i64;
        self.refresh(input.dt, input.now);

        let mut fills = Vec::new();
        let drift_volume = self.drift(target, 0.6 * input.budget, &mut fills);

        let rest = (input.budget - drift_volume).max(0.0);
        let n = self
            .rng
            .poisson(rest / p.print_size.max(1e-12))
            .min(MAX_PRINTS_PER_TICK);
        let mut swept = false;
        for _ in 0..n {
            let buy = self.rng.uniform() < input.p_buy;
            let mut size = p.print_size * (0.8 * self.rng.normal() - 0.32).exp();
            let mut children = 1;
            if self.rng.uniform() < 0.004 {
                size *= 10.0 + 30.0 * self.rng.uniform();
                swept = true;
                if self.rng.uniform() < 0.5 {
                    children = 2 + (self.rng.uniform() * 3.0) as u32;
                }
            }
            let child = p.round(size / f64::from(children)).max(p.lot());
            for c in 0..children {
                let at = fills.len();
                self.market(buy, child, &mut fills);
                for f in &mut fills[at..] {
                    f.burst_child = NonZeroU32::new(c);
                }
            }
        }
        if swept && let Some(m) = self.mid() {
            self.bias += 0.5 * (m - driver as f64 - self.bias);
        }
        self.normalize(target);
        fills
    }

    fn refresh(&mut self, dt: f64, now: i64) {
        let p = self.params;
        let pull = 1.0 - (-dt / 4.0).exp();
        let noise = 0.12 * dt.sqrt();
        let redraw = dt / 30.0;
        let (bid, ask) = (self.bid_level(), self.ask_level());
        for buy in [true, false] {
            let keys: Vec<i64> = if buy {
                self.bids.keys().rev().copied().collect()
            } else {
                self.asks.keys().copied().collect()
            };
            for (d, level) in keys.into_iter().enumerate() {
                let new_target = (self.rng.uniform() < redraw).then(|| self.draw_target(d, level));
                let shock = self.rng.normal();
                let spoof = self.rng.uniform();
                let near = buy && bid.is_some_and(|b| b - level <= 1)
                    || !buy && ask.is_some_and(|a| level - a <= 1);
                let side = if buy { &mut self.bids } else { &mut self.asks };
                let Some(l) = side.get_mut(&level) else {
                    continue;
                };
                if let Some(t) = new_target {
                    l.target = t;
                }
                let size = l.size + (l.target - l.size) * pull + l.target * noise * shock;
                l.size = p.round(size).max(p.lot());
                if l.wall > 0.0 && (now >= l.wall_until || near && spoof < 0.8 * dt) {
                    l.wall = 0.0;
                }
            }
        }
        for buy in [true, false] {
            if self.rng.uniform() < 0.03 * dt {
                let life = (80.0 * -self.rng.uniform().ln()).clamp(15.0, 300.0);
                self.spawn_wall(buy, now, life);
            }
            if self.rng.uniform() < 0.02 * dt {
                self.spawn_iceberg(buy);
            }
        }
    }

    fn spawn_wall(&mut self, buy: bool, now: i64, life_secs: f64) {
        let p = self.params;
        let side = if buy { &self.bids } else { &self.asks };
        if side.values().filter(|l| l.wall > 0.0).count() >= WALLS_PER_SIDE {
            return;
        }
        let best = if buy {
            self.bid_level()
        } else {
            self.ask_level()
        };
        let Some(best) = best.filter(|_| p.depth > WALL_MIN_DISTANCE + 3) else {
            return;
        };
        let span = (p.depth - 3 - WALL_MIN_DISTANCE) as f64;
        let d = WALL_MIN_DISTANCE as i64 + (self.rng.uniform() * span) as i64;
        let mut level = if buy { best - d } else { best + d };
        if self.rng.uniform() < 0.6 && p.rounds[0] > 1 {
            let r = p.rounds[0];
            let snapped = (level + r / 2).div_euclid(r) * r;
            let ok = if buy {
                best - snapped >= WALL_MIN_DISTANCE as i64
            } else {
                snapped - best >= WALL_MIN_DISTANCE as i64
            };
            if ok {
                level = snapped;
            }
        }
        let size = p.size * (6.0 + 12.0 * self.rng.uniform()) * (0.4 * self.rng.normal()).exp();
        let size = p.round(size).max(p.lot());
        let until = now + (life_secs * 1e9) as i64;
        let side = if buy { &mut self.bids } else { &mut self.asks };
        if let Some(l) = side.get_mut(&level)
            && l.wall <= 0.0
        {
            l.wall = size;
            l.wall_until = until;
        }
    }

    fn spawn_iceberg(&mut self, buy: bool) {
        let p = self.params;
        let d = (self.rng.uniform() * 3.0) as i64;
        let peak = p
            .round(p.size * (0.3 + 0.5 * self.rng.uniform()))
            .max(p.lot());
        let reserve = p.round(peak * (8.0 + 22.0 * self.rng.uniform()));
        let level = if buy {
            self.bid_level().map(|b| b - d)
        } else {
            self.ask_level().map(|a| a + d)
        };
        let side = if buy { &mut self.bids } else { &mut self.asks };
        if let Some(l) = level.and_then(|k| side.get_mut(&k))
            && l.peak <= 0.0
        {
            l.peak = peak;
            l.clip = peak;
            l.reserve = reserve;
        }
    }

    fn drift(&mut self, target: i64, allowance: f64, fills: &mut Vec<Fill>) -> f64 {
        let mut order = 0;
        let p = self.params;
        let want_bid = self.bid_for(target);
        let want_ask = want_bid + p.spread;
        let mut traded = 0.0;
        for buy in [true, false] {
            let crossing: Vec<i64> = if buy {
                self.asks.range(..want_ask).map(|(k, _)| *k).collect()
            } else {
                self.bids
                    .range(want_bid + 1..)
                    .rev()
                    .map(|(k, _)| *k)
                    .collect()
            };
            let k = crossing.len().max(1) as f64;
            for level in crossing {
                let through = if buy {
                    want_ask - level
                } else {
                    level - want_bid
                };
                let u = 0.15 + 0.45 * self.rng.uniform();
                let coin = self.rng.uniform();
                let side = if buy { &mut self.asks } else { &mut self.bids };
                let Some(l) = side.get_mut(&level) else {
                    break;
                };
                let size = if l.is_strong() {
                    if through <= HOLD_LEVELS {
                        break;
                    }
                    l.broken_volume(coin, u)
                } else {
                    l.ordinary_volume(u, coin, (allowance - traded).max(0.0) / k, p.lot())
                };
                let size = p.round(size);
                side.remove(&level);
                if size > 0.0 {
                    traded += size;
                    fills.push(Fill {
                        ticks: level * p.step,
                        size,
                        aggressor: taker(buy),
                        order,
                        burst_child: None,
                    });
                    order += 1;
                }
            }
        }
        traded
    }

    fn market(&mut self, buy: bool, size: f64, fills: &mut Vec<Fill>) {
        let p = self.params;
        let order = fills.last().map_or(0, |f| f.order + 1);
        let mut left = size;
        while left > 0.0 {
            let side = if buy { &mut self.asks } else { &mut self.bids };
            let Some(level) = (if buy {
                side.keys().next().copied()
            } else {
                side.keys().next_back().copied()
            }) else {
                break;
            };
            let Some(l) = side.get_mut(&level) else {
                break;
            };
            let got = l.fill(left, &p);
            if l.total() <= 0.0 {
                side.remove(&level);
            }
            if got <= 0.0 {
                break;
            }
            left = p.round(left - got);
            fills.push(Fill {
                ticks: level * p.step,
                size: got,
                aggressor: taker(buy),
                order,
                burst_child: None,
            });
        }
    }

    fn normalize(&mut self, target: i64) {
        let p = self.params;
        let depth = p.depth as i64;
        let want_bid = self.bid_for(target);
        let (b, a) = match (self.bid_level(), self.ask_level()) {
            (Some(b), Some(a)) => (b, a),
            (Some(b), None) => (b, b.max(want_bid) + p.spread + 1),
            (None, Some(a)) => (a.min(want_bid + p.spread) - p.spread - 1, a),
            (None, None) => (want_bid, want_bid + p.spread),
        };
        let new_bid = if a - b > p.spread {
            want_bid.clamp(b, a - p.spread)
        } else {
            b
        };
        let new_ask = new_bid + p.spread;
        for level in (b + 1)..=new_bid {
            let fresh = 0.3 + 0.3 * self.rng.uniform();
            let l = self.new_level(0, level, fresh);
            self.bids.insert(level, l);
        }
        for level in new_ask..a {
            let fresh = 0.3 + 0.3 * self.rng.uniform();
            let l = self.new_level(0, level, fresh);
            self.asks.insert(level, l);
        }
        for d in 0..depth {
            let lb = new_bid - d;
            if !self.bids.contains_key(&lb) {
                let l = self.new_level(d as usize, lb, 1.0);
                self.bids.insert(lb, l);
            }
            let la = new_ask + d;
            if !self.asks.contains_key(&la) {
                let l = self.new_level(d as usize, la, 1.0);
                self.asks.insert(la, l);
            }
        }
        self.bids = self.bids.split_off(&(new_bid - depth + 1));
        self.bids.retain(|k, _| *k <= new_bid);
        let _ = self.asks.split_off(&(new_ask + depth));
        self.asks.retain(|k, _| *k >= new_ask);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nq() -> BookParams {
        BookParams {
            step: 1,
            spread: 1,
            depth: 40,
            size: 12.0,
            print_size: 2.0,
            rounds: [20, 100, 400],
            qty_decimals: 0,
        }
    }

    fn assert_sane(b: &Book) {
        let p = b.params;
        let (bid, ask) = (b.bid_level().unwrap(), b.ask_level().unwrap());
        assert!(bid < ask, "crossed: {bid} >= {ask}");
        assert!(ask - bid >= p.spread);
        assert_eq!(b.bids.len(), p.depth);
        assert_eq!(b.asks.len(), p.depth);
        for l in b.bids.values().chain(b.asks.values()) {
            assert!(l.size >= 0.0 && l.wall >= 0.0 && l.clip >= 0.0 && l.reserve >= 0.0);
            assert!(l.displayed() > 0.0);
            assert!(l.orders() >= 1);
        }
        assert_eq!(*b.bids.keys().next().unwrap(), bid - p.depth as i64 + 1);
        assert_eq!(
            *b.asks.keys().next_back().unwrap(),
            ask + p.depth as i64 - 1
        );
    }

    fn run(seed: u64, ticks: usize) -> (Book, Vec<Vec<Fill>>) {
        let mut b = Book::new(nq(), seed);
        let mut target = 82_565i64;
        let mut walk = SplitMix::new(seed ^ 77);
        b.reset(target, 0);
        let mut all = Vec::new();
        for i in 0..ticks {
            let r = walk.normal();
            target += (1.2 * r).round() as i64;
            let fills = b.tick(TickInput {
                now: i as i64 * 250_000_000,
                dt: 0.25,
                target_ticks: target,
                budget: 4.0,
                p_buy: 0.5 + 0.35 * r.tanh(),
            });
            assert_sane(&b);
            all.push(fills);
        }
        (b, all)
    }

    #[test]
    fn the_book_never_crosses_and_keeps_its_shape() {
        let (b, fills) = run(5, 4_000);
        assert_sane(&b);
        let n: usize = fills.iter().map(Vec::len).sum();
        assert!(n > 2_000, "prints {n}");
        let bids = b.bids(40);
        let inside: f64 = bids[..3].iter().map(|l| l.size).sum::<f64>() / 3.0;
        let deep: f64 = bids[25..].iter().map(|l| l.size).sum::<f64>() / 15.0;
        assert!(deep > inside, "deep {deep} inside {inside}");
    }

    #[test]
    fn prints_execute_against_the_book() {
        let mut b = Book::new(nq(), 9);
        b.reset(1_000, 0);
        let best_ask = b.best_ask().unwrap();
        let (ask, ask_size) = (best_ask.ticks, best_ask.size);
        let bid = b.best_bid().unwrap().ticks;
        let mut fills = Vec::new();
        let small = (ask_size - 1.0).max(1.0);
        b.market(true, small, &mut fills);
        assert_eq!(
            fills,
            vec![Fill {
                burst_child: None,
                ticks: ask,
                size: small,
                aggressor: Aggressor::Buy,
                order: 0,
            }]
        );
        fills.clear();
        b.market(true, 200.0, &mut fills);
        assert!(fills.len() > 2, "{fills:?}");
        assert!(fills.windows(2).all(|w| w[1].ticks > w[0].ticks));
        assert!(
            fills
                .iter()
                .all(|f| f.aggressor == Aggressor::Buy && f.ticks >= ask && f.order == 0)
        );
        assert_eq!(fills.iter().map(|f| f.size).sum::<f64>(), 200.0);
        assert!(b.best_ask().unwrap().ticks > ask);
        fills.clear();
        b.market(false, 1.0, &mut fills);
        assert_eq!(fills[0].ticks, bid);
        assert_eq!(fills[0].aggressor, Aggressor::Sell);
    }

    #[test]
    fn icebergs_refill_from_their_reserve() {
        let p = nq();
        let mut l = Level {
            size: 3.0,
            unit: 3.0,
            clip: 2.0,
            peak: 2.0,
            reserve: 6.0,
            ..Level::default()
        };
        assert_eq!(l.displayed(), 5.0);
        assert_eq!(l.orders(), 2);
        assert_eq!(l.fill(4.0, &p), 4.0);
        assert_eq!((l.size, l.clip, l.reserve), (0.0, 1.0, 6.0));
        assert_eq!(l.fill(4.0, &p), 4.0);
        assert_eq!((l.clip, l.reserve), (1.0, 2.0));
        assert_eq!(l.fill(10.0, &p), 3.0);
        assert_eq!(l.total(), 0.0);
        assert_eq!(l.peak, 0.0);
    }

    #[test]
    fn large_orders_appear_sit_and_get_pulled() {
        let mut b = Book::new(nq(), 3);
        b.reset(50_000, 0);
        let mut seen = 0;
        let mut pulled = 0;
        let mut prev: Vec<i64> = Vec::new();
        for i in 0..8_000 {
            b.tick(TickInput {
                now: i * 250_000_000,
                dt: 0.25,
                target_ticks: 50_000 + ((i as f64 / 40.0).sin() * 6.0) as i64,
                budget: 4.0,
                p_buy: 0.5,
            });
            let walls: Vec<i64> = b
                .bids
                .iter()
                .chain(b.asks.iter())
                .filter(|(_, l)| l.wall > 0.0)
                .map(|(k, _)| *k)
                .collect();
            seen += walls.iter().filter(|w| !prev.contains(w)).count();
            pulled += prev.iter().filter(|w| !walls.contains(w)).count();
            prev = walls;
        }
        assert!(seen > 20, "walls appeared {seen}");
        assert!(pulled > 15, "walls went away {pulled}");
    }

    #[test]
    fn the_book_is_deterministic() {
        let (a, fa) = run(11, 600);
        let (b, fb) = run(11, 600);
        let (_, fc) = run(12, 600);
        assert_eq!(fa, fb);
        assert_eq!(a.bids(40), b.bids(40));
        assert_eq!(a.asks(40), b.asks(40));
        assert_ne!(fa, fc);
    }

    #[test]
    fn the_inside_follows_the_driver() {
        let mut b = Book::new(nq(), 4);
        b.reset(10_000, 0);
        let mut fills = Vec::new();
        for i in 1..=40 {
            fills.extend(b.tick(TickInput {
                now: i * 250_000_000,
                dt: 0.25,
                target_ticks: 10_000 + i,
                budget: 4.0,
                p_buy: 0.6,
            }));
        }
        let mid = (b.best_bid().unwrap().ticks + b.best_ask().unwrap().ticks) as f64 / 2.0;
        assert!((mid - 10_040.0).abs() <= 6.0, "mid {mid}");
        let buys: f64 = fills
            .iter()
            .filter(|f| f.aggressor == Aggressor::Buy)
            .map(|f| f.size)
            .sum();
        let total: f64 = fills.iter().map(|f| f.size).sum();
        assert!(buys > 0.5 * total, "buys {buys} of {total}");
        let f = b.tick(TickInput {
            now: 41 * 250_000_000,
            dt: 0.25,
            target_ticks: 20_000,
            budget: 4.0,
            p_buy: 0.5,
        });
        assert!(f.is_empty());
        assert_eq!(b.best_bid().unwrap().ticks, 20_000);
    }

    #[test]
    fn crypto_rests_at_round_levels() {
        let p = BookParams {
            step: 500,
            spread: 1,
            depth: 20,
            size: 0.8,
            print_size: 0.05,
            rounds: [10, 20, 100],
            qty_decimals: 4,
        };
        let mut b = Book::new(p, 1);
        b.reset(9_841_200, 0);
        for i in 0..400 {
            let fills = b.tick(TickInput {
                now: i * 250_000_000,
                dt: 0.25,
                target_ticks: 9_841_200 + (i % 7) * 300,
                budget: 0.04,
                p_buy: 0.5,
            });
            for f in fills {
                assert_eq!(f.ticks % 500, 0);
                assert!(f.size >= 0.0001);
                assert_eq!(f.size, p.round(f.size));
            }
        }
        assert_sane(&b);
    }
}
