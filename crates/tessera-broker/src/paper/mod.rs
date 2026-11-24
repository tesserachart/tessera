pub mod account;
pub mod engine;
pub mod room;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod room_tests;

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use futures::stream::BoxStream;
use parking_lot::Mutex;
use tessera_core::accounts::{AccountSummary, Environment, TradingAccount};
use tessera_core::capabilities::BrokerCapabilities;
use tessera_core::health::{HealthStatus, ProviderHealth, ProviderKind};
use tessera_core::ids::{AccountId, DraftId, OrderId};
use tessera_core::market::Quote;
use tessera_core::orders::{
    Bracket, Fill, Order, OrderPreview, OrderRequest, OrderType, Position, TimeInForce,
};
use tessera_core::{InstrumentId, Qty, SharedClock, Timestamp};
use tessera_market::{MarketDataProvider, MarketError};
use tessera_store::{BrokerBatch, Store};
use tokio::sync::{Notify, broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_stream::wrappers::BroadcastStream;

#[cfg(any(test, feature = "test-support"))]
pub use account::test_seeds;
pub use account::{AccountSeed, PaperAccount, default_seeds};
pub use engine::{Book, BookError, Changes, Commission, Feed, PaperConfig};

use crate::{BrokerError, BrokerEvent, BrokerProvider, BrokerSystem, OrderChanges, Verified};

pub const PAPER_CONNECTION: &str = "paper";
pub const PAPER_SYSTEM: &str = "Tessera Paper";

enum WriteJob {
    Batch(Box<BrokerBatch>),
    Flush(oneshot::Sender<()>),
}

pub struct PaperBroker {
    id: String,
    book: Mutex<Book>,
    market: Arc<dyn MarketDataProvider>,
    clock: SharedClock,
    events: broadcast::Sender<BrokerEvent>,
    store: Option<Store>,
    writer: Option<mpsc::UnboundedSender<WriteJob>>,
    interest: Arc<Notify>,
    feeds: Mutex<HashMap<InstrumentId, JoinHandle<()>>>,
}

impl std::fmt::Debug for PaperBroker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaperBroker")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

fn market_error(e: MarketError) -> BrokerError {
    match e {
        MarketError::UnknownInstrument(s) => BrokerError::NotFound(format!("instrument {s}")),
        other => BrokerError::Unavailable(other.to_string()),
    }
}

fn book_error(e: BookError) -> BrokerError {
    match e {
        BookError::UnknownAccount(a) => BrokerError::NotFound(format!("account {a}")),
        BookError::UnknownOrder(o) => BrokerError::NotFound(format!("order {o}")),
        BookError::UnknownInstrument(i) => {
            BrokerError::Unavailable(format!("no market data for {i}"))
        }
        BookError::NotOpen(why) | BookError::Refused(why) => BrokerError::Rejected(why),
    }
}

impl PaperBroker {
    pub async fn open(
        market: Arc<dyn MarketDataProvider>,
        clock: SharedClock,
        store: Option<Store>,
        config: PaperConfig,
        seeds: &[AccountSeed],
    ) -> Result<Arc<Self>, BrokerError> {
        let now = clock.now();
        let mut book = Book::new(config);
        let unavailable = |e: tessera_store::StoreError| BrokerError::Unavailable(e.to_string());
        let mut seeded = Vec::new();
        if let Some(store) = &store {
            let s = store.clone();
            let (accounts, orders, positions, fills) = tokio::task::spawn_blocking(move || {
                let repo = s.broker(PAPER_CONNECTION);
                let day_start = account::DAY_CALENDAR
                    .session(account::DAY_CALENDAR.trade_date(now))
                    .map_or(now, |x| x.open);
                Ok::<_, tessera_store::StoreError>((
                    repo.accounts()?,
                    repo.orders(day_start)?,
                    repo.positions()?,
                    repo.fills(None, day_start)?,
                ))
            })
            .await
            .map_err(|e| BrokerError::Unavailable(e.to_string()))?
            .map_err(unavailable)?;
            let named = |id: &AccountId| {
                seeds.iter().any(|s| {
                    s.id == id.as_str() || s.formerly.is_some_and(|(f, _)| f == id.as_str())
                })
            };
            for body in accounts {
                match serde_json::from_value::<PaperAccount>(body) {
                    Ok(a) if !named(a.id()) => {}
                    Ok(mut a) => {
                        if let Some(seed) = seeds.iter().find(|s| {
                            s.formerly.is_some_and(|(id, name)| {
                                a.id().as_str() == id && a.account.display_name == name
                            })
                        }) {
                            seed.name.clone_into(&mut a.account.display_name);
                            seeded.push(a.id().clone());
                        }
                        book.add_account(a);
                    }
                    Err(e) => tracing::error!(error = %e, "unreadable paper account; skipped"),
                }
            }
            for o in orders.into_iter().filter(|o| named(&o.request.account_id)) {
                book.restore_order(o);
            }
            for p in positions.into_iter().filter(|p| named(&p.account_id)) {
                book.restore_position(p);
            }
            for f in fills.into_iter().filter(|f| named(&f.account_id)) {
                book.restore_fill(f);
            }
        }
        for seed in seeds {
            let stored = |id: &str| book.account(&AccountId::new(id)).is_some();
            if !stored(seed.id) && !seed.formerly.is_some_and(|(id, _)| stored(id)) {
                let a = PaperAccount::open(seed, PAPER_CONNECTION, now);
                seeded.push(a.id().clone());
                book.add_account(a);
            }
        }
        let writer = store.clone().map(spawn_writer);
        let (events, _) = broadcast::channel(4096);
        let me = Arc::new(Self {
            id: PAPER_CONNECTION.to_owned(),
            book: Mutex::new(book),
            market,
            clock,
            events,
            store,
            writer,
            interest: Arc::new(Notify::new()),
            feeds: Mutex::new(HashMap::new()),
        });
        let wanted = me.book.lock().instruments_of_interest();
        for i in wanted {
            if let Err(e) = me.load(&i).await {
                tracing::warn!(instrument = %i, error = %e, "paper broker: no contract spec");
            }
        }
        {
            let mut book = me.book.lock();
            let mut ch = book.roll(now);
            for id in seeded {
                if !ch.accounts.contains(&id) {
                    ch.accounts.push(id);
                }
            }
            me.dispatch(&book, ch, now);
        }
        me.flush().await;
        Ok(me)
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }

    pub fn set_commission(&self, commission: Commission) {
        self.book.lock().set_commission(commission);
    }

    pub fn config(&self) -> PaperConfig {
        self.book.lock().config()
    }

    pub async fn flush(&self) {
        if let Some(w) = &self.writer {
            let (tx, rx) = oneshot::channel();
            if w.send(WriteJob::Flush(tx)).is_ok() {
                let _ = rx.await;
            }
        }
    }

    pub fn primary_environment(&self) -> Option<Environment> {
        self.book
            .lock()
            .accounts()
            .next()
            .map(|a| a.account.environment)
    }

    pub fn environment(&self, account: &AccountId) -> Option<Environment> {
        self.book
            .lock()
            .account(account)
            .map(|a| a.account.environment)
    }

    async fn load(&self, instrument: &InstrumentId) -> Result<(), BrokerError> {
        if self.book.lock().has_market(instrument) {
            return Ok(());
        }
        let (inst, spec) = self.market.spec(instrument).await.map_err(market_error)?;
        self.book.lock().set_market(spec, inst.tradable);
        Ok(())
    }

    async fn prepare(&self, instrument: &InstrumentId) -> Result<(), BrokerError> {
        self.load(instrument).await?;
        let quote = self.market.quote(instrument).await.ok();
        let feed = self.feed(instrument, quote.as_ref());
        let now = self.now();
        let mut book = self.book.lock();
        if let Some(q) = &quote {
            let ch = book.on_quote(q, now);
            self.dispatch(&book, ch, now);
        }
        book.on_feed(instrument, feed);
        Ok(())
    }

    fn feed(&self, instrument: &InstrumentId, quote: Option<&Quote>) -> Feed {
        match quote {
            Some(q) if self.market.prices_down_for(instrument).is_none() => Feed::Live {
                heard_at: self.market.last_message_for(instrument).unwrap_or(q.ts),
            },
            _ => Feed::Down,
        }
    }

    fn dispatch(&self, book: &Book, ch: Changes, now: Timestamp) {
        if ch.is_empty() {
            return;
        }
        let mut batch = BrokerBatch::default();
        for o in &ch.orders {
            let _ = self.events.send(BrokerEvent::Order(o.clone()));
        }
        for f in &ch.fills {
            let _ = self.events.send(BrokerEvent::Fill(f.clone()));
        }
        for p in &ch.positions {
            let _ = self.events.send(BrokerEvent::Position(p.clone()));
        }
        for id in &ch.accounts {
            if let Some(s) = book.summary(id, now) {
                let _ = self.events.send(BrokerEvent::Account(s));
            }
            if let Some(a) = book.account(id)
                && let Ok(body) = serde_json::to_value(a)
            {
                batch.accounts.push((id.to_string(), body));
            }
        }
        if let Some(w) = &self.writer {
            batch.positions = ch
                .positions
                .into_iter()
                .filter(|p| {
                    ch.fills
                        .iter()
                        .any(|f| f.account_id == p.account_id && f.instrument == p.instrument)
                })
                .collect();
            batch.orders = ch.orders;
            batch.fills = ch.fills;
            if !batch.is_empty() {
                let _ = w.send(WriteJob::Batch(Box::new(batch)));
            }
        }
    }

    pub fn start(self: &Arc<Self>) -> Vec<JoinHandle<()>> {
        let feed = {
            let me = Arc::downgrade(self);
            tokio::spawn(async move {
                loop {
                    let Some(broker) = me.upgrade() else { return };
                    broker.sync_feeds().await;
                    let interest = Arc::clone(&broker.interest);
                    drop(broker);
                    tokio::select! {
                        () = interest.notified() => {}
                        () = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                }
            })
        };
        let roll = {
            let me = Arc::downgrade(self);
            tokio::spawn(async move {
                let mut iv = tokio::time::interval(Duration::from_secs(15));
                loop {
                    iv.tick().await;
                    let Some(broker) = me.upgrade() else { return };
                    let now = broker.now();
                    let mut book = broker.book.lock();
                    let ch = book.roll(now);
                    broker.dispatch(&book, ch, now);
                }
            })
        };
        vec![feed, roll]
    }

    async fn sync_feeds(self: &Arc<Self>) {
        let wanted = self.book.lock().instruments_of_interest();
        {
            let mut feeds = self.feeds.lock();
            feeds.retain(|i, task| {
                let keep = wanted.contains(i) && !task.is_finished();
                if !keep {
                    task.abort();
                }
                keep
            });
        }
        for i in wanted {
            if self.feeds.lock().contains_key(&i) {
                continue;
            }
            if let Err(e) = self.load(&i).await {
                tracing::warn!(instrument = %i, error = %e, "paper broker: cannot follow");
                continue;
            }
            let (quotes, trades) = match (
                self.market.subscribe_quotes(std::slice::from_ref(&i)),
                self.market.subscribe_trades(std::slice::from_ref(&i)),
            ) {
                (Ok(q), Ok(t)) => (q, t),
                (Err(e), _) | (_, Err(e)) => {
                    tracing::warn!(instrument = %i, error = %e, "paper broker: no live data");
                    continue;
                }
            };
            let task = tokio::spawn(follow(Arc::downgrade(self), quotes, trades));
            self.feeds.lock().insert(i, task);
        }
    }
}

async fn follow(
    broker: Weak<PaperBroker>,
    mut quotes: BoxStream<'static, tessera_core::market::Quote>,
    mut trades: BoxStream<'static, tessera_core::market::Trade>,
) {
    loop {
        let event = tokio::select! {
            q = quotes.next() => q.map(Either::Quote),
            t = trades.next() => t.map(Either::Trade),
        };
        let Some(event) = event else { return };
        let Some(b) = broker.upgrade() else { return };
        let now = b.now();
        let interest_changed = {
            let mut book = b.book.lock();
            let before = book.instruments_of_interest().len();
            let ch = match &event {
                Either::Quote(q) => book.on_quote(q, now),
                Either::Trade(t) => book.on_trade(t, now),
            };
            let changed = !ch.orders.is_empty() || !ch.positions.is_empty();
            b.dispatch(&book, ch, now);
            changed && book.instruments_of_interest().len() != before
        };
        if interest_changed {
            b.interest.notify_one();
        }
    }
}

enum Either {
    Quote(tessera_core::market::Quote),
    Trade(tessera_core::market::Trade),
}

fn spawn_writer(store: Store) -> mpsc::UnboundedSender<WriteJob> {
    let (tx, mut rx) = mpsc::unbounded_channel::<WriteJob>();
    tokio::spawn(async move {
        while let Some(job) = rx.recv().await {
            match job {
                WriteJob::Batch(batch) => {
                    let s = store.clone();
                    let now = Timestamp::now();
                    let r = tokio::task::spawn_blocking(move || {
                        s.broker(PAPER_CONNECTION).apply(&batch, now)
                    })
                    .await;
                    match r {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => tracing::error!(error = %e, "paper broker: write failed"),
                        Err(e) => tracing::error!(error = %e, "paper broker: writer failed"),
                    }
                }
                WriteJob::Flush(done) => {
                    let _ = done.send(());
                }
            }
        }
    });
    tx
}

#[async_trait]
impl BrokerProvider for PaperBroker {
    fn id(&self) -> &str {
        &self.id
    }

    fn capabilities(&self) -> BrokerCapabilities {
        BrokerCapabilities {
            order_types: vec![
                OrderType::Market,
                OrderType::Limit,
                OrderType::Stop,
                OrderType::StopLimit,
            ],
            time_in_force: vec![
                TimeInForce::Day,
                TimeInForce::Gtc,
                TimeInForce::Ioc,
                TimeInForce::Fok,
            ],
            brackets: true,
            oco: true,
            modify: true,
            read_only: false,
            environments: vec![Environment::Paper, Environment::Eval],
            fractional_qty: true,
            stop_rules: true,
        }
    }

    fn system(&self) -> BrokerSystem {
        BrokerSystem {
            name: PAPER_SYSTEM.to_owned(),
            environment: Environment::Paper,
        }
    }

    fn health(&self) -> ProviderHealth {
        ProviderHealth {
            provider_id: self.id.clone(),
            kind: ProviderKind::Broker,
            display_name: PAPER_SYSTEM.to_owned(),
            status: HealthStatus::Ok,
            latency_ms: None,
            last_message_at: None,
            message: Some("Simulated fills against the market's quotes and trades".into()),
            connection: None,
            accounts: None,
            checked_at: self.now(),
        }
    }

    fn environment_of(&self, account: &AccountId) -> Option<Environment> {
        self.environment(account)
    }

    fn order_of(&self, order: &OrderId) -> Option<Order> {
        self.book.lock().order(order).cloned()
    }

    async fn accounts(&self) -> Result<Vec<TradingAccount>, BrokerError> {
        Ok(self
            .book
            .lock()
            .accounts()
            .map(|a| a.account.clone())
            .collect())
    }

    async fn summary(&self, account: &AccountId) -> Result<AccountSummary, BrokerError> {
        let now = self.now();
        let mut book = self.book.lock();
        let ch = book.roll(now);
        self.dispatch(&book, ch, now);
        book.summary(account, now)
            .ok_or_else(|| BrokerError::NotFound(format!("account {account}")))
    }

    async fn positions(&self, account: &AccountId) -> Result<Vec<Position>, BrokerError> {
        Ok(self.book.lock().positions(Some(account)))
    }

    async fn orders(&self, account: &AccountId) -> Result<Vec<Order>, BrokerError> {
        Ok(self.book.lock().orders(Some(account)))
    }

    async fn fills(&self, account: &AccountId, since: Timestamp) -> Result<Vec<Fill>, BrokerError> {
        let Some(store) = self.store.clone() else {
            return Ok(self.book.lock().fills(Some(account), since));
        };
        self.flush().await;
        let id = account.to_string();
        tokio::task::spawn_blocking(move || store.broker(PAPER_CONNECTION).fills(Some(&id), since))
            .await
            .map_err(|e| BrokerError::Unavailable(e.to_string()))?
            .map_err(|e| BrokerError::Unavailable(e.to_string()))
    }

    async fn preview(&self, request: &OrderRequest) -> Result<OrderPreview, BrokerError> {
        self.prepare(&request.instrument).await?;
        self.book
            .lock()
            .preview(request, self.now())
            .map_err(book_error)
    }

    async fn submit(
        &self,
        _verified: &Verified,
        request: OrderRequest,
        draft: Option<DraftId>,
    ) -> Result<Order, BrokerError> {
        self.prepare(&request.instrument).await?;
        let now = self.now();
        let order = {
            let mut book = self.book.lock();
            let (order, ch) = book.submit(request, draft, now).map_err(book_error)?;
            self.dispatch(&book, ch, now);
            order
        };
        self.interest.notify_one();
        self.flush().await;
        Ok(order)
    }

    async fn modify(
        &self,
        _verified: &Verified,
        order: &OrderId,
        changes: OrderChanges,
    ) -> Result<Order, BrokerError> {
        let instrument = self
            .book
            .lock()
            .order(order)
            .map(|o| o.request.instrument.clone())
            .ok_or_else(|| BrokerError::NotFound(format!("order {order}")))?;
        self.prepare(&instrument).await?;
        let now = self.now();
        let updated = {
            let mut book = self.book.lock();
            let (o, ch) = book.modify(order, &changes, now).map_err(book_error)?;
            self.dispatch(&book, ch, now);
            o
        };
        self.flush().await;
        Ok(updated)
    }

    async fn cancel(&self, _verified: &Verified, order: &OrderId) -> Result<Order, BrokerError> {
        let now = self.now();
        let cancelled = {
            let mut book = self.book.lock();
            let (o, ch) = book.cancel(order, now).map_err(book_error)?;
            self.dispatch(&book, ch, now);
            o
        };
        self.interest.notify_one();
        self.flush().await;
        Ok(cancelled)
    }

    async fn attach_bracket(
        &self,
        _verified: &Verified,
        entry: &OrderId,
        bracket: Bracket,
        qty: Qty,
    ) -> Result<Vec<Order>, BrokerError> {
        let instrument = self
            .book
            .lock()
            .order(entry)
            .map(|o| o.request.instrument.clone())
            .ok_or_else(|| BrokerError::NotFound(format!("order {entry}")))?;
        self.prepare(&instrument).await?;
        let now = self.now();
        let legs = {
            let mut book = self.book.lock();
            let (legs, ch) = book
                .attach_bracket(entry, bracket, qty, now)
                .map_err(book_error)?;
            self.dispatch(&book, ch, now);
            legs
        };
        self.interest.notify_one();
        self.flush().await;
        Ok(legs)
    }

    fn events(&self) -> BoxStream<'static, BrokerEvent> {
        BroadcastStream::new(self.events.subscribe())
            .filter_map(|e| async move { e.ok() })
            .boxed()
    }
}
