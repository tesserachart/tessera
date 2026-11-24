use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Weak};

use chrono::NaiveDate;
use parking_lot::Mutex;
use tessera_core::instrument::{ContractSpec, Instrument};
use tessera_core::session::SessionCalendar;
use tessera_core::time::NANOS_PER_HOUR;
use tessera_core::{InstrumentId, Timestamp};
use tessera_store::ticks::{Span, TickKey, TickRow, TickStore};

use crate::provider::{MarketDataProvider, MarketError, TradesRequest};
use crate::router::MarketRouter;

pub const KEEP_SESSIONS: usize = 60;
pub const HISTORY_LAG: i64 = 48 * NANOS_PER_HOUR;
pub const ASK_TRIES: u32 = 4;
const ASK_AGAIN: tessera_core::backoff::Backoff = tessera_core::backoff::Backoff::new(
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(8),
);
pub const KEEP_SETTING: &str = "market.savedTradeSessions";
pub const MIN_KEEP: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Contract {
    pub source: String,
    pub instrument: InstrumentId,
}

impl Contract {
    pub fn new(source: &str, instrument: &InstrumentId) -> Self {
        Self {
            source: source.to_owned(),
            instrument: instrument.clone(),
        }
    }

    pub fn is_replay(&self) -> bool {
        self.source == crate::replay::SOURCE
    }

    pub fn key(&self) -> TickKey<'_> {
        TickKey {
            source: &self.source,
            instrument: self.instrument.as_str(),
        }
    }
}

enum Job {
    Save {
        contract: Contract,
        calendar: SessionCalendar,
        rows: Vec<TickRow>,
        span: Span,
    },
    Settle(mpsc::Sender<()>),
    #[cfg(any(test, feature = "test-support"))]
    Hold(mpsc::Receiver<()>),
}

#[cfg(any(test, feature = "test-support"))]
pub struct HeldWrites {
    _release: mpsc::Sender<()>,
}

pub struct SavedTrades {
    store: Arc<TickStore>,
    keep: AtomicUsize,
    pins: Mutex<HashMap<Contract, BTreeMap<NaiveDate, usize>>>,
    protected: Mutex<HashMap<String, HashMap<Contract, BTreeSet<NaiveDate>>>>,
    newest: Mutex<HashMap<Contract, NaiveDate>>,
    jobs: Mutex<mpsc::Sender<Job>>,
}

impl std::fmt::Debug for SavedTrades {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SavedTrades")
            .field("keep", &self.keep())
            .finish_non_exhaustive()
    }
}

impl SavedTrades {
    pub fn new(store: Arc<TickStore>) -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        let me = Arc::new(Self {
            store,
            keep: AtomicUsize::new(KEEP_SESSIONS),
            pins: Mutex::default(),
            protected: Mutex::default(),
            newest: Mutex::default(),
            jobs: Mutex::new(tx),
        });
        let weak = Arc::downgrade(&me);
        std::thread::Builder::new()
            .name("tessera-saved-trades".into())
            .spawn(move || write_jobs(&weak, &rx))
            .expect("the saved-trades writer thread starts");
        me
    }

    pub fn store(&self) -> &Arc<TickStore> {
        &self.store
    }

    pub fn keep(&self) -> usize {
        self.keep.load(Ordering::Relaxed)
    }

    pub fn set_keep(&self, sessions: usize) {
        self.keep.store(sessions.max(MIN_KEEP), Ordering::Relaxed);
    }

    pub fn save(
        &self,
        contract: Contract,
        calendar: SessionCalendar,
        rows: Vec<TickRow>,
        span: Span,
    ) {
        if span.is_empty() {
            return;
        }
        let _ = self.jobs.lock().send(Job::Save {
            contract,
            calendar,
            rows,
            span,
        });
    }

    pub fn save_now(
        &self,
        contract: &Contract,
        calendar: SessionCalendar,
        rows: &[TickRow],
        span: Span,
    ) -> tessera_store::Result<usize> {
        if contract.is_replay() {
            return Ok(0);
        }
        let mut kept = 0;
        for (date, part) in by_trade_date(calendar, span) {
            kept += self.store.write(contract.key(), date, rows, part)?;
            self.saw(contract, date);
        }
        Ok(kept)
    }

    pub fn save_answer(
        &self,
        contract: &Contract,
        calendar: SessionCalendar,
        rows: &[TickRow],
        span: Span,
        now: Timestamp,
    ) -> tessera_store::Result<usize> {
        if rows.is_empty() && span.end > now.0 - HISTORY_LAG {
            return Ok(0);
        }
        self.save_now(contract, calendar, rows, span)
    }

    pub fn settle(&self) {
        let (tx, rx) = mpsc::channel();
        if self.jobs.lock().send(Job::Settle(tx)).is_ok() {
            let _ = rx.recv();
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_writes(&self) -> HeldWrites {
        let (tx, rx) = mpsc::channel();
        let _ = self.jobs.lock().send(Job::Hold(rx));
        HeldWrites { _release: tx }
    }

    fn saw(&self, contract: &Contract, date: NaiveDate) {
        let newer = {
            let mut newest = self.newest.lock();
            let seen = newest.entry(contract.clone()).or_insert(date);
            let newer = *seen < date;
            *seen = (*seen).max(date);
            newer
        };
        if newer && let Err(e) = self.prune(contract) {
            tracing::warn!(instrument = %contract.instrument, error = %e, "old saved trades were not pruned");
        }
    }

    pub fn pin(self: &Arc<Self>, contract: &Contract, date: NaiveDate) -> DayPin {
        *self
            .pins
            .lock()
            .entry(contract.clone())
            .or_default()
            .entry(date)
            .or_default() += 1;
        DayPin {
            saved: Arc::downgrade(self),
            contract: contract.clone(),
            date,
        }
    }

    pub fn protect(&self, owner: &str, days: HashMap<Contract, BTreeSet<NaiveDate>>) {
        self.protected.lock().insert(owner.to_owned(), days);
    }

    pub fn unprotect(&self, owner: &str) {
        self.protected.lock().remove(owner);
    }

    pub fn protected(&self, contract: &Contract) -> BTreeSet<NaiveDate> {
        let mut out: BTreeSet<NaiveDate> = self
            .pins
            .lock()
            .get(contract)
            .map(|p| p.keys().copied().collect())
            .unwrap_or_default();
        for days in self.protected.lock().values() {
            if let Some(d) = days.get(contract) {
                out.extend(d.iter().copied());
            }
        }
        out
    }

    pub fn prune(&self, contract: &Contract) -> tessera_store::Result<Vec<NaiveDate>> {
        let gone = self
            .store
            .prune(contract.key(), self.keep(), &self.protected(contract))?;
        if !gone.is_empty() {
            tracing::info!(instrument = %contract.instrument, days = gone.len(), "old saved trades pruned");
        }
        Ok(gone)
    }

    pub fn prune_all(&self) -> tessera_store::Result<usize> {
        let mut n = 0;
        for c in self.store.contracts()? {
            let Ok(instrument) = InstrumentId::new(&c.instrument) else {
                continue;
            };
            n += self.prune(&Contract::new(&c.source, &instrument))?.len();
        }
        Ok(n)
    }

    pub fn remember_contract(&self, source: &str, instrument: &Instrument, spec: &ContractSpec) {
        let Ok(json) = serde_json::to_string(&(instrument, spec)) else {
            return;
        };
        let contract = Contract::new(source, &instrument.id);
        if contract.is_replay() {
            return;
        }
        if let Err(e) = self.store.set_contract(contract.key(), &json) {
            tracing::warn!(instrument = %instrument.id, error = %e, "a saved contract was not kept");
        }
    }

    pub fn contract(&self, contract: &Contract) -> Option<(Instrument, ContractSpec)> {
        let json = self.store.contract(contract.key()).ok().flatten()?;
        serde_json::from_str(&json).ok()
    }
}

fn write_jobs(saved: &Weak<SavedTrades>, rx: &mpsc::Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        match job {
            Job::Save {
                contract,
                calendar,
                rows,
                span,
            } => {
                let Some(saved) = saved.upgrade() else { return };
                if let Err(e) = saved.save_now(&contract, calendar, &rows, span) {
                    tracing::warn!(instrument = %contract.instrument, error = %e, "recorded trades were not saved");
                }
            }
            Job::Settle(done) => {
                let _ = done.send(());
            }
            #[cfg(any(test, feature = "test-support"))]
            Job::Hold(released) => {
                let _ = released.recv();
            }
        }
    }
}

pub struct DayPin {
    saved: Weak<SavedTrades>,
    contract: Contract,
    date: NaiveDate,
}

impl std::fmt::Debug for DayPin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DayPin")
            .field("instrument", &self.contract.instrument)
            .field("date", &self.date)
            .finish()
    }
}

impl Drop for DayPin {
    fn drop(&mut self) {
        let Some(saved) = self.saved.upgrade() else {
            return;
        };
        let mut pins = saved.pins.lock();
        if let Some(days) = pins.get_mut(&self.contract) {
            if let Some(n) = days.get_mut(&self.date) {
                *n -= 1;
                if *n == 0 {
                    days.remove(&self.date);
                }
            }
            if days.is_empty() {
                pins.remove(&self.contract);
            }
        }
    }
}

pub async fn ask(
    router: &MarketRouter,
    instrument: &InstrumentId,
    span: Span,
) -> Result<Vec<TickRow>, MarketError> {
    let conn = router.route(instrument)?;
    let (keeps, connection) = (conn.keeps_trade_history(), conn.id().to_owned());
    let mut tries = 1;
    loop {
        let req = TradesRequest {
            instrument: instrument.clone(),
            from: Some(Timestamp(span.start)),
            to: Some(Timestamp(span.end)),
            limit: None,
        };
        let flight = router.paces().begin(&connection);
        let answer = if keeps {
            router.get_trades(req).await
        } else {
            router.replay_trades(req).await
        };
        match &answer {
            Ok(trades) => flight.answered(trades.len()),
            Err(_) => drop(flight),
        }
        match answer {
            Ok(trades) => {
                let mut rows: Vec<TickRow> = trades
                    .iter()
                    .filter(|t| span.contains(t.ts.0))
                    .map(TickRow::of)
                    .collect();
                rows.sort_by_key(|r| r.t);
                return Ok(rows);
            }
            Err(MarketError::Unavailable(_)) if tries < ASK_TRIES => {
                tokio::time::sleep(ASK_AGAIN.delay(tries)).await;
                tries += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

pub fn by_trade_date(calendar: SessionCalendar, span: Span) -> Vec<(NaiveDate, Span)> {
    let mut out = Vec::new();
    let mut at = span.start;
    while at < span.end {
        let date = calendar.trade_date(Timestamp(at));
        let end = calendar.trade_date_end(date).0.clamp(at + 1, span.end);
        out.push((date, Span::new(at, end)));
        at = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::time::{NANOS_PER_HOUR, local_to_timestamp};

    fn date(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, d).unwrap()
    }

    #[test]
    fn a_span_over_the_globex_reopen_splits_at_six_in_the_evening() {
        let cal = SessionCalendar::CmeEquityIndex;
        let five_pm = local_to_timestamp(cal.tz(), date(20), 17, 0).0;
        let six_pm = local_to_timestamp(cal.tz(), date(20), 18, 0).0;
        let span = Span::new(five_pm - NANOS_PER_HOUR, six_pm + NANOS_PER_HOUR);
        assert_eq!(
            by_trade_date(cal, span),
            vec![
                (date(20), Span::new(span.start, six_pm)),
                (date(21), Span::new(six_pm, span.end)),
            ]
        );
        let friday = local_to_timestamp(cal.tz(), date(23), 16, 0).0;
        let sunday = local_to_timestamp(cal.tz(), date(25), 19, 0).0;
        let parts = by_trade_date(cal, Span::new(friday, sunday));
        assert_eq!(
            parts.iter().map(|p| p.0).collect::<Vec<_>>(),
            vec![date(23), date(26)],
            "the weekend belongs to Monday"
        );
    }

    #[test]
    fn a_pinned_or_protected_day_outlives_the_prune() {
        let saved = SavedTrades::new(Arc::new(TickStore::open_in_memory().unwrap()));
        saved.set_keep(2);
        let c = Contract::new("feed", &InstrumentId::new("NQZ6.CME").unwrap());
        for d in 12..=16 {
            let open = local_to_timestamp(SessionCalendar::CmeEquityIndex.tz(), date(d), 9, 30).0;
            saved
                .store()
                .write(c.key(), date(d), &[], Span::new(open, open + 1))
                .unwrap();
        }
        let pin = saved.pin(&c, date(12));
        saved.protect(
            "pull",
            HashMap::from([(c.clone(), BTreeSet::from([date(13)]))]),
        );
        assert_eq!(saved.prune(&c).unwrap(), vec![date(14)]);
        drop(pin);
        saved.unprotect("pull");
        assert_eq!(saved.prune(&c).unwrap(), vec![date(12), date(13)]);
        let left: Vec<_> = saved
            .store()
            .days(c.key())
            .unwrap()
            .iter()
            .map(|d| d.trade_date)
            .collect();
        assert_eq!(left, vec![date(15), date(16)]);
    }
}
