use std::sync::Arc;

use chrono::NaiveDate;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use tessera_store::ticks::{Span, TickKey};
use ts_rs::TS;

use crate::history::Read;
use crate::pace::Pace;
use crate::provider::BarsRequest;
use crate::pull::{
    DayStatus, PullDay, PullError, PullRequest, Scope, day_spans, market_of, plan_on, pull_id,
};
use crate::router::MarketRouter;
use crate::saved::{Contract, SavedTrades};

/// `market.estimate_pull` input: a range as `market.pull_trades` takes it, its dates optional.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct EstimatePullInput {
    /// A dated contract (`NQZ6`, `NQZ6.CME`) or a futures root (`NQ`). A root follows the roll:
    /// each day is the contract that was the front month that day.
    pub instrument: String,
    /// First trade date, `YYYY-MM-DD` (default: seven days before `to`, the last week).
    #[serde(default)]
    #[ts(optional, type = "string")]
    pub from: Option<NaiveDate>,
    /// Last trade date, `YYYY-MM-DD` (default: today on the market's own calendar; a day whose
    /// hours have not ended is left out).
    #[serde(default)]
    #[ts(optional, type = "string")]
    pub to: Option<NaiveDate>,
    /// `session` (default) for the whole session, `rth` for regular trading hours.
    #[serde(default)]
    pub scope: Option<Scope>,
}

/// What the prints still missing from a range would take on this machine, measured from the
/// prints of the same market already saved from the same connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SizeEstimate {
    /// Bytes the missing prints would take in the tick store, compressed as it keeps them.
    #[ts(type = "number")]
    pub bytes: u64,
    /// Prints expected.
    #[ts(type = "number")]
    pub prints: u64,
    /// Prints of this market already saved that the size is measured from.
    #[ts(type = "number")]
    pub measured_prints: u64,
}

/// `market.estimate_pull` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullEstimate {
    /// The pull this range is, its dates filled in: `market.pull_trades` with this request starts
    /// it, and estimating it again while it runs gives what is left.
    pub request: PullRequest,
    /// The pull's id, as `market.pull_trades` and `market.list_pulls` name it.
    pub id: String,
    /// The contract of the range's newest trading day (`NQZ6.CME`).
    pub contract: InstrumentId,
    /// Trading days in the range whose hours have ended.
    pub days: u32,
    /// Of them, days whose prints are all saved on this machine already.
    pub saved: u32,
    /// Of them, days older than the connection keeps history for; a pull asks nothing for them.
    pub out_of_reach: u32,
    /// What the missing prints would take. None while nothing of this market is saved from this
    /// connection to measure from, or when the connection gives no 1-minute volumes to scale by.
    pub size: Option<SizeEstimate>,
    /// Seconds the missing prints would take to download at the pace this connection's
    /// downloads have kept since the runtime started. None until one has answered, or while the
    /// size is not known.
    #[ts(type = "number | null")]
    pub seconds: Option<u64>,
}

pub const WEEK_DAYS: i64 = 7;

pub fn week_before(to: NaiveDate) -> NaiveDate {
    to - chrono::Duration::days(WEEK_DAYS)
}

pub const SAMPLE_PRINTS: u64 = 200_000;
pub const SAMPLE_DAYS: usize = 5;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub bytes: u64,
    pub prints: u64,
    pub volume: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Missing {
    Nothing,
    Volume(f64),
    Unknown,
}

pub fn size_of(sample: Option<Sample>, missing: Missing) -> Option<SizeEstimate> {
    let sample = sample.filter(|s| s.volume > 0.0)?;
    let scaled = |per_contract: u64, volume: f64| {
        (volume * per_contract as f64 / sample.volume).round() as u64
    };
    let (bytes, prints) = match missing {
        Missing::Nothing => (0, 0),
        Missing::Volume(v) if v > 0.0 => (scaled(sample.bytes, v), scaled(sample.prints, v)),
        Missing::Volume(_) | Missing::Unknown => return None,
    };
    Some(SizeEstimate {
        bytes,
        prints,
        measured_prints: sample.prints,
    })
}

pub fn seconds_of(missing: Missing, size: Option<&SizeEstimate>, pace: Pace) -> Option<u64> {
    if missing == Missing::Nothing {
        return Some(0);
    }
    let rate = pace.prints_per_second()?;
    size.map(|s| (s.prints as f64 / rate).round() as u64)
}

fn measured_sample(
    saved: &SavedTrades,
    source: &str,
    root: &str,
) -> tessera_store::Result<Option<Sample>> {
    let store = saved.store();
    let mut days = Vec::new();
    for c in store.contracts()? {
        if c.source != source {
            continue;
        }
        let Ok(instrument) = InstrumentId::new(&c.instrument) else {
            continue;
        };
        let contract = Contract::new(source, &instrument);
        let same_root = saved
            .contract(&contract)
            .and_then(|(i, _)| i.root)
            .is_some_and(|r| r.eq_ignore_ascii_case(root));
        if !same_root {
            continue;
        }
        for d in store.days(contract.key())? {
            days.push((d, contract.clone()));
        }
    }
    days.sort_by_key(|(d, _)| std::cmp::Reverse(d.trade_date));
    let mut sample = Sample::default();
    for (day, contract) in days.iter().take(SAMPLE_DAYS) {
        if sample.prints >= SAMPLE_PRINTS {
            break;
        }
        let key: TickKey<'_> = contract.key();
        for span in &day.covered {
            sample.volume += store
                .read(key, span.start, span.end)?
                .iter()
                .map(|r| r.size.to_f64())
                .sum::<f64>();
        }
        sample.bytes += day.bytes;
        sample.prints += day.prints;
    }
    Ok((sample.prints > 0).then_some(sample))
}

async fn missing_volume(router: &MarketRouter, missing: &[(PullDay, Vec<Span>)]) -> Missing {
    let Some(bars) = router.bar_cache() else {
        return Missing::Unknown;
    };
    let mut volume = 0.0;
    for (day, spans) in missing {
        let (Some(first), Some(last)) = (spans.first(), spans.last()) else {
            continue;
        };
        let Ok(conn) = router.route_async(&day.contract).await else {
            return Missing::Unknown;
        };
        let req = BarsRequest {
            instrument: day.contract.clone(),
            tf: Timeframe::M1,
            from: Some(Timestamp(first.start)),
            to: Some(Timestamp(last.end - 1)),
            limit: None,
            rth_only: false,
        };
        match bars.get_bars(&conn, req, Read::Through).await {
            Ok(series) => {
                volume += series
                    .bars
                    .iter()
                    .filter(|b| spans.iter().any(|s| s.contains(b.t.0)))
                    .map(|b| b.v.to_f64())
                    .sum::<f64>();
            }
            Err(e) => {
                tracing::debug!(instrument = %day.contract, error = %e, "minute volumes for an estimate were not read");
                return Missing::Unknown;
            }
        }
    }
    Missing::Volume(volume)
}

pub async fn estimate(
    router: &MarketRouter,
    saved: &Arc<SavedTrades>,
    now: Timestamp,
    input: EstimatePullInput,
) -> Result<PullEstimate, PullError> {
    let market = market_of(router, input.instrument.trim()).await?;
    let to = input
        .to
        .unwrap_or_else(|| market.calendar().trade_date(now));
    let request = PullRequest {
        instrument: input.instrument.trim().to_owned(),
        from: input.from.unwrap_or_else(|| week_before(to)),
        to,
        scope: input.scope.unwrap_or(Scope::Session),
    };
    let planned = plan_on(router, saved, &market, &request, now).await?;
    let newest = planned
        .days
        .last()
        .cloned()
        .ok_or_else(|| PullError::Invalid("the range has no trading day".into()))?;
    let (calendar, scope) = (planned.calendar, request.scope);
    let days = planned.days.clone();
    let store = Arc::clone(saved.store());
    let reading = tokio::task::spawn_blocking(move || {
        let mut out = (0u32, Vec::new());
        for day in days {
            if day.status == DayStatus::OutOfReach {
                continue;
            }
            let contract = Contract::new(&day.source, &day.contract);
            let mut missing = Vec::new();
            for w in day_spans(calendar, day.date, scope) {
                let holes = store
                    .missing(contract.key(), w.start, w.end)
                    .unwrap_or_else(|_| vec![w]);
                missing.extend(holes);
            }
            if missing.is_empty() {
                out.0 += 1;
            } else {
                out.1.push((day, missing));
            }
        }
        out
    })
    .await
    .map_err(|e| PullError::Invalid(e.to_string()))?;
    let (whole, missing) = reading;
    let out_of_reach = planned
        .days
        .iter()
        .filter(|d| d.status == DayStatus::OutOfReach)
        .count() as u32;
    let volume = if missing.is_empty() {
        Missing::Nothing
    } else {
        missing_volume(router, &missing).await
    };
    let root = saved
        .contract(&Contract::new(&newest.source, &newest.contract))
        .and_then(|(i, _)| i.root);
    let sample = match root {
        Some(root) => {
            let (keeper, source) = (Arc::clone(saved), newest.source.clone());
            tokio::task::spawn_blocking(move || measured_sample(&keeper, &source, &root))
                .await
                .map_err(|e| PullError::Invalid(e.to_string()))?
                .unwrap_or_else(|e| {
                    tracing::warn!(error = %e, "saved prints for an estimate were not read");
                    None
                })
        }
        None => None,
    };
    let size = size_of(sample, volume);
    let seconds = seconds_of(volume, size.as_ref(), router.paces().pace(&newest.source));
    Ok(PullEstimate {
        id: pull_id(&request),
        request,
        contract: newest.contract,
        days: planned.days.len() as u32,
        saved: whole,
        out_of_reach,
        size,
        seconds,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tessera_core::market::{Aggressor, AggressorSource};
    use tessera_core::money::{Price, Qty};
    use tessera_store::ticks::{TickRow, TickStore};

    use super::*;
    use crate::provider::MarketDataProvider;

    const SAMPLE: Sample = Sample {
        bytes: 1_000,
        prints: 400,
        volume: 100.0,
    };

    #[test]
    fn the_missing_volume_is_scaled_by_what_the_saved_prints_measured() {
        assert_eq!(
            size_of(Some(SAMPLE), Missing::Volume(250.0)),
            Some(SizeEstimate {
                bytes: 2_500,
                prints: 1_000,
                measured_prints: 400
            })
        );
    }

    #[test]
    fn nothing_missing_is_zero_bytes_when_it_can_be_measured() {
        assert_eq!(
            size_of(Some(SAMPLE), Missing::Nothing).map(|s| (s.bytes, s.prints)),
            Some((0, 0))
        );
        assert_eq!(size_of(None, Missing::Nothing), None);
    }

    #[test]
    fn what_cannot_be_measured_stays_unknown() {
        assert_eq!(size_of(None, Missing::Volume(10.0)), None);
        assert_eq!(size_of(Some(SAMPLE), Missing::Unknown), None);
        assert_eq!(size_of(Some(SAMPLE), Missing::Volume(0.0)), None);
        let no_volume = Sample {
            volume: 0.0,
            ..SAMPLE
        };
        assert_eq!(size_of(Some(no_volume), Missing::Volume(10.0)), None);
    }

    #[test]
    fn seconds_follow_the_pace_and_wait_for_one() {
        let size = size_of(Some(SAMPLE), Missing::Volume(250.0));
        let pace = Pace {
            prints: 500,
            busy: Duration::from_secs(1),
        };
        assert_eq!(
            seconds_of(Missing::Volume(250.0), size.as_ref(), pace),
            Some(2)
        );
        assert_eq!(
            seconds_of(Missing::Volume(250.0), size.as_ref(), Pace::default()),
            None
        );
        assert_eq!(seconds_of(Missing::Volume(250.0), None, pace), None);
        assert_eq!(seconds_of(Missing::Nothing, None, Pace::default()), Some(0));
    }

    fn row(t: i64, size: i64) -> TickRow {
        TickRow {
            t,
            price: Price::from(100),
            size: Qty::from(size),
            aggressor: Aggressor::Buy,
            aggressor_source: AggressorSource::Exchange,
            order_key: None,
        }
    }

    #[tokio::test]
    async fn the_sample_is_the_newest_saved_days_of_the_root_from_the_connection() {
        let saved = SavedTrades::new(Arc::new(TickStore::open_in_memory().unwrap()));
        let date = |d| NaiveDate::from_ymd_opt(2026, 10, d).unwrap();
        let mock = crate::MockMarket::new(crate::MockConfig::new(Arc::new(
            tessera_core::clock::ManualClock::new(
                Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap(),
            ),
        )));
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let es = InstrumentId::new("ESZ6.CME").unwrap();
        for id in [&nq, &es] {
            let (instrument, spec) = mock.spec(id).await.unwrap();
            saved.remember_contract("feed", &instrument, &spec);
        }
        let cal = tessera_core::session::SessionCalendar::CmeEquityIndex;
        let write = |c: &InstrumentId, source: &str, d: u32, sizes: &[i64]| {
            let spans = day_spans(cal, date(d), Scope::Session);
            let span = spans[0];
            let rows: Vec<TickRow> = sizes
                .iter()
                .enumerate()
                .map(|(n, s)| row(span.start + n as i64, *s))
                .collect();
            saved
                .store()
                .write(Contract::new(source, c).key(), date(d), &rows, span)
                .unwrap();
        };
        write(&nq, "feed", 1, &[1, 1, 1]);
        write(&nq, "feed", 2, &[2, 3]);
        write(&nq, "other", 2, &[500]);
        write(&es, "feed", 2, &[700]);
        let sample = measured_sample(&saved, "feed", "NQ").unwrap().unwrap();
        assert_eq!((sample.prints, sample.volume), (5, 8.0));
        assert!(sample.bytes > 0);
        assert!(measured_sample(&saved, "feed", "CL").unwrap().is_none());
        assert!(measured_sample(&saved, "nobody", "NQ").unwrap().is_none());
    }
}
