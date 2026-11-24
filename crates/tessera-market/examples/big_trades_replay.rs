use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chrono::NaiveDate;
use serde_json::json;
use tessera_core::market::{Aggressor, AggressorSource, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_MICRO, NANOS_PER_MINUTE, NANOS_PER_SEC};
use tessera_core::{InstrumentId, Price, Qty, Timestamp};
use tessera_market::io::{BigTradeOutcome, BigTradeOutcomeKind, BigTradeTier};
use tessera_market::orderflow::big_trades::{
    AggressorOrder, BigTradeModel, Contract, Grouping, MIN_NOTIONAL, MODEL_SESSIONS, ModelBuilder,
    ModelCoverage, OrderAggregator, OutcomeWatch, floor_of,
};

const USAGE: &str = "usage: big_trades_replay <dir of SYMBOL csv ticks> [--sessions N] [--events]";
const WHOLE_SLACK_NS: i64 = 5 * NANOS_PER_MINUTE;
const OPEN_HOUR_NS: i64 = 60 * NANOS_PER_MINUTE;
const MANUAL_REFERENCE: i64 = 60;

struct Args {
    dir: PathBuf,
    sessions: usize,
    events: bool,
}

fn args() -> Result<Args, String> {
    let mut dir = None;
    let mut sessions = MODEL_SESSIONS as usize;
    let mut events = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--events" => events = true,
            "--sessions" => {
                sessions = it
                    .next()
                    .and_then(|n| n.parse().ok())
                    .filter(|n| *n > 0)
                    .ok_or("--sessions takes a count of 1 or more")?;
            }
            _ if dir.is_none() => dir = Some(PathBuf::from(a)),
            _ => return Err(format!("unexpected {a}")),
        }
    }
    Ok(Args {
        dir: dir.ok_or(USAGE)?,
        sessions,
        events,
    })
}

struct Spec {
    symbol: String,
    root: String,
    tick: Price,
    multiplier: f64,
}

fn spec_of(dir: &Path) -> Result<Spec, String> {
    let symbol = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("the directory is named for its symbol, such as NQZ6")?
        .to_owned();
    let root = symbol
        .get(..symbol.len().saturating_sub(2))
        .unwrap_or_default()
        .to_owned();
    let multiplier = match root.as_str() {
        "NQ" => 20.0,
        "ES" => 50.0,
        "MNQ" => 2.0,
        "MES" => 5.0,
        _ => return Err(format!("{symbol}: no contract spec for root {root}")),
    };
    Ok(Spec {
        symbol,
        root,
        tick: Price::from_str("0.25").expect("a price"),
        multiplier,
    })
}

#[derive(Clone, Copy)]
struct Print {
    ts: Timestamp,
    price: Price,
    size: Qty,
    side: Aggressor,
}

fn side_of(bid: f64, ask: f64) -> Aggressor {
    match (bid > 0.0, ask > 0.0) {
        (true, false) => Aggressor::Buy,
        (false, true) => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

fn parse(line: &str) -> Option<Print> {
    let mut f = line.split(',');
    let ssboe: i64 = f.next()?.parse().ok()?;
    let usecs: i64 = f.next()?.parse().ok()?;
    let price = Price::from_str(f.next()?).ok()?;
    let size = Qty::from_str(f.next()?).ok()?;
    let bid: f64 = f.next()?.parse().ok()?;
    let ask: f64 = f.next()?.parse().ok()?;
    if size <= Qty::ZERO {
        return None;
    }
    let ts = ssboe.checked_mul(NANOS_PER_SEC)? + usecs * NANOS_PER_MICRO;
    Some(Print {
        ts: Timestamp(ts),
        price,
        size,
        side: side_of(bid, ask),
    })
}

fn load(dir: &Path) -> Result<Vec<Print>, String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "csv"))
        .collect();
    files.sort();
    let mut prints = Vec::new();
    for f in files {
        let text = std::fs::read_to_string(&f).map_err(|e| format!("{}: {e}", f.display()))?;
        prints.extend(text.lines().filter_map(parse));
    }
    prints.sort_by_key(|p| p.ts);
    Ok(prints)
}

struct Tape {
    prints: Vec<Print>,
    template: Trade,
}

impl Tape {
    fn each(&self, range: std::ops::Range<usize>, mut f: impl FnMut(&Trade)) {
        let mut t = self.template.clone();
        for p in &self.prints[range] {
            t.ts = p.ts;
            t.price = p.price;
            t.size = p.size;
            t.aggressor = p.side;
            f(&t);
        }
    }

    fn at(&self, from: Timestamp) -> usize {
        self.prints.partition_point(|p| p.ts < from)
    }

    fn after(&self, t: Timestamp) -> usize {
        self.prints.partition_point(|p| p.ts <= t)
    }

    fn end(&self) -> Timestamp {
        self.prints
            .last()
            .map_or(Timestamp(0), |p| Timestamp(p.ts.0 + 1))
    }
}

struct Day {
    date: NaiveDate,
    from: Timestamp,
    to: Timestamp,
    whole: bool,
}

fn day(calendar: SessionCalendar, date: NaiveDate, tape: &Tape) -> Day {
    let from = calendar.trade_date_end(calendar.prev_trade_date(date));
    let to = calendar.trade_date_end(date);
    let (open, close) = calendar
        .session(date)
        .map_or((from, to), |s| (s.open, s.close));
    let first = tape.prints.first().map_or(Timestamp(i64::MAX), |p| p.ts);
    let last = tape.prints.last().map_or(Timestamp(i64::MIN), |p| p.ts);
    Day {
        date,
        from,
        to,
        whole: first.0 <= open.0 + WHOLE_SLACK_NS && last.0 >= close.0 - WHOLE_SLACK_NS,
    }
}

fn events_of(tape: &Tape, d: &Day, tick: Price) -> Vec<AggressorOrder> {
    let mut agg = OrderAggregator::new(tick, Grouping::default());
    let mut out = Vec::new();
    tape.each(tape.at(d.from)..tape.at(d.to), |t| out.extend(agg.push(t)));
    out.extend(agg.finish());
    out
}

fn model_of(
    tape: &Tape,
    days: &[Day],
    calendar: SessionCalendar,
    contract: Contract,
    date: NaiveDate,
) -> BigTradeModel {
    let mut b = ModelBuilder::new(calendar, contract);
    for d in days {
        let mut agg = OrderAggregator::new(contract.tick, Grouping::default());
        tape.each(tape.at(d.from)..tape.at(d.to), |t| {
            b.add_print(t);
            if let Some(o) = agg.push(t) {
                b.add(&o);
            }
        });
        if let Some(o) = agg.finish() {
            b.add(&o);
        }
    }
    b.build(date, ModelCoverage::default())
}

fn outcome_of(tape: &Tape, o: &AggressorOrder, w: &OutcomeWatch) -> Option<BigTradeOutcome> {
    let mut decided = None;
    let from = tape.after(o.last_t);
    let mut t = tape.template.clone();
    for p in &tape.prints[from..] {
        t.ts = p.ts;
        t.price = p.price;
        decided = w.on_print(&t);
        if decided.is_some() {
            break;
        }
    }
    decided.or_else(|| w.at_end(tape.end()))
}

#[derive(Default)]
struct Counts {
    high: u32,
    medium: u32,
    low: u32,
    absorbed: u32,
    pushed: u32,
    neither: u32,
    undecided: u32,
    open_hour: u32,
    manual: u32,
}

impl Counts {
    fn tier(&mut self, t: BigTradeTier) {
        *match t {
            BigTradeTier::High => &mut self.high,
            BigTradeTier::Medium => &mut self.medium,
            BigTradeTier::Low => &mut self.low,
        } += 1;
    }

    fn outcome(&mut self, o: Option<BigTradeOutcome>) {
        *match o.map(|o| o.kind) {
            Some(BigTradeOutcomeKind::Absorbed) => &mut self.absorbed,
            Some(BigTradeOutcomeKind::Pushed) => &mut self.pushed,
            Some(BigTradeOutcomeKind::Neither) => &mut self.neither,
            None => &mut self.undecided,
        } += 1;
    }
}

fn open_hour(calendar: SessionCalendar, date: NaiveDate) -> Option<std::ops::Range<i64>> {
    let s = calendar.session(date)?;
    let start = s.rth.map_or(s.open, |w| w.start).0;
    Some(start..start + OPEN_HOUR_NS)
}

fn run(a: &Args) -> Result<(), String> {
    let spec = spec_of(&a.dir)?;
    let calendar = SessionCalendar::of_cme_root(&spec.root);
    let contract = Contract {
        tick: spec.tick,
        lot: 1.0,
        floor: floor_of(Some(&spec.root)),
        multiplier: spec.multiplier,
        min_notional: MIN_NOTIONAL,
    };
    let instrument =
        InstrumentId::new(format!("{}.CME", spec.symbol)).map_err(|e| e.to_string())?;
    let tape = Tape {
        prints: load(&a.dir)?,
        template: Trade {
            instrument,
            ts: Timestamp(0),
            price: Price::from(0),
            size: Qty::ZERO,
            aggressor: Aggressor::Unknown,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
            source: None,
        },
    };
    let dates: BTreeSet<NaiveDate> = tape
        .prints
        .iter()
        .map(|p| calendar.trade_date(p.ts))
        .collect();
    for date in dates {
        let mut prior = Vec::with_capacity(a.sessions);
        let mut d = date;
        while prior.len() < a.sessions {
            d = calendar.prev_trade_date(d);
            prior.push(day(calendar, d, &tape));
        }
        prior.reverse();
        if !prior.iter().all(|d| d.whole) {
            continue;
        }
        let today = day(calendar, date, &tape);
        let model = model_of(&tape, &prior, calendar, contract, date);
        let open_hour = open_hour(calendar, date);
        let mut counts = Counts::default();
        for o in events_of(&tape, &today, contract.tick) {
            if !contract.passes_floors(&o) {
                continue;
            }
            if o.size >= Qty::from(MANUAL_REFERENCE) {
                counts.manual += 1;
            }
            let Some(tier) = model.tier(o.size) else {
                continue;
            };
            counts.tier(tier);
            if open_hour.as_ref().is_some_and(|h| h.contains(&o.t.0)) {
                counts.open_hour += 1;
            }
            let reach = model.reach_at(o.t);
            let outcome =
                OutcomeWatch::new(&o, contract.tick, reach).and_then(|w| outcome_of(&tape, &o, &w));
            counts.outcome(outcome);
            if a.events {
                let line = json!({
                    "kind": "event",
                    "date": date.to_string(),
                    "t": o.t,
                    "lastT": o.last_t,
                    "side": o.aggressor,
                    "size": o.size,
                    "price": Price(o.average_price().0.round_dp(8).normalize()),
                    "low": o.low,
                    "high": o.high,
                    "prints": o.prints,
                    "tier": tier,
                    "reachTicks": reach,
                    "outcome": outcome,
                });
                println!("{line}");
            }
        }
        let line = json!({
            "kind": "day",
            "date": date.to_string(),
            "whole": today.whole,
            "sessions": prior.iter().map(|d| d.date.to_string()).collect::<Vec<_>>(),
            "modelMinutes": model.minutes,
            "modelEvents": model.orders(),
            "cuts": model.cuts,
            "shown": counts.high + counts.medium + counts.low,
            "tiers": { "high": counts.high, "medium": counts.medium, "low": counts.low },
            "outcomes": {
                "absorbed": counts.absorbed,
                "pushed": counts.pushed,
                "neither": counts.neither,
                "undecided": counts.undecided,
            },
            "openHour": counts.open_hour,
            "manual60": counts.manual,
            "reachTicks": model.reach_ticks,
        });
        println!("{line}");
    }
    Ok(())
}

fn main() {
    let result = args().and_then(|a| run(&a));
    if let Err(e) = result {
        eprintln!("{e}\n{USAGE}");
        std::process::exit(1);
    }
}
