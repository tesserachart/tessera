use std::sync::Arc;

use chrono::NaiveDate;
use tessera_core::instrument::{
    ContractMonth, ContractSpec, ExchangeContract, Instrument, prev_quarterly,
};
use tessera_core::market::Bar;
use tessera_core::session::SessionCalendar;
use tessera_core::time::local_to_timestamp;
use tessera_core::{InstrumentId, Timestamp};

use crate::history::Read;
use crate::io::ContractRun;
use crate::provider::{BarSeries, BarsRequest, MarketDataProvider, MarketError, exchange_contract};
use crate::router::MarketRouter;

pub const MAX_EARLIER_CONTRACTS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrontMonthBars {
    pub series: BarSeries,
    pub contracts: Option<Vec<ContractRun>>,
}

struct Earlier {
    instrument: InstrumentId,
    month: ContractMonth,
    roll: NaiveDate,
}

struct Piece {
    instrument: InstrumentId,
    bars: Vec<Bar>,
}

pub async fn front_month_bars(
    router: &MarketRouter,
    conn: &Arc<dyn MarketDataProvider>,
    req: BarsRequest,
    read: Read,
    today: NaiveDate,
) -> Result<FrontMonthBars, MarketError> {
    let plain = router.bars_from(conn, req.clone(), read).await?;
    let unchanged = |series: BarSeries| FrontMonthBars {
        series,
        contracts: None,
    };
    if !req.tf.is_session() {
        return Ok(unchanged(plain));
    }
    let (instrument, spec) = conn.spec(&req.instrument).await?;
    let Some(charted) = exchange_contract(&instrument).filter(|_| spec.roll_date.is_some()) else {
        return Ok(unchanged(plain));
    };
    let Some(month) = charted.expiry else {
        return Ok(unchanged(plain));
    };
    let cal = spec.sessions;
    let limit = req
        .limit
        .unwrap_or(crate::module::DEFAULT_BARS as usize)
        .max(1);
    let mut pieces: Vec<Piece> = Vec::new();
    let mut current = (req.instrument.clone(), month);
    let mut ends: Option<NaiveDate> = None;
    let mut have = 0;
    for step in 0..=MAX_EARLIER_CONTRACTS {
        let earlier = if step < MAX_EARLIER_CONTRACTS {
            earlier_contract(router, conn, &charted, current.1, today).await
        } else {
            None
        };
        let starts = earlier.as_ref().map(|e| e.roll);
        let to = match (req.to, ends) {
            (Some(t), Some(e)) => Some(t.min(Timestamp(day_start(cal, e) - 1))),
            (t, None) => t,
            (None, Some(e)) => Some(Timestamp(day_start(cal, e) - 1)),
        };
        let reaches_window = to.is_none_or(|t| starts.is_none_or(|s| t.0 >= day_start(cal, s)));
        let mut bars = if step == 0 {
            plain.bars.clone()
        } else if reaches_window {
            let asked = BarsRequest {
                instrument: current.0.clone(),
                to,
                limit: Some(limit - have),
                ..req.clone()
            };
            match router.bars_from(conn, asked, read).await {
                Ok(series) => series.bars,
                Err(_) => break,
            }
        } else {
            Vec::new()
        };
        bars.retain(|b| {
            let d = cal.trade_date(b.t);
            starts.is_none_or(|s| d >= s) && ends.is_none_or(|e| d < e)
        });
        have += bars.len();
        pieces.push(Piece {
            instrument: current.0.clone(),
            bars,
        });
        let Some(e) = earlier else { break };
        let starts_at = Timestamp(day_start(cal, e.roll));
        if have >= limit || req.from.is_some_and(|f| f >= starts_at) {
            break;
        }
        ends = Some(e.roll);
        current = (e.instrument, e.month);
    }
    if pieces.iter().skip(1).all(|p| p.bars.is_empty()) {
        return Ok(unchanged(plain));
    }
    pieces.reverse();
    let contracts = pieces
        .iter()
        .filter_map(|p| {
            Some(ContractRun {
                instrument: p.instrument.clone(),
                from: p.bars.first()?.t,
                to: p.bars.last()?.t,
            })
        })
        .collect();
    let charted_open = pieces.last().is_some_and(|p| !p.bars.is_empty());
    Ok(FrontMonthBars {
        series: BarSeries {
            last_bar_open: plain.last_bar_open && charted_open,
            bars: pieces.into_iter().flat_map(|p| p.bars).collect(),
            ..plain
        },
        contracts: Some(contracts),
    })
}

pub async fn fronts_since(
    router: &MarketRouter,
    conn: &Arc<dyn MarketDataProvider>,
    front: &Instrument,
    spec: &ContractSpec,
    from: NaiveDate,
    today: NaiveDate,
) -> Vec<FrontRun> {
    let only = |instrument: &InstrumentId| {
        vec![FrontRun {
            instrument: instrument.clone(),
            since: None,
        }]
    };
    let Some(charted) = exchange_contract(front).filter(|_| spec.roll_date.is_some()) else {
        return only(&front.id);
    };
    let Some(mut month) = charted.expiry else {
        return only(&front.id);
    };
    let mut out = Vec::new();
    let mut current = front.id.clone();
    for _ in 0..MAX_EARLIER_CONTRACTS {
        let Some(e) = earlier_contract(router, conn, &charted, month, today).await else {
            break;
        };
        out.push(FrontRun {
            instrument: std::mem::replace(&mut current, e.instrument),
            since: Some(e.roll),
        });
        if e.roll <= from {
            return out;
        }
        month = e.month;
    }
    out.push(FrontRun {
        instrument: current,
        since: None,
    });
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrontRun {
    pub instrument: InstrumentId,
    pub since: Option<NaiveDate>,
}

pub fn front_on(runs: &[FrontRun], date: NaiveDate) -> Option<&InstrumentId> {
    runs.iter()
        .find(|r| r.since.is_none_or(|s| date >= s))
        .map(|r| &r.instrument)
}

async fn earlier_contract(
    router: &MarketRouter,
    conn: &Arc<dyn MarketDataProvider>,
    charted: &ExchangeContract,
    month: ContractMonth,
    today: NaiveDate,
) -> Option<Earlier> {
    let (year, m) = prev_quarterly(month.year, month.month);
    let month = ContractMonth { year, month: m };
    let want = ExchangeContract::new(&charted.exchange, &charted.root, Some(month));
    let found = router.contract_on(conn.id(), &want).await.ok()??;
    let (_, spec) = conn.spec(&found.id).await.ok()?;
    let roll = spec.roll_date.filter(|r| *r <= today)?;
    Some(Earlier {
        instrument: found.id,
        month,
        roll,
    })
}

fn day_start(cal: SessionCalendar, date: NaiveDate) -> i64 {
    local_to_timestamp(cal.tz(), date, 0, 0).0
}
