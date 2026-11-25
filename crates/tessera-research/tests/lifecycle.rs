use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde_json::json;
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::ManualClock;
use tessera_core::health::ProviderHealth;
use tessera_core::ids::SessionId;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Quote, Trade};
use tessera_core::{InstrumentId, Origin, Timeframe, Timestamp};
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket,
};
use tessera_research::Studies;
use tessera_research::evaluate::Verdict;
use tessera_research::experiment::ExperimentState;
use tessera_research::study::Study;
use tessera_store::Store;
use tokio::sync::Notify;

struct Gated {
    inner: MockMarket,
    held: AtomicBool,
    entered: Notify,
    open: Notify,
}

#[async_trait]
impl MarketDataProvider for Gated {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn capabilities(&self) -> MarketCapabilities {
        self.inner.capabilities()
    }
    fn health(&self) -> ProviderHealth {
        self.inner.health()
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
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.inner.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
        if self.held.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.open.notified().await;
        }
        self.inner.get_bars(req).await
    }
    async fn quote(&self, i: &InstrumentId) -> Result<Quote, MarketError> {
        self.inner.quote(i).await
    }
    fn subscribe_quotes(&self, i: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
        self.inner.subscribe_quotes(i)
    }
    fn subscribe_trades(&self, i: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
        self.inner.subscribe_trades(i)
    }
    fn subscribe_bars(
        &self,
        i: &InstrumentId,
        tf: Timeframe,
    ) -> Result<MarketStream<LiveBar>, MarketError> {
        self.inner.subscribe_bars(i, tf)
    }
}

struct H {
    store: Store,
    studies: Arc<Studies>,
    market: Arc<Gated>,
    clock: Arc<ManualClock>,
}

fn harness() -> H {
    let now = Timestamp::parse("2026-10-09T17:00:00-04:00").unwrap();
    let clock = Arc::new(ManualClock::new(now));
    let mut cfg = MockConfig::new(clock.clone());
    cfg.intraday_sessions = 10;
    let market = Arc::new(Gated {
        inner: MockMarket::new(cfg),
        held: AtomicBool::new(false),
        entered: Notify::new(),
        open: Notify::new(),
    });
    let router = MarketRouter::new();
    router
        .add(Arc::clone(&market) as Arc<dyn MarketDataProvider>)
        .unwrap();
    let store = Store::open_in_memory().unwrap();
    let studies = Arc::new(Studies::new(store.clone(), router, clock.clone()));
    H {
        store,
        studies,
        market,
        clock,
    }
}

fn draft(hypothesis: &str) -> Study {
    serde_json::from_value(json!({
        "id": "",
        "name": "EMA cross",
        "family": "",
        "hypothesis": hypothesis,
        "data": {"instrument": "NQ", "tf": "5m", "rthOnly": true},
        "strategy": {"kind": "rules", "rule": {"rule": "ema_cross", "fast": 9, "slow": 21, "sides": "both"}},
        "placeboRuns": 0,
        "state": "draft",
        "generation": 1,
        "manifestHash": null,
        "frozenAt": null,
    }))
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_made_while_a_study_runs_is_kept() {
    let h = harness();
    let saved = h.studies.save(draft("first")).await.unwrap();
    h.market.held.store(true, Ordering::SeqCst);
    let run = {
        let (studies, id) = (Arc::clone(&h.studies), saved.id.clone());
        tokio::spawn(async move { studies.run(&id, tessera_core::Origin::User).await })
    };
    h.market.entered.notified().await;
    let edited = Study {
        hypothesis: "second".into(),
        ..saved.clone()
    };
    h.studies.save(edited).await.unwrap();
    h.market.open.notify_one();
    run.await.unwrap().unwrap();

    let now = h.studies.get(&saved.id).unwrap();
    assert_eq!(now.hypothesis, "second");
    assert_eq!(
        now.last_verdict, None,
        "the verdict was for the first hypothesis"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_study_deleted_while_it_runs_stays_deleted() {
    let h = harness();
    let saved = h.studies.save(draft("first")).await.unwrap();
    h.market.held.store(true, Ordering::SeqCst);
    let run = {
        let (studies, id) = (Arc::clone(&h.studies), saved.id.clone());
        tokio::spawn(async move { studies.run(&id, tessera_core::Origin::User).await })
    };
    h.market.entered.notified().await;
    assert!(h.studies.delete(&saved.id).unwrap());
    h.market.open.notify_one();
    assert!(run.await.unwrap().is_err());

    assert!(h.studies.get(&saved.id).is_err());
    assert!(h.studies.list().unwrap().is_empty());
    assert!(h.studies.runs(&saved.id).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_records_its_verdict_on_the_study_it_ran() {
    let h = harness();
    let saved = h.studies.save(draft("first")).await.unwrap();
    let frozen = h.studies.freeze(&saved.id).unwrap();
    let run = h
        .studies
        .run(&saved.id, tessera_core::Origin::User)
        .await
        .unwrap();
    let now = h.studies.get(&saved.id).unwrap();
    assert_eq!(now.state, ExperimentState::Recorded);
    assert_eq!(now.last_verdict, Some(run.evaluation.verdict));
    assert_eq!(now.manifest_hash, frozen.manifest_hash);
}

#[tokio::test]
async fn a_save_over_a_study_that_cannot_be_read_is_refused() {
    let h = harness();
    let unreadable = json!({"id": "study-x", "name": "kept", "state": "nonsense"});
    h.store
        .documents("research.study")
        .put("study-x", None, &unreadable, Timestamp(1))
        .unwrap();
    let over = Study {
        id: "study-x".into(),
        ..draft("over")
    };
    assert!(h.studies.save(over).await.is_err());
    let row = h
        .store
        .documents("research.study")
        .get("study-x")
        .unwrap()
        .unwrap();
    assert_eq!(row.body, unreadable);
}

#[tokio::test]
async fn freezing_a_draft_drops_its_exploratory_verdict() {
    let h = harness();
    let saved = h.studies.save(draft("first")).await.unwrap();
    let mut body = serde_json::to_value(&saved).unwrap();
    body["lastVerdict"] = serde_json::to_value(Verdict::Qualified).unwrap();
    h.store
        .documents("research.study")
        .put(&saved.id, None, &body, Timestamp(2))
        .unwrap();
    assert_eq!(
        h.studies.get(&saved.id).unwrap().last_verdict,
        Some(Verdict::Qualified)
    );

    let frozen = h.studies.freeze(&saved.id).unwrap();
    assert_eq!(frozen.state, ExperimentState::Frozen);
    assert_eq!(frozen.last_verdict, None);
    assert_eq!(h.studies.get(&saved.id).unwrap().last_verdict, None);
}

fn chat(id: &str) -> Origin {
    Origin::Agent {
        session_id: SessionId::new(id),
        provider: "codex".into(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_keeps_the_chat_that_ran_it_and_is_archived_restored_and_deleted_alone() {
    let h = harness();
    let saved = h.studies.save(draft("first")).await.unwrap();
    let run = h.studies.run(&saved.id, chat("ses-7")).await.unwrap();

    let listed = h.studies.all_runs().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].origin, Some(chat("ses-7")));
    assert_eq!(listed[0].archived_at, None);

    let archived = h.studies.archive_run(&run.id, true).unwrap();
    let when = archived.archived_at.expect("archived");
    h.clock.advance(60_000_000_000);
    let again = h.studies.archive_run(&run.id, true).unwrap();
    assert_eq!(again.archived_at, Some(when));
    assert_eq!(h.studies.all_runs().unwrap()[0].archived_at, Some(when));

    let restored = h.studies.archive_run(&run.id, false).unwrap();
    assert_eq!(restored.archived_at, None);

    assert!(h.studies.delete_run(&run.id).unwrap());
    assert!(!h.studies.delete_run(&run.id).unwrap());
    assert!(h.studies.all_runs().unwrap().is_empty());
    assert_eq!(h.studies.get(&saved.id).unwrap().id, saved.id);
    assert!(h.studies.archive_run(&run.id, true).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_study_s_runs_list_together_newest_first() {
    let h = harness();
    let one = h.studies.save(draft("one")).await.unwrap();
    let two = h.studies.save(draft("two")).await.unwrap();
    let first = h.studies.run(&one.id, Origin::User).await.unwrap();
    h.clock.advance(60_000_000_000);
    let second = h.studies.run(&two.id, chat("ses-2")).await.unwrap();
    h.clock.advance(60_000_000_000);
    let third = h.studies.run(&one.id, chat("ses-3")).await.unwrap();
    h.studies.archive_run(&first.id, true).unwrap();

    let ids: Vec<_> = h
        .studies
        .all_runs()
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, [third.id.clone(), second.id, first.id.clone()]);
    let of_one: Vec<_> = h
        .studies
        .runs(&one.id)
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(of_one, [third.id, first.id]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_entry_that_cannot_be_read_leaves_the_rest_of_the_ledger_readable() {
    let h = harness();
    let saved = h.studies.save(draft("kept")).await.unwrap();
    h.studies.run(&saved.id, Origin::User).await.unwrap();
    let broken = json!({"id": "x", "state": "nonsense"});
    h.store
        .documents("research.study")
        .put("study-x", None, &broken, Timestamp(1))
        .unwrap();
    h.store
        .documents("research.run")
        .put("run-x", Some(&saved.id), &broken, Timestamp(1))
        .unwrap();

    assert_eq!(h.studies.list().unwrap().len(), 1);
    assert_eq!(h.studies.all_runs().unwrap().len(), 1);
    assert_eq!(h.studies.runs(&saved.id).unwrap().len(), 1);
}
