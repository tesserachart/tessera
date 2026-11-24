use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::StreamExt;
use tessera_core::InstrumentId;
use tessera_core::backoff::Backoff;
use tessera_core::market::DataSource;
use tessera_core::session::SessionCalendar;
use tokio::sync::{OnceCell, watch};
use tokio::time::Instant;

use crate::provider::{MarketDataProvider, MarketError, MarketStream};
use crate::router::{MarketRouter, source_of};

pub const REOPEN_MAX: Duration = Duration::from_secs(30);
pub const REOPEN_STEP: Duration = Duration::from_millis(100);
pub const SILENT_MAX: Duration = Duration::from_secs(30);
const REOPEN: Backoff = Backoff::new(REOPEN_STEP, REOPEN_MAX);

pub fn silent_for(since_heard: Duration, open_for: Option<Duration>) -> Option<Duration> {
    let quiet = since_heard.min(open_for?);
    (quiet >= SILENT_MAX).then_some(quiet)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Followed<T> {
    Item(T),
    Lost,
    Reopened(DataSource),
}

pub fn follow<T, F>(
    router: &Arc<MarketRouter>,
    instrument: &InstrumentId,
    open: F,
) -> Result<MarketStream<T>, MarketError>
where
    T: Send + 'static,
    F: FnMut(&MarketRouter, DataSource) -> Result<MarketStream<T>, MarketError> + Send + 'static,
{
    Ok(follow_marked(router, instrument, open)?
        .filter_map(|f| {
            futures::future::ready(match f {
                Followed::Item(x) => Some(x),
                Followed::Lost | Followed::Reopened(_) => None,
            })
        })
        .boxed())
}

pub fn follow_marked<T, F>(
    router: &Arc<MarketRouter>,
    instrument: &InstrumentId,
    mut open: F,
) -> Result<MarketStream<Followed<T>>, MarketError>
where
    T: Send + 'static,
    F: FnMut(&MarketRouter, DataSource) -> Result<MarketStream<T>, MarketError> + Send + 'static,
{
    let changes = router.changes();
    let provider = router.route(instrument)?;
    let first = open(router, source_of(provider.as_ref()))?;
    let state = Follow {
        router: Arc::clone(router),
        instrument: instrument.clone(),
        open,
        changes,
        current: Some(Opened::new(&provider, first)),
        retry_at: None,
        failures: 0,
        heard: None,
        calendar: OnceCell::new(),
    };
    Ok(futures::stream::unfold(state, Follow::next).boxed())
}

async fn open_for(
    router: &MarketRouter,
    instrument: &InstrumentId,
    calendar: &OnceCell<SessionCalendar>,
) -> Option<Duration> {
    let calendar = calendar
        .get_or_try_init(|| async { router.spec(instrument).await.map(|(_, spec)| spec.sessions) })
        .await;
    let (Ok(calendar), Ok(provider)) = (calendar, router.route(instrument)) else {
        return Some(Duration::MAX);
    };
    calendar.open_for(provider.health().checked_at)
}

struct Opened<T> {
    provider: Weak<dyn MarketDataProvider>,
    stream: MarketStream<T>,
}

impl<T> Opened<T> {
    fn new(provider: &Arc<dyn MarketDataProvider>, stream: MarketStream<T>) -> Self {
        Self {
            provider: Arc::downgrade(provider),
            stream,
        }
    }

    fn serving(&self, router: &MarketRouter, instrument: &InstrumentId) -> bool {
        router
            .route(instrument)
            .is_ok_and(|p| std::ptr::addr_eq(Arc::as_ptr(&p), self.provider.as_ptr()))
    }
}

struct Follow<T, F> {
    router: Arc<MarketRouter>,
    instrument: InstrumentId,
    open: F,
    changes: watch::Receiver<u64>,
    current: Option<Opened<T>>,
    retry_at: Option<Instant>,
    failures: u32,
    heard: Option<Instant>,
    calendar: OnceCell<SessionCalendar>,
}

impl<T, F> Follow<T, F>
where
    T: Send + 'static,
    F: FnMut(&MarketRouter, DataSource) -> Result<MarketStream<T>, MarketError> + Send + 'static,
{
    async fn next(mut self) -> Option<(Followed<T>, Self)> {
        loop {
            let Self {
                router,
                instrument,
                changes,
                current,
                retry_at,
                heard,
                ..
            } = &mut self;
            match current.as_mut() {
                Some(o) => {
                    let heard_at = heard.as_ref().map(|at| *at + SILENT_MAX);
                    tokio::select! {
                        item = o.stream.next() => match item {
                            Some(x) => {
                                *heard = Some(Instant::now());
                                self.failures = 0;
                                return Some((Followed::Item(x), self));
                            }
                            None => return self.lost_until_it_reconnects(),
                        },
                        () = tokio::time::sleep_until(heard_at.unwrap_or_else(Instant::now)), if heard_at.is_some() => {}
                        r = changes.changed() => {
                            r.ok()?;
                            if !o.serving(router, instrument) {
                                return self.lost_to_another_route();
                            }
                            continue;
                        }
                    }
                    let open = open_for(&self.router, &self.instrument, &self.calendar).await;
                    let since = self.heard.map_or(Duration::MAX, |at| at.elapsed());
                    if silent_for(since, open).is_some() {
                        return self.lost_until_it_reconnects();
                    }
                    let now = Instant::now();
                    self.heard = Some(open.and_then(|o| now.checked_sub(o)).unwrap_or(now));
                }
                None => {
                    match *retry_at {
                        Some(at) => tokio::select! {
                            r = changes.changed() => r.ok()?,
                            () = tokio::time::sleep_until(at) => {}
                        },
                        None => changes.changed().await.ok()?,
                    }
                    if let Some((o, source)) = self.reopen().await {
                        self.current = Some(o);
                        self.retry_at = None;
                        self.heard = None;
                        return Some((Followed::Reopened(source), self));
                    }
                    self.backoff();
                }
            }
        }
    }

    fn lost_until_it_reconnects(mut self) -> Option<(Followed<T>, Self)> {
        self.current = None;
        self.backoff();
        Some((Followed::Lost, self))
    }

    fn lost_to_another_route(mut self) -> Option<(Followed<T>, Self)> {
        self.current = None;
        self.retry_at = Some(Instant::now());
        Some((Followed::Lost, self))
    }

    fn backoff(&mut self) {
        let wait = match self.failures {
            0 => Duration::ZERO,
            n => REOPEN.delay(n),
        };
        self.retry_at = Some(Instant::now() + wait);
        self.failures += 1;
    }

    async fn reopen(&mut self) -> Option<(Opened<T>, DataSource)> {
        let provider = self.router.route_async(&self.instrument).await.ok()?;
        let source = source_of(provider.as_ref());
        let stream = (self.open)(&self.router, source.clone()).ok()?;
        Some((Opened::new(&provider, stream), source))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use tessera_core::capabilities::MarketCapabilities;
    use tessera_core::clock::ManualClock;
    use tessera_core::health::ProviderHealth;
    use tessera_core::instrument::{AssetClass, ContractSpec, Instrument};
    use tessera_core::market::{Quote, Trade};
    use tessera_core::settle::settle;
    use tessera_core::{Timeframe, Timestamp};
    use tokio::sync::{broadcast, mpsc};
    use tokio_stream::wrappers::BroadcastStream;

    use super::*;

    #[test]
    fn a_stream_is_silent_only_while_its_session_has_been_open_long_enough() {
        let long = SILENT_MAX + Duration::from_secs(5);
        assert_eq!(silent_for(long, Some(Duration::MAX)), Some(long));
        assert_eq!(
            silent_for(long, None),
            None,
            "a closed session is never silent"
        );
        assert_eq!(
            silent_for(long, Some(Duration::from_secs(10))),
            None,
            "a session open ten seconds counts ten seconds"
        );
        assert_eq!(
            silent_for(Duration::from_secs(5), Some(Duration::MAX)),
            None
        );
        assert_eq!(silent_for(SILENT_MAX, Some(SILENT_MAX)), Some(SILENT_MAX));
    }
    use crate::provider::{BarSeries, BarsRequest, LiveBar, MarketDataProvider};
    use crate::{MockConfig, MockMarket};

    struct Conn {
        id: &'static str,
        inner: MockMarket,
        quotes: parking_lot::Mutex<broadcast::Sender<Quote>>,
        opened: AtomicUsize,
    }

    impl Conn {
        fn new(id: &'static str) -> Arc<Self> {
            let clock = Arc::new(ManualClock::new(
                Timestamp::parse("2026-10-07T12:00:00-04:00").unwrap(),
            ));
            let mut cfg = MockConfig::new(clock);
            cfg.intraday_sessions = 1;
            cfg.daily_sessions = 1;
            Arc::new(Self {
                id,
                inner: MockMarket::new(cfg),
                quotes: parking_lot::Mutex::new(broadcast::channel(16).0),
                opened: AtomicUsize::new(0),
            })
        }

        fn send(&self, q: Quote) {
            let _ = self.quotes.lock().send(q);
        }

        fn receivers(&self) -> usize {
            self.quotes.lock().receiver_count()
        }

        fn drop_streams(&self) {
            *self.quotes.lock() = broadcast::channel(16).0;
        }
    }

    #[async_trait]
    impl MarketDataProvider for Conn {
        fn id(&self) -> &str {
            self.id
        }
        fn display_name(&self) -> &str {
            self.id
        }
        fn capabilities(&self) -> MarketCapabilities {
            MarketCapabilities {
                ..self.inner.capabilities()
            }
        }
        fn health(&self) -> ProviderHealth {
            ProviderHealth {
                provider_id: self.id.into(),
                ..self.inner.health()
            }
        }
        async fn search(
            &self,
            q: &str,
            class: Option<AssetClass>,
            limit: usize,
        ) -> Result<Vec<Instrument>, MarketError> {
            self.inner.search(q, class, limit).await
        }
        async fn resolve(&self, input: &str) -> Result<InstrumentId, MarketError> {
            self.inner.resolve(input).await
        }
        async fn spec(&self, id: &InstrumentId) -> Result<(Instrument, ContractSpec), MarketError> {
            self.inner.spec(id).await
        }
        async fn get_bars(&self, req: BarsRequest) -> Result<BarSeries, MarketError> {
            self.inner.get_bars(req).await
        }
        async fn quote(&self, id: &InstrumentId) -> Result<Quote, MarketError> {
            self.inner.quote(id).await
        }
        fn subscribe_quotes(&self, _: &[InstrumentId]) -> Result<MarketStream<Quote>, MarketError> {
            self.opened.fetch_add(1, Ordering::SeqCst);
            Ok(BroadcastStream::new(self.quotes.lock().subscribe())
                .filter_map(|q| std::future::ready(q.ok()))
                .boxed())
        }
        fn subscribe_trades(&self, _: &[InstrumentId]) -> Result<MarketStream<Trade>, MarketError> {
            Ok(futures::stream::pending().boxed())
        }
        fn subscribe_bars(
            &self,
            _: &InstrumentId,
            _: Timeframe,
        ) -> Result<MarketStream<LiveBar>, MarketError> {
            Ok(futures::stream::pending().boxed())
        }
    }

    fn followed(router: &Arc<MarketRouter>, id: &InstrumentId) -> mpsc::UnboundedReceiver<Quote> {
        let ids = vec![id.clone()];
        let mut s = follow(router, id, move |r, _| r.subscribe_quotes(&ids)).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(q) = s.next().await {
                if tx.send(q).is_err() {
                    return;
                }
            }
        });
        rx
    }

    async fn next_from(
        conn: &Conn,
        id: &InstrumentId,
        rx: &mut mpsc::UnboundedReceiver<Quote>,
    ) -> String {
        let q = conn.inner.quote(id).await.unwrap();
        let mut from = None;
        settle(
            &format!("a quote from {}", conn.id),
            || {
                conn.send(q.clone());
                while let Ok(got) = rx.try_recv() {
                    from = got.source.map(|s| s.provider);
                }
                from.clone()
            },
            |from| from.as_deref() == Some(conn.id),
        )
        .await
        .expect("a quote from the connection")
    }

    #[tokio::test]
    async fn a_removed_connection_is_followed_to_the_one_added_after_it() {
        let router = MarketRouter::new();
        let first = Conn::new("first");
        router.add(first.clone()).unwrap();
        let nq = router.resolve("NQ").await.unwrap();
        let mut rx = followed(&router, &nq);
        assert_eq!(next_from(&first, &nq, &mut rx).await, "first");

        router.remove("first");
        let again = Conn::new("again");
        router.add(again.clone()).unwrap();
        assert_eq!(next_from(&again, &nq, &mut rx).await, "again");
        assert_eq!(first.receivers(), 0);
    }

    #[tokio::test]
    async fn another_connection_coming_leaves_a_serving_stream_alone() {
        let router = MarketRouter::new();
        let first = Conn::new("first");
        router.add(first.clone()).unwrap();
        let nq = router.resolve("NQ").await.unwrap();
        let mut rx = followed(&router, &nq);
        assert_eq!(next_from(&first, &nq, &mut rx).await, "first");
        router.add(Conn::new("other")).unwrap();
        assert_eq!(next_from(&first, &nq, &mut rx).await, "first");
        assert_eq!(first.opened.load(Ordering::SeqCst), 1);
    }

    fn marked(
        router: &Arc<MarketRouter>,
        id: &InstrumentId,
    ) -> mpsc::UnboundedReceiver<Followed<Quote>> {
        let ids = vec![id.clone()];
        let mut s = follow_marked(router, id, move |r, _| r.subscribe_quotes(&ids)).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(q) = s.next().await {
                if tx.send(q).is_err() {
                    return;
                }
            }
        });
        rx
    }

    async fn next_mark(rx: &mut mpsc::UnboundedReceiver<Followed<Quote>>) -> Followed<Quote> {
        settle(
            "a mark",
            || loop {
                match rx.try_recv() {
                    Ok(Followed::Item(_)) => {}
                    Ok(mark) => return Some(mark),
                    Err(mpsc::error::TryRecvError::Empty) => return None,
                    Err(mpsc::error::TryRecvError::Disconnected) => panic!("the follower ended"),
                }
            },
            Option::is_some,
        )
        .await
        .expect("a mark")
    }

    fn label(provider: &str) -> DataSource {
        DataSource {
            provider: provider.into(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_stream_that_ends_is_marked_lost_and_opened_again_on_its_connection() {
        let router = MarketRouter::new();
        let first = Conn::new("first");
        router.add(first.clone()).unwrap();
        let nq = router.resolve("NQ").await.unwrap();
        let mut rx = marked(&router, &nq);
        let q = first.inner.quote(&nq).await.unwrap();
        tokio::task::yield_now().await;
        first.send(q.clone());
        assert!(matches!(rx.recv().await, Some(Followed::Item(_))));

        first.drop_streams();
        assert_eq!(next_mark(&mut rx).await, Followed::Lost);
        assert_eq!(next_mark(&mut rx).await, Followed::Reopened(label("first")));
        assert_eq!(first.opened.load(Ordering::SeqCst), 2);
        first.send(q.clone());
        assert!(matches!(rx.recv().await, Some(Followed::Item(_))));

        for _ in 0..4 {
            first.drop_streams();
            assert_eq!(next_mark(&mut rx).await, Followed::Lost);
            assert_eq!(next_mark(&mut rx).await, Followed::Reopened(label("first")));
        }
        let before = tokio::time::Instant::now();
        first.drop_streams();
        assert_eq!(next_mark(&mut rx).await, Followed::Lost);
        assert_eq!(next_mark(&mut rx).await, Followed::Reopened(label("first")));
        assert!(
            before.elapsed() >= REOPEN_STEP * 8,
            "{:?}",
            before.elapsed()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_removed_connection_is_marked_lost_before_anything_replaces_it() {
        let router = MarketRouter::new();
        let first = Conn::new("first");
        router.add(first.clone()).unwrap();
        let nq = router.resolve("NQ").await.unwrap();
        let mut rx = marked(&router, &nq);
        tokio::task::yield_now().await;

        router.remove("first");
        assert_eq!(next_mark(&mut rx).await, Followed::Lost);
        tokio::time::sleep(REOPEN_MAX * 2).await;
        assert!(rx.try_recv().is_err());

        let again = Conn::new("first");
        router.add(again.clone()).unwrap();
        assert_eq!(next_mark(&mut rx).await, Followed::Reopened(label("first")));
        assert_eq!(again.opened.load(Ordering::SeqCst), 1);
        assert_eq!(first.receivers(), 0);
    }

    #[tokio::test]
    async fn a_connection_replaced_under_its_id_is_followed() {
        let router = MarketRouter::new();
        let first = Conn::new("same");
        router.add(first.clone()).unwrap();
        let nq = router.resolve("NQ").await.unwrap();
        let mut rx = followed(&router, &nq);
        assert_eq!(next_from(&first, &nq, &mut rx).await, "same");

        router.remove("same");
        let again = Conn::new("same");
        router.add(again.clone()).unwrap();
        assert_eq!(next_from(&again, &nq, &mut rx).await, "same");
        assert_eq!(again.opened.load(Ordering::SeqCst), 1);
        assert_eq!(first.receivers(), 0);
    }

    #[tokio::test]
    async fn a_stream_follows_its_instrument_bound_afresh_to_another_connection() {
        let router = MarketRouter::new();
        let (apex, bulenox) = (Conn::new("apex"), Conn::new("bulenox"));
        router.add(apex.clone()).unwrap();
        router.add(bulenox.clone()).unwrap();
        let nq = router.resolve("NQ").await.unwrap();
        let mut rx = followed(&router, &nq);
        assert_eq!(next_from(&apex, &nq, &mut rx).await, "apex");

        let route = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(e, c)| ((*e).to_owned(), (*c).to_owned()))
                .collect()
        };
        router.set_exchange_choices(route(&[("CME", "bulenox")]));
        assert_eq!(next_from(&bulenox, &nq, &mut rx).await, "bulenox");
        assert_eq!(router.binding(&nq).as_deref(), Some("bulenox"));
        assert_eq!(apex.receivers(), 0, "the other login's stream was let go");

        router.set_exchange_choices(route(&[("CME", "bulenox"), ("COMEX", "bulenox")]));
        assert_eq!(next_from(&bulenox, &nq, &mut rx).await, "bulenox");
        assert_eq!(bulenox.opened.load(Ordering::SeqCst), 1);

        router.set_exchange_choices(BTreeMap::new());
        assert_eq!(next_from(&apex, &nq, &mut rx).await, "apex");
        assert_eq!(bulenox.receivers(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_change_during_the_first_opening_is_not_missed() {
        let router = MarketRouter::new();
        let first = Conn::new("first");
        router.add(first.clone()).unwrap();
        let nq = router.resolve("NQ").await.unwrap();
        let ids = vec![nq.clone()];
        let mut first_opening = true;
        let s = follow_marked(&router, &nq, move |r, _| {
            let stream = r.subscribe_quotes(&ids);
            if std::mem::take(&mut first_opening) {
                r.remove("first");
            }
            stream
        })
        .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        tokio::spawn(s.for_each(move |f| {
            let _ = tx.send(f);
            std::future::ready(())
        }));
        assert_eq!(next_mark(&mut rx).await, Followed::Lost);
        router.add(Conn::new("again")).unwrap();
        assert_eq!(next_mark(&mut rx).await, Followed::Reopened(label("again")));
        assert_eq!(first.receivers(), 0);
    }

    #[tokio::test]
    async fn a_stream_nothing_serves_fails_at_once() {
        let router = MarketRouter::new();
        let nq = InstrumentId::new("NQZ6.CME").unwrap();
        let out = follow(&router, &nq, |r, _| r.subscribe_quotes(&[]));
        assert!(out.is_err());
    }
}
