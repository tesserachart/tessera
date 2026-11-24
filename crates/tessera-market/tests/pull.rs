use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Weak};

use async_trait::async_trait;
use chrono::NaiveDate;
use parking_lot::Mutex;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{
    AssetClass, ContractSpec, ExchangeContract, FuturesMonth, Instrument, cme_equity_index_expiry,
    cme_equity_index_roll_date,
};
use tessera_core::market::{Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::settle::settle;
use tessera_core::{InstrumentId, SharedClock, Timeframe, Timestamp};
use tessera_market::export::{CSV_HEADER, ExportTradesInput, export_trades, side};
use tessera_market::pull::{
    DayStatus, PullCurrent, PullProgress, PullRequest, PullState, PullSummary, Pulls, Scope,
    day_spans, plan,
};
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket, TradesRequest,
};
use tessera_store::ticks::{Span, TickStore};

const CAL: SessionCalendar = SessionCalendar::CmeEquityIndex;
const NQZ6: &str = "NQZ6.CME";

fn now() -> Timestamp {
    Timestamp::parse("2026-10-02T14:42:00-04:00").unwrap()
}

fn date(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

struct Counting {
    inner: MockMarket,
    asked: Mutex<Vec<(InstrumentId, Span)>>,
    failing: Mutex<BTreeSet<NaiveDate>>,
    unsent: Mutex<BTreeSet<NaiveDate>>,
    blocked: Mutex<Option<String>>,
    hold_after: Mutex<Option<usize>>,
}

impl Counting {
    fn asked(&self) -> Vec<Span> {
        self.asked.lock().iter().map(|(_, s)| *s).collect()
    }

    fn asked_on(&self, d: NaiveDate) -> Vec<Span> {
        self.asked()
            .into_iter()
            .filter(|s| CAL.trade_date(Timestamp(s.start)) == d)
            .collect()
    }
}

#[async_trait]
impl MarketDataProvider for Counting {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn capabilities(&self) -> MarketCapabilities {
        MarketCapabilities {
            max_intraday_history_days: None,
            ..self.inner.capabilities()
        }
    }
    fn health(&self) -> ProviderHealth {
        self.inner.health()
    }
    fn history_blocked(&self) -> Option<String> {
        self.blocked.lock().clone()
    }
    async fn search(
        &self,
        query: &str,
        asset_class: Option<AssetClass>,
        limit: usize,
    ) -> Result<Vec<Instrument>, MarketError> {
        self.inner.search(query, asset_class, limit).await
    }
    async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
        self.inner.resolve(input).await
    }
    async fn spec(&self, id: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.inner.spec(id).await
    }
    async fn contract_for(
        &self,
        want: &ExchangeContract,
    ) -> Result<Option<Instrument>, MarketError> {
        self.inner.contract_for(want).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        self.inner.get_bars(req).await
    }
    async fn quote(&self, id: &InstrumentId) -> Result<Quote, MarketError> {
        self.inner.quote(id).await
    }
    fn subscribe_quotes(&self, ids: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.inner.subscribe_quotes(ids)
    }
    fn subscribe_trades(&self, ids: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.inner.subscribe_trades(ids)
    }
    fn subscribe_bars(
        &self,
        id: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.inner.subscribe_bars(id, tf)
    }
    fn keeps_trade_history(&self) -> bool {
        true
    }
    async fn get_trades(&self, req: TradesRequest) -> Result<Vec<Trade>, MarketError> {
        let span = Span::new(req.from.unwrap().0, req.to.unwrap().0);
        let n = {
            let mut asked = self.asked.lock();
            asked.push((req.instrument.clone(), span));
            asked.len()
        };
        if self.hold_after.lock().is_some_and(|h| n > h) {
            std::future::pending::<()>().await;
        }
        if self
            .failing
            .lock()
            .contains(&CAL.trade_date(Timestamp(span.start)))
        {
            return Err(MarketError::InvalidRequest("the feed refused".into()));
        }
        if self
            .unsent
            .lock()
            .contains(&CAL.trade_date(Timestamp(span.start)))
        {
            return Ok(Vec::new());
        }
        self.inner.get_trades(req).await
    }
}

struct Rig {
    feed: Arc<Counting>,
    router: Arc<MarketRouter>,
    manual: Arc<ManualClock>,
    clock: SharedClock,
    saved: Arc<SavedTrades>,
}

impl Rig {
    fn new(store: TickStore) -> Self {
        let rig = Self::unconnected(store);
        rig.connect();
        rig
    }

    fn unconnected(store: TickStore) -> Self {
        let manual = Arc::new(ManualClock::new(now()));
        let clock: SharedClock = manual.clone();
        let feed = Arc::new(Counting {
            inner: MockMarket::new(MockConfig::new(Arc::clone(&clock))),
            asked: Mutex::default(),
            failing: Mutex::default(),
            unsent: Mutex::default(),
            blocked: Mutex::default(),
            hold_after: Mutex::default(),
        });
        Self {
            feed,
            router: MarketRouter::new(),
            manual,
            clock,
            saved: SavedTrades::new(Arc::new(store)),
        }
    }

    fn connect(&self) {
        self.router
            .add(Arc::clone(&self.feed) as Arc<dyn MarketDataProvider>)
            .unwrap();
    }

    fn memory() -> Self {
        Self::new(TickStore::open_in_memory().unwrap())
    }

    async fn pulls(&self) -> Arc<Pulls> {
        Pulls::open(
            Arc::clone(&self.saved),
            Arc::clone(&self.router),
            Arc::clone(&self.clock),
        )
        .await
        .unwrap()
    }
}

fn rth(instrument: &str, from: NaiveDate, to: NaiveDate) -> PullRequest {
    PullRequest {
        instrument: instrument.into(),
        from,
        to,
        scope: Scope::Rth,
    }
}

fn rth_pieces(d: NaiveDate) -> usize {
    let s = day_spans(CAL, d, Scope::Rth);
    ((s[0].end - s[0].start) / tessera_market::pull::PULL_CHUNK) as usize
}

fn nqz6() -> Contract {
    Contract::new("mock", &InstrumentId::new(NQZ6).unwrap())
}

type Standing = (String, PullState, PullProgress, Option<PullCurrent>);

fn standing(pulls: &Pulls) -> Vec<Standing> {
    pulls
        .list()
        .into_iter()
        .map(|s| (s.id, s.state, s.progress, s.current))
        .collect()
}

async fn settled(pulls: &Pulls) {
    settle(
        "the pulls",
        || standing(pulls),
        |all| {
            all.iter()
                .all(|(_, state, ..)| *state != PullState::Running)
        },
    )
    .await;
}

async fn asked_past(feed: &Counting, held: usize) {
    settle(
        "the pieces before the hold",
        || feed.asked().len(),
        |n| *n > held,
    )
    .await;
}

async fn let_go(store: &Weak<TickStore>) {
    settle(
        "the first run letting go of its store",
        || store.strong_count(),
        |n| *n == 0,
    )
    .await;
}

async fn held_up(pulls: &Pulls, id: &str) -> PullSummary {
    settle(
        "the pull showing what it waits for",
        || pulls.summary(id).unwrap(),
        |s| s.current.as_ref().is_some_and(|c| c.waiting_for.is_some()),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_range_pull_fetches_each_missing_day_once_and_skips_days_on_disk() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    pulls
        .start(rth(NQZ6, date(9, 23), date(9, 23)))
        .await
        .unwrap();
    settled(&pulls).await;
    let first = rig.feed.asked().len();
    assert_eq!(first, rth_pieces(date(9, 23)));

    let pull = pulls
        .start(rth(NQZ6, date(9, 21), date(9, 25)))
        .await
        .unwrap();
    assert_eq!(pull.days.len(), 5);
    settled(&pulls).await;
    for d in [21, 22, 24, 25] {
        let asked = rig.feed.asked_on(date(9, d));
        let distinct: BTreeSet<(i64, i64)> = asked.iter().map(|s| (s.start, s.end)).collect();
        assert_eq!(
            asked.len(),
            rth_pieces(date(9, d)),
            "9/{d} asked piece by piece"
        );
        assert_eq!(distinct.len(), asked.len(), "9/{d}: no piece asked twice");
    }
    assert_eq!(
        rig.feed.asked_on(date(9, 23)).len(),
        first,
        "the day already on disk asks nothing"
    );
    let summary = pulls.summary(&pull.id).unwrap();
    assert_eq!(summary.state, PullState::Done);
    let statuses: BTreeMap<NaiveDate, DayStatus> = summary
        .days
        .iter()
        .map(|d| (d.date, d.status.clone()))
        .collect();
    assert_eq!(statuses[&date(9, 23)], DayStatus::AlreadySaved);
    assert!(matches!(statuses[&date(9, 21)], DayStatus::Saved { prints } if prints > 0));
    assert_eq!(summary.progress.saved, 4);
    assert_eq!(summary.progress.already_saved, 1);

    let before = rig.feed.asked().len();
    pulls
        .start(rth(NQZ6, date(9, 21), date(9, 25)))
        .await
        .unwrap();
    settled(&pulls).await;
    assert_eq!(
        rig.feed.asked().len(),
        before,
        "a pull whose days are all saved asks nothing"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reader_woken_only_by_changes_sees_the_pull_done() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    let mut changes = pulls.changes();
    let pull = pulls
        .start(rth(NQZ6, date(9, 22), date(9, 25)))
        .await
        .unwrap();
    let reader = {
        let pulls = Arc::clone(&pulls);
        let id = pull.id.clone();
        tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                if pulls.summary(&id).is_ok_and(|s| s.state == PullState::Done) {
                    return true;
                }
            }
            false
        })
    };
    settle(
        "a change announcing the pull done",
        || (reader.is_finished(), standing(&pulls)),
        |(finished, _)| *finished,
    )
    .await;
    assert!(reader.await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_partial_day_asks_only_its_missing_span() {
    let rig = Rig::memory();
    let rth = day_spans(CAL, date(9, 24), Scope::Rth)[0];
    let noon = rth.start + 150 * 60 * 1_000_000_000;
    let morning = rig
        .feed
        .inner
        .get_trades(TradesRequest {
            instrument: InstrumentId::new(NQZ6).unwrap(),
            from: Some(Timestamp(rth.start)),
            to: Some(Timestamp(noon)),
            limit: None,
        })
        .await
        .unwrap();
    let rows: Vec<_> = morning
        .iter()
        .map(tessera_store::ticks::TickRow::of)
        .collect();
    rig.saved
        .save_now(&nqz6(), CAL, &rows, Span::new(rth.start, noon))
        .unwrap();
    let pulls = rig.pulls().await;
    pulls
        .start(self::rth(NQZ6, date(9, 24), date(9, 24)))
        .await
        .unwrap();
    settled(&pulls).await;
    let asked = rig.feed.asked();
    assert!(!asked.is_empty());
    assert!(
        asked.iter().all(|s| s.start >= noon && s.end <= rth.end),
        "only the afternoon is asked: {asked:?}"
    );
    assert_eq!(
        asked.iter().map(|s| s.end - s.start).sum::<i64>(),
        rth.end - noon
    );
    assert!(
        rig.saved
            .store()
            .missing(nqz6().key(), rth.start, rth.end)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pull_stopped_midway_resumes_and_asks_nothing_it_saved() {
    let dir = tempfile::tempdir().unwrap();
    let req = rth(NQZ6, date(9, 22), date(9, 24));
    let all: usize = [22, 23, 24].iter().map(|d| rth_pieces(date(9, *d))).sum();
    let held = 17;
    let (answered, first_store) = {
        let rig = Rig::new(TickStore::open_in_dir(dir.path()).unwrap());
        *rig.feed.hold_after.lock() = Some(held);
        let pulls = rig.pulls().await;
        pulls.start(req.clone()).await.unwrap();
        asked_past(&rig.feed, held).await;
        let answered: BTreeSet<(i64, i64)> = rig.feed.asked()[..held]
            .iter()
            .map(|s| (s.start, s.end))
            .collect();
        drop(pulls);
        (answered, Arc::downgrade(rig.saved.store()))
    };
    let_go(&first_store).await;

    let rig = Rig::new(TickStore::open_in_dir(dir.path()).unwrap());
    let pulls = rig.pulls().await;
    let resumed = pulls.list();
    assert_eq!(
        resumed.len(),
        1,
        "the pull is still there after the restart"
    );
    assert_eq!(resumed[0].state, PullState::Running);
    settled(&pulls).await;
    let again: Vec<(i64, i64)> = rig.feed.asked().iter().map(|s| (s.start, s.end)).collect();
    assert!(
        again.iter().all(|s| !answered.contains(s)),
        "nothing saved before the restart is asked again"
    );
    assert_eq!(again.len(), all - held);
    let done = pulls.summary(&resumed[0].id).unwrap();
    assert_eq!(done.state, PullState::Done);
    assert_eq!(done.progress.saved, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pull_resumed_at_start_waits_for_its_connection_and_fails_no_day() {
    let dir = tempfile::tempdir().unwrap();
    let req = PullRequest {
        scope: Scope::Session,
        ..rth(NQZ6, date(9, 22), date(9, 24))
    };
    let held = 30;
    let (answered, first_store) = {
        let rig = Rig::new(TickStore::open_in_dir(dir.path()).unwrap());
        *rig.feed.hold_after.lock() = Some(held);
        let pulls = rig.pulls().await;
        pulls.start(req.clone()).await.unwrap();
        asked_past(&rig.feed, held).await;
        let answered: BTreeSet<(i64, i64)> = rig.feed.asked()[..held]
            .iter()
            .map(|s| (s.start, s.end))
            .collect();
        drop(pulls);
        (answered, Arc::downgrade(rig.saved.store()))
    };
    let_go(&first_store).await;

    let rig = Rig::unconnected(TickStore::open_in_dir(dir.path()).unwrap());
    let pulls = rig.pulls().await;
    let id = pulls.list()[0].id.clone();
    let waiting = held_up(&pulls, &id).await;
    assert_eq!(
        waiting.state,
        PullState::Running,
        "it waits, it does not end"
    );
    assert_eq!(
        waiting.progress.failed, 0,
        "no day fails before its connection is there"
    );
    assert_eq!(
        waiting
            .current
            .as_ref()
            .and_then(|c| c.waiting_for.as_deref()),
        Some("mock"),
        "it says which connection it waits for"
    );

    rig.connect();
    settled(&pulls).await;
    let done = pulls.summary(&id).unwrap();
    assert_eq!(done.state, PullState::Done);
    assert_eq!(done.progress.failed, 0);
    assert_eq!(done.progress.saved, 3);
    let again: Vec<(i64, i64)> = rig.feed.asked().iter().map(|s| (s.start, s.end)).collect();
    assert!(!again.is_empty());
    assert!(
        again.iter().all(|s| !answered.contains(s)),
        "nothing saved before the restart is asked again"
    );
    for d in [22, 23, 24] {
        let spans = day_spans(CAL, date(9, d), Scope::Session);
        for span in spans {
            assert!(
                rig.saved
                    .store()
                    .missing(nqz6().key(), span.start, span.end)
                    .unwrap()
                    .is_empty(),
                "9/{d} is whole on disk"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn closed_days_are_not_planned_and_a_failing_day_is_retried_once_per_resume() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    rig.feed.failing.lock().insert(date(9, 8));
    let pull = pulls
        .start(rth(NQZ6, date(9, 4), date(9, 9)))
        .await
        .unwrap();
    assert_eq!(
        pull.days.iter().map(|d| d.date).collect::<Vec<_>>(),
        vec![date(9, 4), date(9, 8), date(9, 9)],
        "the weekend and Labor Day are not in the plan"
    );
    settled(&pulls).await;
    pulls
        .start(rth(NQZ6, date(9, 10), date(9, 10)))
        .await
        .unwrap();
    settled(&pulls).await;
    assert_eq!(
        rig.feed.asked_on(date(9, 8)).len(),
        1,
        "a failed day is not retried in a loop"
    );
    let failed = pulls.summary(&pull.id).unwrap();
    assert_eq!(failed.state, PullState::Done);
    assert!(matches!(
        &failed.days[1].status,
        DayStatus::Failed { tries: 1, .. }
    ));

    pulls.resume(&pull.id).await.unwrap();
    settled(&pulls).await;
    assert_eq!(
        rig.feed.asked_on(date(9, 8)).len(),
        2,
        "the resume retries it once"
    );
    assert!(matches!(
        &pulls.summary(&pull.id).unwrap().days[1].status,
        DayStatus::Failed { tries: 2, .. }
    ));

    rig.feed.failing.lock().clear();
    let before = rig.feed.asked().len();
    pulls.resume(&pull.id).await.unwrap();
    settled(&pulls).await;
    let done = pulls.summary(&pull.id).unwrap();
    assert!(matches!(done.days[1].status, DayStatus::Saved { .. }));
    assert_eq!(
        rig.feed.asked().len() - before,
        rth_pieces(date(9, 8)),
        "only the failed day is asked on resume"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resumed_pull_counts_its_pace_from_the_resume_not_from_its_first_run() {
    const IDLE: std::time::Duration = std::time::Duration::from_secs(24);
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    rig.feed.failing.lock().insert(date(9, 8));
    let pull = pulls
        .start(rth(NQZ6, date(9, 4), date(9, 9)))
        .await
        .unwrap();
    settled(&pulls).await;
    tokio::time::sleep(IDLE).await;

    rig.feed.failing.lock().clear();
    *rig.feed.hold_after.lock() = Some(rig.feed.asked().len() + 2);
    pulls.resume(&pull.id).await.unwrap();
    let running = settle(
        "the resumed day is part way",
        || pulls.summary(&pull.id).unwrap(),
        |s| s.current.as_ref().is_some_and(|c| c.pieces_done >= 2),
    )
    .await;
    assert_eq!(running.state, PullState::Running);
    let eta = running.eta_seconds.expect("a pace once pieces come in");
    assert!(
        eta < IDLE.as_secs() / 4,
        "the days already done and the idle time since are not counted: {running:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pulls_days_survive_the_prune_until_it_is_released() {
    let rig = Rig::memory();
    rig.saved.set_keep(2);
    let pulls = rig.pulls().await;
    let pull = pulls
        .start(rth(NQZ6, date(9, 21), date(9, 24)))
        .await
        .unwrap();
    settled(&pulls).await;
    let days = |s: &SavedTrades| -> Vec<NaiveDate> {
        s.store()
            .days(nqz6().key())
            .unwrap()
            .iter()
            .map(|d| d.trade_date)
            .collect()
    };
    rig.saved.prune_all().unwrap();
    assert_eq!(
        days(&rig.saved).len(),
        4,
        "a pull's days are kept past the limit"
    );
    pulls.release(&pull.id).await.unwrap();
    assert!(pulls.list().is_empty());
    rig.saved.prune_all().unwrap();
    assert_eq!(days(&rig.saved), vec![date(9, 23), date(9, 24)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_root_pull_takes_each_day_from_that_days_front_month() {
    let rig = Rig::memory();
    let roll = cme_equity_index_roll_date(cme_equity_index_expiry(2026, FuturesMonth::U));
    let planned = plan(
        &rig.router,
        &rig.saved,
        &rth(
            "NQ",
            roll - chrono::Duration::days(6),
            roll + chrono::Duration::days(6),
        ),
        now(),
    )
    .await
    .unwrap();
    assert!(!planned.days.is_empty());
    for d in &planned.days {
        let want = if d.date < roll { "NQU6.CME" } else { NQZ6 };
        assert_eq!(d.contract.as_str(), want, "{}", d.date);
    }
    assert!(planned.days.iter().any(|d| d.date < roll));
    assert!(rig.feed.asked().is_empty(), "planning asks no prints");
}

fn read_csv(path: &Path) -> Vec<(i64, String, String, i8)> {
    let text = std::fs::read_to_string(path).unwrap();
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some(CSV_HEADER));
    lines
        .map(|l| {
            let f: Vec<&str> = l.split(',').collect();
            (
                f[0].parse().unwrap(),
                f[1].into(),
                f[2].into(),
                f[3].parse().unwrap(),
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_export_round_trips_and_asks_the_connection_nothing() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    pulls
        .start(rth("NQ", date(9, 24), date(9, 25)))
        .await
        .unwrap();
    settled(&pulls).await;
    let asked = rig.feed.asked().len();
    let out = tempfile::tempdir().unwrap();
    let done = export_trades(
        rig.saved.store(),
        &ExportTradesInput {
            instrument: "NQ".into(),
            from: date(9, 21),
            to: date(9, 25),
            scope: Scope::Rth,
            dir: out.path().display().to_string(),
            source: None,
        },
    )
    .unwrap();
    assert_eq!(rig.feed.asked().len(), asked, "the export asks nothing");
    assert_eq!(done.missing, vec![date(9, 21), date(9, 22), date(9, 23)]);
    assert_eq!(done.files.len(), 2);
    for f in &done.files {
        assert!(f.complete);
        assert!(f.path.ends_with(&format!("NQ-{}.csv", f.date)));
        let rth = day_spans(CAL, f.date, Scope::Rth)[0];
        let saved: Vec<(i64, String, String, i8)> = rig
            .saved
            .store()
            .read(nqz6().key(), rth.start, rth.end)
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r.t,
                    r.price.0.normalize().to_string(),
                    r.size.0.normalize().to_string(),
                    side(r.aggressor),
                )
            })
            .collect();
        let back = read_csv(Path::new(&f.path));
        assert_eq!(back.len() as u64, f.prints);
        assert!(!back.is_empty());
        assert_eq!(back, saved, "{} reads back as saved", f.date);
        assert!(
            back.windows(2).all(|w| w[0].0 <= w[1].0),
            "rows in time order"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_range_again_adds_the_days_that_have_ended_since() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    let req = rth(NQZ6, date(9, 28), date(10, 9));
    let first = pulls.start(req.clone()).await.unwrap();
    assert_eq!(
        first.days.last().unwrap().date,
        date(10, 1),
        "today's hours have not ended: it is not planned"
    );
    settled(&pulls).await;
    let asked = rig.feed.asked().len();
    rig.manual.advance(4 * 86_400 * 1_000_000_000);
    let again = pulls.start(req).await.unwrap();
    assert_eq!(again.id, first.id);
    assert_eq!(
        again.days.iter().map(|d| d.date).collect::<Vec<_>>(),
        vec![
            date(9, 28),
            date(9, 29),
            date(9, 30),
            date(10, 1),
            date(10, 2),
            date(10, 5)
        ]
    );
    assert!(
        matches!(again.days[0].status, DayStatus::Saved { .. }),
        "what was done stays done"
    );
    settled(&pulls).await;
    assert!(
        rig.feed.asked()[asked..]
            .iter()
            .all(|s| CAL.trade_date(Timestamp(s.start)) >= date(10, 2)),
        "only the days added are asked"
    );
}

const MINUTE: i64 = 60 * 1_000_000_000;

fn whole(rig: &Rig, d: NaiveDate, scope: Scope) -> bool {
    day_spans(CAL, d, scope).into_iter().all(|span| {
        rig.saved
            .store()
            .missing(nqz6().key(), span.start, span.end)
            .unwrap()
            .is_empty()
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_day_the_feed_has_not_sent_all_of_is_asked_again_on_its_own() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    rig.feed.unsent.lock().insert(date(10, 1));
    let pull = pulls
        .start(rth(NQZ6, date(9, 30), date(10, 1)))
        .await
        .unwrap();
    settled(&pulls).await;
    let first = pulls.summary(&pull.id).unwrap();
    assert!(matches!(first.days[0].status, DayStatus::Saved { .. }));
    assert!(
        matches!(first.days[1].status, DayStatus::Later { tries: 1, .. }),
        "an empty answer of a recent day is not taken as a day without trades: {:?}",
        first.days[1].status
    );
    assert_eq!(first.progress.later, 1);
    assert!(!whole(&rig, date(10, 1), Scope::Rth));

    let asked = rig.feed.asked_on(date(10, 1)).len();
    pulls.retry_due().await;
    settled(&pulls).await;
    assert_eq!(
        rig.feed.asked_on(date(10, 1)).len(),
        asked,
        "not asked again before its time"
    );

    rig.feed.unsent.lock().clear();
    rig.manual.advance(2 * MINUTE);
    pulls.retry_due().await;
    settled(&pulls).await;
    let done = pulls.summary(&pull.id).unwrap();
    assert!(
        matches!(done.days[1].status, DayStatus::Saved { .. }),
        "{:?}",
        done.days[1].status
    );
    assert!(whole(&rig, date(10, 1), Scope::Rth));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_day_is_asked_again_on_its_own_only_while_auto_download_is_on() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    pulls.set_auto(false);
    rig.feed.failing.lock().insert(date(9, 8));
    let pull = pulls
        .start(rth(NQZ6, date(9, 4), date(9, 9)))
        .await
        .unwrap();
    settled(&pulls).await;
    rig.manual.advance(10 * MINUTE);
    pulls.retry_due().await;
    settled(&pulls).await;
    assert_eq!(
        rig.feed.asked_on(date(9, 8)).len(),
        1,
        "off: it waits for the user"
    );

    pulls.set_auto(true);
    pulls.retry_due().await;
    settled(&pulls).await;
    assert_eq!(
        rig.feed.asked_on(date(9, 8)).len(),
        2,
        "on: it is asked again"
    );
    assert!(matches!(
        pulls.summary(&pull.id).unwrap().days[1].status,
        DayStatus::Failed { tries: 2, .. }
    ));

    rig.feed.failing.lock().clear();
    rig.manual.advance(MINUTE);
    pulls.retry_due().await;
    settled(&pulls).await;
    assert_eq!(
        rig.feed.asked_on(date(9, 8)).len(),
        2,
        "each try waits longer than the one before"
    );
    rig.manual.advance(MINUTE);
    pulls.retry_due().await;
    settled(&pulls).await;
    assert!(matches!(
        pulls.summary(&pull.id).unwrap().days[1].status,
        DayStatus::Saved { .. }
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_cannot_answer_holds_the_pull_with_its_reason_and_fails_no_day() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    let why = "the connection was taken by another login";
    *rig.feed.blocked.lock() = Some(why.into());
    let pull = pulls
        .start(rth(NQZ6, date(9, 29), date(9, 30)))
        .await
        .unwrap();
    let held = held_up(&pulls, &pull.id).await;
    assert_eq!(held.state, PullState::Running);
    assert_eq!(held.progress.failed, 0);
    let current = held.current.expect("it says where it stands");
    assert_eq!(current.waiting_why.as_deref(), Some(why));
    assert_eq!(
        current.waiting_for.as_deref(),
        Some(rig.feed.display_name())
    );
    assert!(rig.feed.asked().is_empty(), "nothing is asked meanwhile");

    *rig.feed.blocked.lock() = None;
    settled(&pulls).await;
    let done = pulls.summary(&pull.id).unwrap();
    assert_eq!(done.progress.saved, 2);
    assert_eq!(done.progress.failed, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_days_fill_themselves_once_and_not_while_auto_download_is_off() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    let req = rth(NQZ6, date(9, 28), date(10, 1));
    pulls.set_auto(false);
    let days = pulls.coverage(&req).await.unwrap();
    assert!(pulls.fill(&req, &days).await.is_none());
    assert!(pulls.list().is_empty());

    pulls.set_auto(true);
    let started = pulls.fill(&req, &days).await.expect("it starts by itself");
    assert!(started.auto);
    settled(&pulls).await;
    let after = pulls.coverage(&req).await.unwrap();
    assert!(
        after
            .iter()
            .all(|d| d.prints == tessera_protocol::cards::Held::Saved)
    );
    assert!(
        pulls.fill(&req, &after).await.is_none(),
        "nothing left to fetch"
    );
    let asked = rig.feed.asked().len();
    assert!(
        pulls.fill(&req, &days).await.is_none(),
        "planned days are not planned twice"
    );
    assert_eq!(rig.feed.asked().len(), asked);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_day_whose_session_ends_joins_its_pull_on_its_own() {
    let rig = Rig::memory();
    let pulls = rig.pulls().await;
    let pull = pulls
        .start(rth(NQZ6, date(9, 30), date(10, 2)))
        .await
        .unwrap();
    settled(&pulls).await;
    assert_eq!(pull.days.last().unwrap().date, date(10, 1));
    rig.manual.advance(4 * 60 * MINUTE);
    pulls.retry_due().await;
    settled(&pulls).await;
    let grown = pulls.summary(&pull.id).unwrap();
    assert_eq!(grown.days.last().unwrap().date, date(10, 2));
    assert!(matches!(
        grown.days.last().unwrap().status,
        DayStatus::Saved { .. } | DayStatus::Later { .. }
    ));
}
