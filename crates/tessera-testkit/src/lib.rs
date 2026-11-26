pub mod crash;
pub mod firm;
pub mod levels;
pub mod line;
pub mod rithmic;

use std::sync::Arc;
use std::time::Duration;

use tessera_core::clock::ManualClock;
use tessera_core::{Clock, SharedClock, Timestamp};
use tessera_host::{ModuleContext, ModuleFactory, RuntimeModule};
use tessera_intel::IntelRouter;
use tessera_intel::mock::MockGamma;
use tessera_market::saved::{Contract, SavedTrades};
use tessera_market::{MarketRouter, MockConfig, MockMarket, TradesRequest};
use tessera_store::ticks::{Span, TickRow};
use tokio::task::JoinHandle;

pub use tessera_market::mock::{DEFAULT_SEED, FROZEN_AT, MOCK_PROVIDER_ID};

pub const BUSY_AT: &str = "2026-10-02T09:30:30-04:00";

pub fn frozen_clock() -> SharedClock {
    Arc::new(ManualClock::new(
        Timestamp::parse(FROZEN_AT).expect("FROZEN_AT is RFC 3339"),
    ))
}

#[derive(Debug, Clone, Copy)]
pub struct ShiftedClock {
    start: Timestamp,
    since: tokio::time::Instant,
}

impl ShiftedClock {
    pub fn starting_at(start: Timestamp) -> Self {
        Self {
            start,
            since: tokio::time::Instant::now(),
        }
    }
}

impl Clock for ShiftedClock {
    fn now(&self) -> Timestamp {
        let elapsed = tokio::time::Instant::now().duration_since(self.since);
        self.start
            .add_nanos(i64::try_from(elapsed.as_nanos()).unwrap_or(i64::MAX))
    }
}

#[derive(Clone, Debug)]
pub struct Fakes {
    pub seed: u64,
    pub intraday_sessions: usize,
    pub tick: Option<Duration>,
    pub gamma: bool,
    pub live_volume: f64,
    pub keeps_trade_history: bool,
    pub mock_connected: bool,
    pub refuses_replays: bool,
    pub stored: Vec<Span>,
    pub market_after: Option<Duration>,
    pub logs_in_after: Option<Duration>,
}

impl Default for Fakes {
    fn default() -> Self {
        Self {
            seed: DEFAULT_SEED,
            intraday_sessions: 20,
            tick: Some(Duration::from_millis(250)),
            gamma: true,
            live_volume: 1.0,
            keeps_trade_history: true,
            mock_connected: true,
            refuses_replays: false,
            stored: Vec::new(),
            market_after: None,
            logs_in_after: None,
        }
    }
}

impl Fakes {
    pub fn still(intraday_sessions: usize) -> Self {
        Self {
            intraday_sessions,
            tick: None,
            ..Self::default()
        }
    }

    pub fn busy() -> Self {
        Self {
            tick: Some(Duration::from_millis(20)),
            live_volume: 10.0,
            ..Self::default()
        }
    }

    pub fn module(self) -> ModuleFactory {
        Box::new(move |ctx: &ModuleContext| {
            let market = ctx
                .services
                .get::<MarketRouter>()
                .ok_or("the runtime offers no market router")?;
            let mut cfg = MockConfig::new(Arc::clone(&ctx.clock));
            cfg.seed = self.seed;
            cfg.intraday_sessions = self.intraday_sessions;
            cfg.live_volume = self.live_volume;
            cfg.keeps_trade_history = self.keeps_trade_history;
            cfg.refuses_replays = self.refuses_replays;
            if let Some(tick) = self.tick {
                cfg.tick_interval = tick;
            }
            let mock = MockMarket::new(cfg);
            if !self.stored.is_empty() {
                let saved = ctx
                    .services
                    .get::<SavedTrades>()
                    .ok_or("the runtime keeps no saved trades to store prints in")?;
                store_prints(&mock, &saved, &self.stored)?;
            }
            mock.set_logging_in(self.logs_in_after.is_some());
            if self.mock_connected && self.market_after.is_none() {
                market.add(Arc::new(mock.clone()))?;
            }
            if self.gamma {
                let intel = ctx
                    .services
                    .get::<IntelRouter>()
                    .ok_or("the runtime offers no intelligence router")?;
                intel.add(Arc::new(MockGamma::new(
                    mock.catalog().clone(),
                    ctx.clock.now(),
                )))?;
            }
            Ok(Arc::new(FakesModule {
                mock,
                ticks: self.tick.is_some(),
                late: self
                    .market_after
                    .filter(|_| self.mock_connected)
                    .map(|after| (after, market)),
                logs_in_after: self.logs_in_after,
            }) as Arc<dyn RuntimeModule>)
        })
    }
}

fn store_prints(
    mock: &MockMarket,
    saved: &SavedTrades,
    spans: &[Span],
) -> Result<(), tessera_host::ModuleError> {
    let catalog = mock.catalog();
    for product in catalog.products() {
        let Some(front) = catalog.front_contract(&product.root) else {
            continue;
        };
        let id = &front.instrument.id;
        let contract = Contract::new(MOCK_PROVIDER_ID, id);
        for span in spans {
            let req = TradesRequest {
                instrument: id.clone(),
                from: Some(Timestamp(span.start)),
                to: Some(Timestamp(span.end)),
                limit: Some(usize::MAX),
            };
            let Ok(prints) = mock.trades(&req) else {
                continue;
            };
            let rows: Vec<TickRow> = prints.iter().map(TickRow::of).collect();
            saved.save_now(&contract, front.spec.sessions, &rows, *span)?;
        }
    }
    Ok(())
}

struct FakesModule {
    mock: MockMarket,
    ticks: bool,
    late: Option<(Duration, Arc<MarketRouter>)>,
    logs_in_after: Option<Duration>,
}

impl RuntimeModule for FakesModule {
    fn name(&self) -> &'static str {
        "fakes"
    }

    fn start(&self, _host: &tessera_host::ModuleHost) -> Vec<JoinHandle<()>> {
        let mut tasks = vec![outage_switch(self.mock.clone())];
        if self.ticks {
            tasks.push(self.mock.start());
        }
        if let Some((after, market)) = self.late.clone() {
            let mock = self.mock.clone();
            tasks.push(tokio::spawn(async move {
                tokio::time::sleep(after).await;
                market
                    .add(Arc::new(mock))
                    .expect("no other market has the mock's id");
            }));
        }
        if let Some(after) = self.logs_in_after {
            let mock = self.mock.clone();
            tasks.push(tokio::spawn(async move {
                tokio::time::sleep(after).await;
                mock.set_logging_in(false);
            }));
        }
        tasks
    }
}

#[cfg(unix)]
fn outage_switch(mock: MockMarket) -> JoinHandle<()> {
    use tokio::signal::unix::{SignalKind, signal};
    tokio::spawn(async move {
        let (Ok(mut down), Ok(mut up)) = (
            signal(SignalKind::user_defined1()),
            signal(SignalKind::user_defined2()),
        ) else {
            return;
        };
        loop {
            tokio::select! {
                Some(()) = down.recv() => mock.set_outage(true),
                Some(()) = up.recv() => mock.set_outage(false),
                else => return,
            }
        }
    })
}

#[cfg(not(unix))]
fn outage_switch(_mock: MockMarket) -> JoinHandle<()> {
    tokio::spawn(async {})
}

#[cfg(test)]
mod tests {
    use tessera_core::Timeframe;
    use tessera_market::{BarsRequest, MarketDataProvider, MarketError};
    use tessera_store::ticks::TickStore;

    use super::*;

    const SATURDAY: &str = "2026-10-03T12:00:00-04:00";

    fn at(s: &str) -> Timestamp {
        Timestamp::parse(s).unwrap()
    }

    fn mock(now: &str, refuses_replays: bool) -> MockMarket {
        let mut cfg = MockConfig::new(Arc::new(ManualClock::new(at(now))));
        cfg.intraday_sessions = 5;
        cfg.keeps_trade_history = false;
        cfg.refuses_replays = refuses_replays;
        MockMarket::new(cfg)
    }

    fn nq(mock: &MockMarket) -> tessera_core::InstrumentId {
        let front = mock.catalog().front_contract("NQ").unwrap();
        front.instrument.id.clone()
    }

    #[tokio::test]
    async fn a_saturday_clock_serves_the_week_before() {
        let m = mock(SATURDAY, false);
        let bars = m
            .get_bars(BarsRequest::latest(nq(&m), Timeframe::M5, 2_000))
            .await
            .unwrap()
            .bars;
        let last = bars.last().unwrap().t;
        assert_eq!(last, at("2026-10-02T16:55:00-04:00"), "Friday's last bar");
        assert!(
            bars.first().unwrap().t < at("2026-09-28T00:00:00-04:00"),
            "the week before reaches back past Monday"
        );
    }

    #[tokio::test]
    async fn refused_replays_answer_as_rithmic_past_what_it_keeps() {
        let m = mock(SATURDAY, true);
        let asked = m
            .replay_trades(TradesRequest {
                instrument: nq(&m),
                from: Some(at("2026-10-01T10:00:00-04:00")),
                to: Some(at("2026-10-01T10:30:00-04:00")),
                limit: None,
            })
            .await;
        assert!(
            matches!(asked, Err(MarketError::Unsupported(_))),
            "{asked:?}"
        );
    }

    #[tokio::test]
    async fn stored_spans_hold_the_mocks_own_prints_once() {
        let m = mock(SATURDAY, false);
        let dir = tempfile::tempdir().unwrap();
        let saved = SavedTrades::new(Arc::new(TickStore::open_in_dir(dir.path()).unwrap()));
        let span = Span::new(
            at("2026-10-01T09:30:00-04:00").0,
            at("2026-10-01T11:00:00-04:00").0,
        );
        let id = nq(&m);
        let truth = m
            .replay_trades(TradesRequest {
                instrument: id.clone(),
                from: Some(Timestamp(span.start)),
                to: Some(Timestamp(span.end)),
                limit: Some(usize::MAX),
            })
            .await
            .unwrap();
        assert!(!truth.is_empty());
        let key = Contract::new(MOCK_PROVIDER_ID, &id);
        let stored = || saved.store().read(key.key(), span.start, span.end).unwrap();
        store_prints(&m, &saved, &[span]).unwrap();
        let once = stored();
        assert_eq!(once, truth.iter().map(TickRow::of).collect::<Vec<_>>());
        store_prints(&m, &saved, &[span]).unwrap();
        assert_eq!(stored(), once, "storing again keeps what is there");
        assert_eq!(
            saved
                .store()
                .missing(key.key(), span.start, span.end)
                .unwrap(),
            Vec::<Span>::new()
        );
    }
}
