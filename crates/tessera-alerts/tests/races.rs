use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tessera_alerts::eval::{Observation, Reading};
use tessera_alerts::{
    AlertStatus, AlertsCreateInput, AlertsService, AlertsUpdateInput, WebhookSender, WebhookVault,
};
use tessera_core::capabilities::MarketCapabilities;
use tessera_core::clock::SystemClock;
use tessera_core::health::ProviderHealth;
use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
use tessera_core::market::{Quote, Trade};
use tessera_core::{InstrumentId, Origin, Timeframe, Timestamp};
use tessera_host::EventBus;
use tessera_market::{
    BarSeries, BarsRequest, LiveBar, MarketDataProvider, MarketError, MarketRouter, MarketStream,
    MockConfig, MockMarket,
};
use tessera_store::Store;
use tokio::sync::Notify;

const HOOK: &str = "https://discord.com/api/webhooks/1234567890/races-test-token_9Zq";

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
        if self.held.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.open.notified().await;
        }
        self.inner.resolve(input).await
    }
    async fn spec(&self, i: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
        self.inner.spec(i).await
    }
    async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
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

struct Vault;

#[async_trait]
impl WebhookVault for Vault {
    async fn get(&self) -> Result<Option<String>, String> {
        Ok(Some(HOOK.to_owned()))
    }
    async fn set(&self, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
struct HeldDiscord {
    entered: Notify,
    open: Notify,
}

#[async_trait]
impl WebhookSender for HeldDiscord {
    async fn post(&self, _: &str, _: &Value) -> Result<(), String> {
        self.entered.notify_one();
        self.open.notified().await;
        Ok(())
    }
}

struct H {
    store: Store,
    service: Arc<AlertsService>,
    market: Arc<Gated>,
    discord: Arc<HeldDiscord>,
}

fn harness() -> H {
    let market = Arc::new(Gated {
        inner: MockMarket::new(MockConfig::new(Arc::new(SystemClock))),
        held: AtomicBool::new(false),
        entered: Notify::new(),
        open: Notify::new(),
    });
    let router = MarketRouter::new();
    router
        .add(Arc::clone(&market) as Arc<dyn MarketDataProvider>)
        .unwrap();
    let discord = Arc::new(HeldDiscord::default());
    let store = Store::open_in_memory().unwrap();
    let service = AlertsService::load(
        store.clone(),
        Arc::new(EventBus::new()),
        Arc::new(SystemClock),
        router,
        Arc::new(Vault),
        Arc::clone(&discord) as Arc<dyn WebhookSender>,
    )
    .unwrap();
    H {
        store,
        service,
        market,
        discord,
    }
}

async fn create(service: &AlertsService, discord: bool) -> String {
    let input: AlertsCreateInput = serde_json::from_value(json!({
        "instrument": "NQ",
        "steps": [{"op": "above", "target": {"kind": "value", "value": 1}}],
        "repeat": "every",
        "deliver": {"sound": true, "desktop": true, "discord": discord},
    }))
    .unwrap();
    service.create(&Origin::User, input).await.unwrap().id
}

async fn fire(service: &Arc<AlertsService>, id: &str) {
    let reading = Reading {
        subject: 2.0,
        target: 1.0,
    };
    let obs = Observation::trade(Timestamp(1_800_000_000_000_000_000), 2.0);
    assert!(service.fire(id, reading, &obs, "Mock").await.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pause_made_while_an_edit_resolves_its_market_survives_the_edit() {
    let h = harness();
    let id = create(&h.service, false).await;
    h.market.held.store(true, Ordering::SeqCst);
    let edit = {
        let (service, id) = (Arc::clone(&h.service), id.clone());
        tokio::spawn(async move {
            let input: AlertsUpdateInput = serde_json::from_value(json!({
                "id": id, "instrument": "NQ", "message": "edited"
            }))
            .unwrap();
            service.update(&Origin::User, input).await.unwrap()
        })
    };
    h.market.entered.notified().await;
    h.service.pause(&id, true).await.unwrap();
    h.market.open.notify_one();
    let edited = edit.await.unwrap();

    assert_eq!(edited.status, AlertStatus::Paused);
    assert_eq!(edited.message.as_deref(), Some("edited"));
    assert_eq!(h.service.get(&id).unwrap().status, AlertStatus::Paused);
    let reloaded = reload(&h);
    assert_eq!(reloaded.status, AlertStatus::Paused);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pause_made_while_a_firing_is_delivered_survives() {
    let h = harness();
    let id = create(&h.service, true).await;
    fire(&h.service, &id).await;
    h.discord.entered.notified().await;
    h.service.pause(&id, true).await.unwrap();
    h.discord.open.notify_one();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let a = h.service.get(&id).unwrap();
    assert_eq!((a.status, a.fire_count), (AlertStatus::Paused, 1));
    assert_eq!(reload(&h).status, AlertStatus::Paused);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_made_while_a_firing_is_delivered_stays_deleted() {
    let h = harness();
    let id = create(&h.service, true).await;
    fire(&h.service, &id).await;
    h.discord.entered.notified().await;
    assert!(h.service.delete(&id).await.unwrap());
    h.discord.open.notify_one();
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert!(h.service.get(&id).is_none());
    assert!(h.service.history(None, 50).await.unwrap().is_empty());
    assert!(h.service.history(Some(&id), 50).await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paused_alert_does_not_fire() {
    let h = harness();
    let id = create(&h.service, false).await;
    h.service.pause(&id, true).await.unwrap();
    let reading = Reading {
        subject: 2.0,
        target: 1.0,
    };
    let obs = Observation::trade(Timestamp(1_800_000_000_000_000_000), 2.0);
    assert!(h.service.fire(&id, reading, &obs, "Mock").await.is_none());
    assert_eq!(h.service.get(&id).unwrap().fire_count, 0);
}

fn reload(h: &H) -> tessera_alerts::Alert {
    let id = h.service.all()[0].id.clone();
    let again = AlertsService::load(
        h.store.clone(),
        Arc::new(EventBus::new()),
        Arc::new(SystemClock),
        MarketRouter::new(),
        Arc::new(Vault),
        Arc::new(HeldDiscord::default()),
    )
    .unwrap();
    again.get(&id).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_firing_dropped_by_its_caller_is_still_counted_and_delivered() {
    let h = harness();
    let id = create(&h.service, true).await;
    let reading = Reading {
        subject: 2.0,
        target: 1.0,
    };
    let obs = Observation::trade(Timestamp(1_800_000_000_000_000_000), 2.0);
    let mut firing = Box::pin(h.service.fire(&id, reading, &obs, "Mock"));
    std::future::poll_fn(|cx| {
        let _ = firing.as_mut().poll(cx);
        std::task::Poll::Ready(())
    })
    .await;
    drop(firing);
    tokio::time::timeout(Duration::from_secs(5), h.discord.entered.notified())
        .await
        .expect("Discord is asked even though the caller let go");
    h.discord.open.notify_one();
    assert_eq!(h.service.get(&id).unwrap().fire_count, 1);
    assert_eq!(h.service.history(Some(&id), 10).await.unwrap().len(), 1);
}
