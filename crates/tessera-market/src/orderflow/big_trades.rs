use std::collections::HashSet;

use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use tessera_core::market::{Aggressor, Trade};
use tessera_core::session::{SessionCalendar, TradingSession};
use tessera_core::time::{NANOS_PER_MILLI, NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{Price, Qty, Timestamp};

use crate::io::{BigTrade, BigTradeCuts, BigTradeOutcome, BigTradeOutcomeKind, BigTradeTier};

pub const CONTINUATION_NS: i64 = 5 * NANOS_PER_MILLI;
const CONTINUATION_TICKS: i64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Grouping {
    pub join_orders: bool,
    pub reach_limit: bool,
}

impl Default for Grouping {
    fn default() -> Self {
        Self {
            join_orders: true,
            reach_limit: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AggressorOrder {
    pub t: Timestamp,
    pub last_t: Timestamp,
    pub aggressor: Aggressor,
    pub size: Qty,
    notional: Decimal,
    pub first: Price,
    pub last: Price,
    pub low: Price,
    pub high: Price,
    pub levels: u32,
    pub prints: u32,
    pub orders: u32,
    pub order_key: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Join {
    No,
    Same,
    Continued,
}

impl AggressorOrder {
    pub fn start(t: &Trade) -> Self {
        Self {
            t: t.ts,
            last_t: t.ts,
            order_key: t.order_key,
            aggressor: t.aggressor,
            size: t.size,
            notional: t.price.0 * t.size.0,
            first: t.price,
            last: t.price,
            low: t.price,
            high: t.price,
            levels: 1,
            prints: 1,
            orders: 1,
        }
    }

    pub fn average_price(&self) -> Price {
        if self.size.is_zero() {
            return self.last;
        }
        Price(self.notional / self.size.0)
    }

    pub fn range_ticks(&self, tick: Price) -> u32 {
        ticks_between(self.low, self.high, tick).unsigned_abs() as u32
    }

    pub fn joins(&self, t: &Trade, tick: Price, grouping: Grouping) -> Join {
        if t.aggressor != self.aggressor {
            return Join::No;
        }
        let same_key = matches!((self.order_key, t.order_key), (Some(a), Some(b)) if a == b);
        if grouping.join_orders && same_key {
            return Join::Same;
        }
        if self.aggressor == Aggressor::Unknown {
            return if t.ts == self.last_t && t.price == self.last {
                Join::Same
            } else {
                Join::No
            };
        }
        let unkeyed_at_once =
            t.ts == self.last_t && (self.order_key.is_none() || t.order_key.is_none());
        if grouping.join_orders && unkeyed_at_once {
            return Join::Same;
        }
        let gap = t.ts.0 - self.last_t.0;
        if !(0..=CONTINUATION_NS).contains(&gap) {
            return Join::No;
        }
        let reach = Price(tick.0 * Decimal::from(CONTINUATION_TICKS));
        let within = match self.aggressor {
            Aggressor::Buy => {
                t.price >= self.last && (!grouping.reach_limit || t.price <= self.high + reach)
            }
            Aggressor::Sell => {
                t.price <= self.last && (!grouping.reach_limit || t.price >= self.low - reach)
            }
            Aggressor::Unknown => false,
        };
        match (within, same_key || unkeyed_at_once) {
            (false, _) => Join::No,
            (true, true) => Join::Same,
            (true, false) => Join::Continued,
        }
    }

    fn add(&mut self, t: &Trade, join: Join) {
        self.size = self.size + t.size;
        self.notional += t.price.0 * t.size.0;
        if t.price < self.low || t.price > self.high {
            self.levels += 1;
        }
        self.low = self.low.min(t.price);
        self.high = self.high.max(t.price);
        self.last = t.price;
        self.last_t = self.last_t.max(t.ts);
        self.prints += 1;
        if join == Join::Continued {
            self.orders += 1;
        }
        if t.order_key.is_some() {
            self.order_key = t.order_key;
        }
    }
}

fn ticks_between(a: Price, b: Price, tick: Price) -> i64 {
    if tick.0.is_zero() {
        return 0;
    }
    ((b.0 - a.0) / tick.0).round().to_i64().unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct OrderAggregator {
    tick: Price,
    grouping: Grouping,
    current: Option<AggressorOrder>,
}

impl OrderAggregator {
    pub fn new(tick: Price, grouping: Grouping) -> Self {
        Self {
            tick,
            grouping,
            current: None,
        }
    }

    pub fn push(&mut self, t: &Trade) -> Option<AggressorOrder> {
        if let Some(o) = &mut self.current {
            let join = o.joins(t, self.tick, self.grouping);
            if join != Join::No {
                o.add(t, join);
                return None;
            }
        }
        self.current.replace(AggressorOrder::start(t))
    }

    pub fn open(&self) -> Option<&AggressorOrder> {
        self.current.as_ref()
    }

    pub fn close_before(&mut self, now: Timestamp) -> Option<AggressorOrder> {
        if self
            .current
            .as_ref()
            .is_some_and(|o| now.0 - o.last_t.0 > CONTINUATION_NS)
        {
            return self.current.take();
        }
        None
    }

    pub fn finish(&mut self) -> Option<AggressorOrder> {
        self.current.take()
    }
}

pub const MIN_NOTIONAL: f64 = 500_000.0;
pub const MODEL_SESSIONS: u32 = 5;
pub const MIN_MODEL_MINUTES: u32 = 60;
pub const FOLLOW_NS: i64 = 60 * NANOS_PER_SEC;
pub const MIN_REACH_TICKS: u32 = 2;
pub const HALF_HOUR_NS: i64 = 30 * NANOS_PER_MINUTE;
const REACH_OF_TYPICAL: f64 = 0.5;
const ES_MANUAL_MIN: i64 = 30;

pub const TIERS: [BigTradeTier; 3] = [BigTradeTier::High, BigTradeTier::Medium, BigTradeTier::Low];

pub fn per_session(tier: BigTradeTier) -> u32 {
    match tier {
        BigTradeTier::High => 15,
        BigTradeTier::Medium => 45,
        BigTradeTier::Low => 120,
    }
}

pub fn floor_of(root: Option<&str>) -> Qty {
    Qty::from(match root {
        Some("ES") => 20,
        Some("NQ") => 8,
        _ => 1,
    })
}

pub fn manual_min_of(floor: Qty) -> Qty {
    let scaled = (Decimal::from(ES_MANUAL_MIN) * floor.0 / floor_of(Some("ES")).0)
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    Qty(scaled.max(Decimal::ONE))
}

pub fn session_of(calendar: SessionCalendar, t: Timestamp) -> Option<TradingSession> {
    calendar.session(calendar.trade_date(t))
}

pub fn half_hour_in(session: &TradingSession, t: Timestamp) -> Option<usize> {
    usize::try_from((t.0 - session.open.0).div_euclid(HALF_HOUR_NS)).ok()
}

pub fn half_hours_of(session: &TradingSession) -> usize {
    usize::try_from((session.close.0 - session.open.0 + HALF_HOUR_NS - 1).div_euclid(HALF_HOUR_NS))
        .unwrap_or(0)
}

fn cuts_of(
    mut sizes: Vec<Qty>,
    minutes: u32,
    session_minutes: f64,
    floor: Qty,
) -> Option<BigTradeCuts> {
    if minutes < MIN_MODEL_MINUTES || session_minutes <= 0.0 {
        return None;
    }
    sizes.sort_unstable_by(|a, b| b.cmp(a));
    let scale = f64::from(minutes) / session_minutes;
    let at = |tier: BigTradeTier| {
        let rank = (f64::from(per_session(tier)) * scale).round() as usize;
        sizes
            .get(rank.clamp(1, sizes.len().max(1)) - 1)
            .copied()
            .unwrap_or(floor)
    };
    let step = Qty::from(1);
    let low = at(BigTradeTier::Low);
    let medium = at(BigTradeTier::Medium).max(low + step);
    let high = at(BigTradeTier::High).max(medium + step);
    Some(BigTradeCuts { low, medium, high })
}

fn upper_median(values: &mut [u32]) -> Option<u32> {
    values.sort_unstable();
    values.get(values.len() / 2).copied()
}

fn reach_of(typical: Option<u32>) -> u32 {
    let half = (REACH_OF_TYPICAL * f64::from(typical.unwrap_or(0))).round() as u32;
    half.max(MIN_REACH_TICKS)
}

#[derive(Clone, Debug)]
struct MinuteRanges {
    tick: Price,
    calendar: SessionCalendar,
    session: Option<TradingSession>,
    open: Option<(i64, Price, Price)>,
    by_half_hour: Vec<Vec<u32>>,
}

impl MinuteRanges {
    fn new(tick: Price, calendar: SessionCalendar) -> Self {
        Self {
            tick,
            calendar,
            session: None,
            open: None,
            by_half_hour: Vec::new(),
        }
    }

    fn add(&mut self, t: &Trade) {
        let minute = t.ts.0.div_euclid(NANOS_PER_MINUTE);
        if let Some((m, low, high)) = &mut self.open
            && *m == minute
        {
            *low = (*low).min(t.price);
            *high = (*high).max(t.price);
            return;
        }
        self.close();
        self.open = Some((minute, t.price, t.price));
    }

    fn close(&mut self) {
        if let Some((minute, low, high)) = self.open.take() {
            let ticks = ticks_between(low, high, self.tick).unsigned_abs() as u32;
            let t = Timestamp(minute * NANOS_PER_MINUTE);
            if !self
                .session
                .as_ref()
                .is_some_and(|s| s.open <= t && t < s.close)
            {
                self.session = session_of(self.calendar, t);
            }
            let Some(session) = &self.session else {
                return;
            };
            let Some(at) = half_hour_in(session, t) else {
                return;
            };
            let len = half_hours_of(session).max(at + 1);
            if self.by_half_hour.len() < len {
                self.by_half_hour.resize(len, Vec::new());
            }
            self.by_half_hour[at].push(ticks);
        }
    }

    fn reach_ticks(mut self) -> Vec<u32> {
        self.close();
        let mut all: Vec<u32> = self.by_half_hour.iter().flatten().copied().collect();
        let all_day = upper_median(&mut all);
        self.by_half_hour
            .iter_mut()
            .map(|ranges| reach_of(upper_median(ranges).or(all_day)))
            .collect()
    }
}

#[derive(Clone, Debug)]
pub struct ModelBuilder {
    calendar: SessionCalendar,
    contract: Contract,
    sizes: Vec<Qty>,
    minutes: HashSet<i64>,
    ranges: MinuteRanges,
    date: Option<NaiveDate>,
    sessions: u32,
    session_minutes: i64,
    orders: u64,
}

impl ModelBuilder {
    pub fn new(calendar: SessionCalendar, contract: Contract) -> Self {
        Self {
            calendar,
            contract,
            sizes: Vec::new(),
            minutes: HashSet::new(),
            ranges: MinuteRanges::new(contract.tick, calendar),
            date: None,
            sessions: 0,
            session_minutes: 0,
            orders: 0,
        }
    }

    pub fn add_print(&mut self, t: &Trade) {
        self.ranges.add(t);
    }

    pub fn add(&mut self, o: &AggressorOrder) {
        if o.aggressor == Aggressor::Unknown {
            return;
        }
        let date = self.calendar.trade_date(o.t);
        if self.date != Some(date) {
            self.date = Some(date);
            self.sessions += 1;
            self.session_minutes += self.calendar.session(date).map_or(0, |s| s.minute_count());
        }
        self.orders += 1;
        self.minutes.insert(o.t.0.div_euclid(NANOS_PER_MINUTE));
        if self.contract.passes_floors(o) {
            self.sizes.push(o.size);
        }
    }

    pub fn build(self, date: NaiveDate, coverage: ModelCoverage) -> BigTradeModel {
        let minutes = self.minutes.len() as u32;
        let session_minutes = self.session_minutes as f64 / f64::from(self.sessions.max(1));
        BigTradeModel {
            date,
            calendar: self.calendar,
            cuts: cuts_of(self.sizes, minutes, session_minutes, self.contract.floor),
            reach_ticks: self.ranges.reach_ticks(),
            minutes,
            orders: self.orders,
            sessions: self.sessions,
            floor: self.contract.floor,
            multiplier: self.contract.multiplier,
            partial: coverage.partial,
            pulling: coverage.pulling,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ModelCoverage {
    pub partial: bool,
    pub pulling: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BigTradeModel {
    pub date: NaiveDate,
    calendar: SessionCalendar,
    pub cuts: Option<BigTradeCuts>,
    pub reach_ticks: Vec<u32>,
    pub minutes: u32,
    orders: u64,
    pub sessions: u32,
    pub floor: Qty,
    pub multiplier: f64,
    pub partial: bool,
    pub pulling: bool,
}

impl BigTradeModel {
    pub fn trade_date(&self, t: Timestamp) -> NaiveDate {
        self.calendar.trade_date(t)
    }

    pub fn orders(&self) -> u64 {
        self.orders
    }

    pub fn sized(&self) -> bool {
        self.cuts.is_some()
    }

    pub fn tier(&self, size: Qty) -> Option<BigTradeTier> {
        self.cuts.as_ref()?.tier(size)
    }

    pub fn reach_from(&self) -> Option<Timestamp> {
        self.calendar.session(self.date).map(|s| s.open)
    }

    pub fn reach_at(&self, t: Timestamp) -> u32 {
        session_of(self.calendar, t)
            .and_then(|s| half_hour_in(&s, t))
            .and_then(|at| self.reach_ticks.get(at))
            .copied()
            .unwrap_or(MIN_REACH_TICKS)
    }

    pub fn size_at(&self, tier: BigTradeTier, price: f64, lot: f64) -> f64 {
        let notional = if price > 0.0 && self.multiplier > 0.0 {
            MIN_NOTIONAL / (price * self.multiplier)
        } else {
            0.0
        };
        let by_cut = self.cuts.as_ref().map_or(0.0, |c| c.of(tier).to_f64());
        let lot = if lot > 0.0 { lot } else { 1.0 };
        let raw = by_cut.max(notional).max(self.floor.to_f64());
        (raw / lot - 1e-9).ceil().max(1.0) * lot
    }
}

impl BigTradeCuts {
    pub fn of(&self, tier: BigTradeTier) -> Qty {
        match tier {
            BigTradeTier::High => self.high,
            BigTradeTier::Medium => self.medium,
            BigTradeTier::Low => self.low,
        }
    }

    pub fn tier(&self, size: Qty) -> Option<BigTradeTier> {
        TIERS.into_iter().find(|t| size >= self.of(*t))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum BigFilter {
    Auto(Vec<BigTradeTier>),
    Manual { min: Qty, max: Option<Qty> },
}

impl BigFilter {
    pub fn admits(&self, t: &BigTrade) -> bool {
        match self {
            Self::Auto(tiers) => t.tier.is_some_and(|tier| tiers.contains(&tier)),
            Self::Manual { min, max } => t.size >= *min && max.is_none_or(|m| t.size <= m),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Contract {
    pub tick: Price,
    pub lot: f64,
    pub floor: Qty,
    pub multiplier: f64,
    pub min_notional: f64,
}

impl Contract {
    pub fn passes_floors(&self, o: &AggressorOrder) -> bool {
        if o.aggressor == Aggressor::Unknown || o.size < self.floor {
            return false;
        }
        let notional = o.average_price().to_f64() * o.size.to_f64() * self.multiplier;
        notional >= self.min_notional
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OutcomeWatch {
    buy: bool,
    through: Price,
    back: Price,
    last_t: Timestamp,
    reach_ticks: u32,
}

impl OutcomeWatch {
    pub fn new(o: &AggressorOrder, tick: Price, reach_ticks: u32) -> Option<Self> {
        let reach = Price(tick.0 * Decimal::from(reach_ticks));
        let avg = o.average_price();
        let (buy, through, back) = match o.aggressor {
            Aggressor::Buy => (true, o.high + reach, avg - reach),
            Aggressor::Sell => (false, o.low - reach, avg + reach),
            Aggressor::Unknown => return None,
        };
        Some(Self {
            buy,
            through,
            back,
            last_t: o.last_t,
            reach_ticks,
        })
    }

    pub fn ends(&self) -> Timestamp {
        Timestamp(self.last_t.0 + FOLLOW_NS)
    }

    fn decided(&self, kind: BigTradeOutcomeKind, at: Timestamp) -> BigTradeOutcome {
        BigTradeOutcome {
            kind,
            decided: at,
            reach_ticks: self.reach_ticks,
        }
    }

    pub fn on_print(&self, t: &Trade) -> Option<BigTradeOutcome> {
        if t.ts <= self.last_t {
            return None;
        }
        if t.ts > self.ends() {
            return Some(self.decided(BigTradeOutcomeKind::Neither, self.ends()));
        }
        let (pushed, absorbed) = if self.buy {
            (t.price >= self.through, t.price <= self.back)
        } else {
            (t.price <= self.through, t.price >= self.back)
        };
        match (pushed, absorbed) {
            (true, _) => Some(self.decided(BigTradeOutcomeKind::Pushed, t.ts)),
            (_, true) => Some(self.decided(BigTradeOutcomeKind::Absorbed, t.ts)),
            _ => None,
        }
    }

    pub fn at_end(&self, read_to: Timestamp) -> Option<BigTradeOutcome> {
        (self.ends() < read_to).then(|| self.decided(BigTradeOutcomeKind::Neither, self.ends()))
    }
}

#[derive(Clone, Debug)]
pub struct EventCloser {
    contract: Contract,
    agg: OrderAggregator,
    open_seq: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct Closed {
    pub big: Vec<(AggressorOrder, Option<u64>)>,
    pub events: Vec<AggressorOrder>,
}

impl EventCloser {
    pub fn new(contract: Contract, grouping: Grouping) -> Self {
        Self {
            contract,
            agg: OrderAggregator::new(contract.tick, grouping),
            open_seq: None,
        }
    }

    pub fn contract(&self) -> Contract {
        self.contract
    }

    fn close(&mut self, o: AggressorOrder, seq: Option<u64>, out: &mut Closed) {
        if self.contract.passes_floors(&o) {
            out.big.push((o.clone(), seq));
        }
        out.events.push(o);
    }

    pub fn push(&mut self, t: &Trade, seq: Option<u64>, out: &mut Closed) {
        let first_seq = self.open_seq;
        if let Some(o) = self.agg.push(t) {
            self.close(o, first_seq, out);
            self.open_seq = seq;
        } else if self.agg.open().is_some_and(|o| o.prints == 1) {
            self.open_seq = seq;
        }
    }

    pub fn advance(&mut self, now: Timestamp, out: &mut Closed) {
        if let Some(o) = self.agg.close_before(now) {
            let seq = self.open_seq.take();
            self.close(o, seq, out);
        }
    }

    pub fn finish(&mut self, out: &mut Closed) {
        if let Some(o) = self.agg.finish() {
            let seq = self.open_seq.take();
            self.close(o, seq, out);
        }
    }
}

pub fn to_wire(
    o: &AggressorOrder,
    seq: Option<u64>,
    contract: &Contract,
    model: Option<&BigTradeModel>,
) -> BigTrade {
    BigTrade {
        t: o.t,
        duration_ns: o.last_t.0 - o.t.0,
        side: o.aggressor,
        size: o.size,
        price: Price(o.average_price().0.round_dp(8).normalize()),
        first_price: o.first,
        last_price: o.last,
        levels: o.levels,
        range_ticks: o.range_ticks(contract.tick),
        prints: o.prints,
        orders: o.orders,
        tier: model
            .filter(|_| contract.passes_floors(o))
            .and_then(|m| m.tier(o.size)),
        outcome: None,
        seq,
    }
}

#[cfg(test)]
mod tests;
