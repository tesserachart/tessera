use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Instant;

use futures::StreamExt;
use parking_lot::Mutex;
use rithmic_rs::rti::ResponseDepthByOrderSnapshot;
use rithmic_rs::rti::messages::RithmicMessage;
use tessera_core::instrument::InstrumentId;
use tessera_core::market::{Quote, Trade};
use tessera_core::session::SessionCalendar;
use tessera_core::time::Timestamp;
use tessera_market::{MarketError, MarketStream, OrderBookEvent};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tracing::warn;

use crate::book::{BookEvent, BookFeed};
use crate::map::{self, Grid, QuoteState};
use crate::session::Session;
use crate::templates::Template;

pub const MAX_DEPTH_LEVELS: u32 = 100;

const SNAPSHOT_ATTEMPTS: u32 = 3;

const SNAPSHOT_RETRY: std::time::Duration = std::time::Duration::from_secs(10);

const SUBSCRIBE_RETRY: tessera_core::backoff::Backoff = tessera_core::backoff::Backoff::new(
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(60),
);

const TRADES_BUFFER: usize = 8192;

pub type FeedKey = (String, String);

pub type OrderBatch = Arc<[OrderBookEvent]>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Want {
    Top,
    Depth,
}

#[derive(Debug, Default)]
struct Interest {
    refs: usize,
    idle_since: Option<Instant>,
    on: bool,
}

impl Interest {
    fn wanted(&self, linger: std::time::Duration) -> bool {
        self.refs > 0 || self.idle_since.is_some_and(|t| t.elapsed() < linger)
    }
}

struct Feed {
    id: InstrumentId,
    calendar: SessionCalendar,
    grid: Grid,
    quote: QuoteState,
    quotes: broadcast::Sender<Quote>,
    trades: broadcast::Sender<Trade>,
    orders: broadcast::Sender<OrderBatch>,
    book: Option<BookFeed>,
    snapshot_misses: u32,
    refusals: u32,
    top: Interest,
    depth: Interest,
}

impl Feed {
    fn new(id: InstrumentId, calendar: SessionCalendar, grid: Grid) -> Self {
        Self {
            id,
            calendar,
            grid,
            quote: QuoteState {
                grid,
                ..QuoteState::default()
            },
            quotes: broadcast::channel(1024).0,
            trades: broadcast::channel(TRADES_BUFFER).0,
            orders: broadcast::channel(8192).0,
            book: None,
            snapshot_misses: 0,
            refusals: 0,
            top: Interest::default(),
            depth: Interest::default(),
        }
    }

    fn set_grid(&mut self, grid: Grid) {
        self.grid = grid;
        self.quote.grid = grid;
        if let Some(b) = self.book.as_mut().and_then(BookFeed::book_mut) {
            b.set_grid(grid);
        }
    }

    fn interest(&mut self, want: Want) -> &mut Interest {
        match want {
            Want::Top => &mut self.top,
            Want::Depth => &mut self.depth,
        }
    }

    fn image(&self) -> Option<OrderBatch> {
        let book = self.book.as_ref()?.book()?;
        Some(book.image(Timestamp::now()).into())
    }

    fn clear_book(&mut self) {
        if let Some(b) = self.book.as_ref().and_then(BookFeed::book) {
            let ts = b.time().unwrap_or_else(Timestamp::now);
            let _ = self.orders.send(Arc::from([OrderBookEvent::Clear { ts }]));
        }
    }

    fn give_up_book(&mut self, why: String) {
        self.clear_book();
        self.book = Some(BookFeed::Unavailable(why));
    }

    fn snapshot_missed(&mut self, why: &str) -> bool {
        self.snapshot_misses += 1;
        if self.snapshot_misses < SNAPSHOT_ATTEMPTS {
            return true;
        }
        self.give_up_book(format!(
            "no depth snapshot after {SNAPSHOT_ATTEMPTS} attempts ({why})"
        ));
        false
    }
}

#[derive(Default)]
pub struct Feeds {
    map: Mutex<HashMap<FeedKey, Feed>>,
    ops: Mutex<HashMap<FeedKey, Arc<tokio::sync::Mutex<()>>>>,
    grids: Mutex<HashMap<FeedKey, Grid>>,
}

pub struct InterestGuard {
    session: Weak<Session>,
    key: FeedKey,
    want: Want,
}

impl Drop for InterestGuard {
    fn drop(&mut self) {
        let Some(session) = self.session.upgrade() else {
            return;
        };
        let idle = {
            let mut map = session.feeds.map.lock();
            let Some(feed) = map.get_mut(&self.key) else {
                return;
            };
            let i = feed.interest(self.want);
            i.refs = i.refs.saturating_sub(1);
            if i.refs == 0 {
                i.idle_since = Some(Instant::now());
            }
            i.refs == 0
        };
        if idle {
            let after = session.opts.linger + std::time::Duration::from_millis(50);
            spawn_reconcile_after(&session, self.key.clone(), after);
        }
    }
}

fn spawn_reconcile_after(session: &Arc<Session>, key: FeedKey, delay: std::time::Duration) {
    let s = Arc::clone(session);
    session.runtime().spawn(async move {
        tokio::time::sleep(delay).await;
        reconcile(&s, &key).await;
    });
}

pub(crate) fn spawn_reconcile(session: &Arc<Session>, key: FeedKey) {
    let s = Arc::clone(session);
    session
        .runtime()
        .spawn(async move { reconcile(&s, &key).await });
}

fn check_reply(session: &Session, r: &rithmic_rs::RithmicResponse) -> Result<(), MarketError> {
    match &r.error {
        Some(e) => Err(MarketError::Unavailable(session.redact(e))),
        None => Ok(()),
    }
}

pub(crate) async fn reconcile(session: &Arc<Session>, key: &FeedKey) {
    let lock = session.feeds.op_lock(key);
    let _held = lock.lock().await;
    let linger = session.opts.linger;
    let state = session.feeds.with(key, |f| {
        let waiting = f.book.as_ref().is_some_and(BookFeed::is_pending);
        let given_up = f.book.as_ref().is_some_and(|b| b.unavailable().is_some());
        (
            f.top.wanted(linger),
            f.top.on,
            f.depth.wanted(linger) && !given_up,
            f.depth.on,
            waiting,
            given_up,
        )
    });
    let Some((want_top, on_top, want_depth, on_depth, book_waiting, given_up)) = state else {
        return;
    };
    let Ok(h) = session.ticker() else {
        return;
    };
    let (sym, exch) = (key.0.as_str(), key.1.as_str());
    if ((want_top && !on_top) || (want_depth && !on_depth)) && session.feeds.grid(key).is_none() {
        learn_grid(session, key, &h).await;
    }
    if want_top && !on_top {
        let r = session
            .request(Template::MarketDataUpdate, h.subscribe(sym, exch))
            .await
            .and_then(|r| check_reply(session, &r));
        let stats = session
            .request(
                Template::MarketDataUpdate,
                h.subscribe_session_prices(sym, exch),
            )
            .await
            .and_then(|r| check_reply(session, &r));
        match r {
            Ok(()) => session.feeds.subscribed(key, Want::Top),
            Err(e) => {
                warn!(symbol = sym, error = %e, "rithmic market data subscribe failed; trying again");
                retry_subscribe(session, key);
            }
        }
        if let Err(e) = stats {
            warn!(symbol = sym, error = %e, "rithmic session prices subscribe failed");
        }
    } else if !want_top && on_top {
        let _ = session
            .request(Template::MarketDataUpdate, h.unsubscribe(sym, exch))
            .await;
        let _ = session
            .request(
                Template::MarketDataUpdate,
                h.unsubscribe_session_prices(sym, exch),
            )
            .await;
        session.feeds.with(key, |f| {
            f.top.on = false;
            f.top.idle_since = None;
        });
    }
    if want_depth && !on_depth {
        session
            .feeds
            .with(key, |f| f.book = Some(BookFeed::default()));
        let r = session
            .request(
                Template::DepthByOrderUpdates,
                h.subscribe_depth_by_order_update(sym, exch),
            )
            .await
            .and_then(|r| check_reply(session, &r));
        match r {
            Ok(()) => {
                session.feeds.subscribed(key, Want::Depth);
                snapshot(session, key, &h).await;
            }
            Err(e) => {
                warn!(symbol = sym, error = %e, "rithmic depth-by-order subscribe failed; trying again");
                session.feeds.with(key, |f| f.book = None);
                retry_subscribe(session, key);
            }
        }
    } else if !want_depth && on_depth {
        let _ = session
            .request(
                Template::DepthByOrderUpdates,
                h.unsubscribe_depth_by_order_update(sym, exch),
            )
            .await;
        session.feeds.with(key, |f| {
            f.depth.on = false;
            f.depth.idle_since = None;
            if !given_up {
                f.clear_book();
                f.book = None;
            }
        });
    } else if want_depth && on_depth && book_waiting {
        snapshot(session, key, &h).await;
    }
}

fn retry_subscribe(session: &Arc<Session>, key: &FeedKey) {
    let refusals = session
        .feeds
        .with(key, |f| {
            f.refusals += 1;
            f.refusals
        })
        .unwrap_or(1);
    spawn_reconcile_after(session, key.clone(), SUBSCRIBE_RETRY.delay(refusals));
}

async fn learn_grid(
    session: &Arc<Session>,
    key: &FeedKey,
    h: &rithmic_rs::RithmicTickerPlantHandle,
) {
    let r = session
        .request(
            Template::ReferenceData,
            h.get_reference_data(&key.0, &key.1),
        )
        .await;
    let tick = match &r {
        Ok(r) if r.error.is_none() => match &r.message {
            RithmicMessage::ResponseReferenceData(d) => crate::symbols::reference_tick(d),
            _ => None,
        },
        _ => None,
    };
    match tick {
        Some(t) => session.feeds.set_grid(key, Grid::of(t)),
        None => warn!(symbol = %key.0, "no tick size from Rithmic yet; prices are only cleaned"),
    }
}

async fn snapshot(session: &Arc<Session>, key: &FeedKey, h: &rithmic_rs::RithmicTickerPlantHandle) {
    let frames = session
        .request(
            Template::DepthByOrderSnapshot,
            h.get_depth_by_order_snapshot(&key.0, &key.1),
        )
        .await;
    let frames: Vec<ResponseDepthByOrderSnapshot> = match frames {
        Ok(frames) => {
            if let Some(err) = frames.iter().find_map(|f| f.error.as_ref()) {
                let why = session.redact(err);
                warn!(symbol = %key.0, error = %why, "rithmic depth snapshot refused");
                session
                    .feeds
                    .give_up(key, format!("Rithmic refused the depth snapshot: {why}"));
                spawn_reconcile(session, key.clone());
                return;
            }
            frames
                .into_iter()
                .filter_map(|f| match f.message {
                    RithmicMessage::ResponseDepthByOrderSnapshot(s) => Some(s),
                    _ => None,
                })
                .collect()
        }
        Err(e) => {
            let again = session
                .feeds
                .with(key, |f| f.snapshot_missed(&e.to_string()))
                .unwrap_or(false);
            warn!(symbol = %key.0, error = %e, again, "rithmic depth snapshot failed");
            if again {
                spawn_reconcile_after(session, key.clone(), SNAPSHOT_RETRY);
            } else {
                spawn_reconcile(session, key.clone());
            }
            return;
        }
    };
    session.feeds.apply_snapshot(key, &frames);
}

impl Feeds {
    fn op_lock(&self, key: &FeedKey) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(self.ops.lock().entry(key.clone()).or_default())
    }

    fn with<T>(&self, key: &FeedKey, f: impl FnOnce(&mut Feed) -> T) -> Option<T> {
        self.map.lock().get_mut(key).map(f)
    }

    fn subscribed(&self, key: &FeedKey, want: Want) {
        self.with(key, |f| {
            f.refusals = 0;
            f.interest(want).on = true;
        });
    }

    pub fn grid(&self, key: &FeedKey) -> Option<Grid> {
        self.grids.lock().get(key).copied()
    }

    pub(crate) fn set_grid(&self, key: &FeedKey, grid: Grid) {
        if grid.tick().is_none() {
            return;
        }
        self.grids.lock().insert(key.clone(), grid);
        self.with(key, |f| f.set_grid(grid));
    }

    pub(crate) fn apply_snapshot(&self, key: &FeedKey, frames: &[ResponseDepthByOrderSnapshot]) {
        self.with(key, |f| {
            let grid = f.grid;
            if let Some(book) = f.book.as_mut().filter(|b| b.is_pending()) {
                book.on_snapshot(frames, grid);
                f.snapshot_misses = 0;
                if let Some(image) = f.image() {
                    let _ = f.orders.send(image);
                }
            }
        });
    }

    pub(crate) fn give_up(&self, key: &FeedKey, why: String) {
        self.with(key, |f| f.give_up_book(why));
    }

    pub fn keys(&self) -> Vec<FeedKey> {
        self.map.lock().keys().cloned().collect()
    }

    pub fn reset_all(&self) {
        for f in self.map.lock().values_mut() {
            f.top.on = false;
            f.depth.on = false;
            f.snapshot_misses = 0;
            f.clear_book();
            if let Some(b) = f.book.as_mut() {
                b.reset();
            }
            f.trades = broadcast::channel(TRADES_BUFFER).0;
        }
    }

    pub(crate) fn close_all(&self) {
        let feeds: Vec<Feed> = {
            let mut map = self.map.lock();
            map.drain().map(|(_, f)| f).collect()
        };
        for mut f in feeds {
            f.clear_book();
        }
        self.ops.lock().clear();
    }

    pub(crate) fn unavailable_books(
        &self,
        linger: std::time::Duration,
    ) -> Vec<(InstrumentId, String)> {
        self.map
            .lock()
            .values()
            .filter(|f| f.depth.wanted(linger))
            .filter_map(|f| {
                let why = f.book.as_ref()?.unavailable()?;
                Some((f.id.clone(), why.to_owned()))
            })
            .collect()
    }

    pub(crate) fn resync_books(&self, session: &Arc<Session>) {
        let keys: Vec<FeedKey> = {
            let mut map = self.map.lock();
            map.iter_mut()
                .filter_map(|(k, f)| {
                    if f.book.as_ref()?.unavailable().is_some() {
                        return None;
                    }
                    f.clear_book();
                    f.book.as_mut()?.reset();
                    Some(k.clone())
                })
                .collect()
        };
        for k in keys {
            spawn_reconcile(session, k);
        }
    }

    pub(crate) fn acquire(
        &self,
        session: &Arc<Session>,
        key: &FeedKey,
        id: &InstrumentId,
        calendar: SessionCalendar,
        want: Want,
    ) -> InterestGuard {
        let grid = self.grid(key).unwrap_or_default();
        let start = {
            let mut map = self.map.lock();
            let feed = map
                .entry(key.clone())
                .or_insert_with(|| Feed::new(id.clone(), calendar, grid));
            if want == Want::Depth && feed.book.is_none() {
                feed.book = Some(BookFeed::default());
            }
            let i = feed.interest(want);
            i.refs += 1;
            i.idle_since = None;
            !i.on || i.refs == 1
        };
        if start {
            spawn_reconcile(session, key.clone());
        }
        InterestGuard {
            session: Arc::downgrade(session),
            key: key.clone(),
            want,
        }
    }

    pub(crate) fn dispatch(&self, session: &Arc<Session>, msg: RithmicMessage) {
        let key_of = |s: &Option<String>, e: &Option<String>| -> Option<FeedKey> {
            Some((s.clone()?, e.clone()?))
        };
        let mut resync = None;
        {
            let mut map = self.map.lock();
            match msg {
                RithmicMessage::LastTrade(t) => {
                    let Some(f) = key_of(&t.symbol, &t.exchange).and_then(|k| map.get_mut(&k))
                    else {
                        return;
                    };
                    f.quote.apply_trade(&t);
                    let print = map::trade(&f.id, &t, f.grid);
                    session.saw_data(print.as_ref().map(|p| p.ts));
                    if let Some(p) = print {
                        let _ = f.trades.send(p);
                    }
                    let _ = f
                        .quotes
                        .send(f.quote.to_quote(&f.id, f.calendar, Timestamp::now()));
                }
                RithmicMessage::BestBidOffer(b) => {
                    let Some(f) = key_of(&b.symbol, &b.exchange).and_then(|k| map.get_mut(&k))
                    else {
                        return;
                    };
                    f.quote.apply_bbo(&b);
                    session.saw_data(None);
                    let _ = f
                        .quotes
                        .send(f.quote.to_quote(&f.id, f.calendar, Timestamp::now()));
                }
                RithmicMessage::TradeStatistics(s) => {
                    let Some(f) = key_of(&s.symbol, &s.exchange).and_then(|k| map.get_mut(&k))
                    else {
                        return;
                    };
                    f.quote.apply_stats(&s);
                    let _ = f
                        .quotes
                        .send(f.quote.to_quote(&f.id, f.calendar, Timestamp::now()));
                }
                RithmicMessage::DepthByOrder(u) => {
                    let Some(key) = key_of(&u.symbol, &u.exchange) else {
                        return;
                    };
                    let Some(f) = map.get_mut(&key) else { return };
                    let Some(book) = f.book.as_mut() else { return };
                    session.saw_data(None);
                    match book.on_update(u) {
                        Ok(Some(BookEvent::Changes(_, orders))) => {
                            if !orders.is_empty() {
                                let _ = f.orders.send(orders.into());
                            }
                        }
                        Ok(_) => {}
                        Err(e) => {
                            let again = f.snapshot_missed(&e.to_string());
                            warn!(symbol = %key.0, error = %e, again, "rithmic book rebuilding");
                            resync = Some(key);
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(key) = resync {
            spawn_reconcile(session, key);
        }
    }

    pub(crate) fn quote(&self, key: &FeedKey) -> Option<Quote> {
        let map = self.map.lock();
        let f = map.get(key)?;
        f.quote
            .is_known()
            .then(|| f.quote.to_quote(&f.id, f.calendar, Timestamp::now()))
    }

    fn receiver<T: Clone>(
        &self,
        key: &FeedKey,
        pick: impl FnOnce(&Feed) -> &broadcast::Sender<T>,
    ) -> Option<broadcast::Receiver<T>> {
        self.map.lock().get(key).map(|f| pick(f).subscribe())
    }

    pub(crate) fn quotes(&self, key: &FeedKey, guard: InterestGuard) -> MarketStream<Quote> {
        let rx = self.receiver(key, |f| &f.quotes);
        guarded(rx, guard)
    }

    pub(crate) fn trades(&self, key: &FeedKey, guard: InterestGuard) -> MarketStream<Trade> {
        let rx = self.receiver(key, |f| &f.trades);
        let Some(rx) = rx else {
            return futures::stream::empty().boxed();
        };
        BroadcastStream::new(rx)
            .map(move |r| {
                let _held = &guard;
                if let Err(BroadcastStreamRecvError::Lagged(n)) = &r {
                    warn!(
                        symbol = %guard.key.0,
                        dropped = n,
                        "a rithmic print stream fell behind; it ends at the gap",
                    );
                }
                r.ok()
            })
            .take_while(|t| futures::future::ready(t.is_some()))
            .filter_map(futures::future::ready)
            .boxed()
    }

    pub(crate) fn order_events(
        &self,
        session: &Arc<Session>,
        key: &FeedKey,
        guard: InterestGuard,
    ) -> MarketStream<OrderBookEvent> {
        let (rx, first) = {
            let map = self.map.lock();
            match map.get(key) {
                Some(f) => (Some(f.orders.subscribe()), f.image()),
                None => (None, None),
            }
        };
        let Some(rx) = rx else {
            return futures::stream::empty().boxed();
        };
        let weak = Arc::downgrade(session);
        let key = key.clone();
        let head = futures::stream::iter(first);
        let tail = BroadcastStream::new(rx).filter_map(move |r| {
            let _held = &guard;
            let out = match r {
                Ok(batch) => Some(batch),
                Err(_lagged) => weak.upgrade().map(|s| {
                    let map = s.feeds.map.lock();
                    map.get(&key).and_then(Feed::image).unwrap_or_else(|| {
                        Arc::from([OrderBookEvent::Clear {
                            ts: Timestamp::now(),
                        }])
                    })
                }),
            };
            futures::future::ready(out)
        });
        head.chain(tail)
            .flat_map(|batch: OrderBatch| futures::stream::iter(batch.to_vec()))
            .boxed()
    }
}

fn guarded<T: Clone + Send + 'static>(
    rx: Option<broadcast::Receiver<T>>,
    guard: InterestGuard,
) -> MarketStream<T> {
    let Some(rx) = rx else {
        return futures::stream::empty().boxed();
    };
    BroadcastStream::new(rx)
        .filter_map(move |r| {
            let _held = &guard;
            if let Err(BroadcastStreamRecvError::Lagged(n)) = &r {
                warn!(
                    symbol = %guard.key.0,
                    dropped = n,
                    "a rithmic stream fell behind; updates were dropped",
                );
            }
            futures::future::ready(r.ok())
        })
        .boxed()
}
