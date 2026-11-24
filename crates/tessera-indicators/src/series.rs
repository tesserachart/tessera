use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};
use tessera_core::Timestamp;
use tessera_host::{
    BusEvent, KeyFilter, Pumps, Subscribed, TopicHandler, TopicKey, TopicSizing, parse_params,
};
use tessera_market::hub::{PumpKey, footprint_key};
use tessera_market::io::{BarUpdate, FootprintUpdate, SessionFilter};
use tessera_market::orderflow::flow::Sides;
use tessera_market::{MarketDataProvider, refusal};
use tessera_protocol::rpc::{RpcError, codes};
use tessera_protocol::tools::ToolErrorCode;
use tessera_protocol::topics::names;
use tessera_tools::ToolError;
use tokio::sync::broadcast;

use crate::cache::{FrameCell, FrameKey, Resolved, Watcher};
use crate::frame::{Asked, BarKind, Published, Replaced, StudyId, StudyKey, WatchKey};
use crate::io::{Replaces, SeriesColumn, SeriesError, SeriesParams, SeriesUpdate};
use crate::service::IndicatorsService;
use crate::studies::Failed;

pub const SERIES_TOPIC: &str = "indicators.series";
const EVERY_SECOND: Duration = Duration::from_secs(1);

fn epoch_ms(ns: i64) -> f64 {
    (ns as f64 / 1e6).round()
}

fn f64s(values: impl Iterator<Item = f64>) -> String {
    let bytes: Vec<u8> = values.flat_map(f64::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

fn column(values: &[f64]) -> Option<String> {
    values
        .iter()
        .any(|v| !v.is_nan())
        .then(|| f64s(values.iter().copied()))
}

pub(crate) fn update_of(key: &FrameKey, provider: &str, p: &Published) -> SeriesUpdate {
    let c = &p.change;
    SeriesUpdate {
        indicator: p.indicator.clone(),
        version: p.version,
        instrument: key.instrument.clone(),
        tf: p.tf,
        rev: p.rev,
        replaces: match c.replaces {
            Replaced::All => Replaces::All,
            Replaced::Span { from, to } => Replaces::Span {
                from: Timestamp(from),
                to: Timestamp(to),
            },
        },
        time: f64s(c.time.iter().map(|t| epoch_ms(*t))),
        columns: c
            .columns
            .iter()
            .map(|(k, v)| SeriesColumn {
                key: k.clone(),
                values: column(v),
            })
            .collect(),
        objects: c.drawn.as_ref().map(|d| d.objects.clone()),
        aggressor_source: c.facts.aggressor,
        loaded: c.facts.loaded,
        filling: c.facts.filling,
        error: c.error.as_ref().map(|e| SeriesError {
            message: e.to_string(),
            line: e.line(),
        }),
        provider: provider.to_owned(),
        compute_ms: c.compute_ms,
    }
}

fn watch_key(
    key: &FrameKey,
    indicator: &str,
    version: Option<u32>,
    used: &Map<String, Value>,
) -> WatchKey {
    let bars = match key.bars {
        BarKind::Time(tf) => json!(tf),
        BarKind::Print(kind) => json!(kind),
    };
    let canonical = json!({
        "s": key.instrument,
        "tf": bars,
        "h": key.session,
        "i": indicator,
        "v": version,
        "in": used,
    });
    WatchKey(format!(
        "series:{}",
        tessera_core::hash::hash_json(&canonical)
    ))
}

pub(crate) struct SeriesTopic {
    svc: Arc<IndicatorsService>,
    followers: Pumps<FrameKey>,
}

impl SeriesTopic {
    pub(crate) fn new(svc: Arc<IndicatorsService>) -> Self {
        Self {
            svc,
            followers: Pumps::new(),
        }
    }
}

fn watch_refusal(e: ToolError) -> RpcError {
    let code = match e.code {
        ToolErrorCode::Unavailable => codes::UNAVAILABLE,
        _ => codes::INTERNAL_ERROR,
    };
    RpcError::new(code, e.message)
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(codes::INVALID_PARAMS, message.into())
}

#[async_trait]
impl TopicHandler for SeriesTopic {
    fn name(&self) -> &'static str {
        SERIES_TOPIC
    }

    fn sizing(&self) -> TopicSizing {
        TopicSizing::MARKET
    }

    async fn subscribe(&self, params: Value) -> Result<Subscribed, RpcError> {
        let p: SeriesParams = parse_params(params)?;
        let instrument = self
            .svc
            .market()
            .resolve(&p.instrument)
            .await
            .map_err(|e| refusal(e, codes::INVALID_PARAMS))?;
        let key = match p.print_bars {
            Some(kind) => FrameKey {
                instrument,
                bars: BarKind::Print(kind),
                session: SessionFilter::All,
            },
            None => FrameKey {
                instrument,
                bars: BarKind::Time(p.tf),
                session: p.session.unwrap_or_default(),
            },
        };
        let grid = self.svc.grid(&key).await;
        let inputs = p.inputs.unwrap_or_default();
        let (study, described) = self
            .svc
            .resolve(&p.indicator, p.version, &inputs)
            .await
            .map_err(|e| invalid(e.message))?;
        let watch = watch_key(&key, &p.indicator, p.version, &described.used);
        let asked = Asked {
            indicator: p.indicator,
            tf: p.tf,
            version: p.version,
            inputs,
        };
        let cell = self.svc.cache().cell(&key, grid);
        let catch_up = !cell.is_followed();
        let svc = Arc::clone(&self.svc);
        let follower = self.followers.acquire(key.clone(), || {
            let bus = svc.bus();
            let feeds = Feeds {
                bars: bus.subscribe(names::MARKET_BARS).map(|(rx, _)| rx),
                footprints: bus.subscribe(names::MARKET_FOOTPRINT).map(|(rx, _)| rx),
            };
            Ok::<_, std::convert::Infallible>(tokio::spawn(follow(svc, cell, feeds)))
        });
        let follower = match follower {
            Ok(g) => g,
            Err(never) => match never {},
        };
        let watching = self
            .svc
            .cache()
            .watch(
                &key,
                grid,
                study,
                Watcher {
                    watch: watch.clone(),
                    asked,
                    from: p.from.map(|t| t.0),
                    catch_up,
                },
            )
            .await
            .map_err(watch_refusal)?;
        watching.guard.cell().wake.notify_one();
        let snapshot = update_of(&key, &watching.provider, &watching.snapshot);
        Ok(Subscribed::new(KeyFilter::Id(watch.0))
            .snapshot(&snapshot)
            .keep(watching.guard)
            .keep(follower))
    }
}

async fn recv(
    rx: &mut Option<broadcast::Receiver<Arc<BusEvent>>>,
) -> Result<Arc<BusEvent>, broadcast::error::RecvError> {
    match rx.as_mut() {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

fn failed(id: &str, message: String) -> Resolved {
    Resolved {
        key: StudyKey {
            id: StudyId::Custom {
                id: id.to_owned(),
                version: 0,
            },
            params: message.clone(),
        },
        study: Arc::new(Failed(message)),
    }
}

async fn rebind(svc: &IndicatorsService, cell: &Arc<FrameCell>, id: &str) {
    let cache = svc.cache();
    for (watch, asked) in cache.watched_custom(cell).await {
        if asked.indicator != id {
            continue;
        }
        let study = match svc
            .resolve(&asked.indicator, asked.version, &asked.inputs)
            .await
        {
            Ok((r, _)) => r,
            Err(e) => failed(id, e.message),
        };
        cache.rebind(cell, watch, study).await;
    }
}

struct Feeds {
    bars: Option<broadcast::Receiver<Arc<BusEvent>>>,
    footprints: Option<broadcast::Receiver<Arc<BusEvent>>>,
}

async fn follow(svc: Arc<IndicatorsService>, cell: Arc<FrameCell>, feeds: Feeds) {
    let cache = Arc::clone(svc.cache());
    let _following = cell.followed();
    let key = cell.key.clone();
    let hub = cache.hub().cloned();
    let _feed = hub.as_ref().and_then(|h| {
        let feed = match key.bars {
            BarKind::Time(tf) => PumpKey::Bars(key.instrument.clone(), tf),
            BarKind::Print(_) => PumpKey::Trades(key.instrument.clone()),
        };
        h.acquire(feed).ok()
    });
    let Feeds {
        bars: mut live,
        mut footprints,
    } = feeds;
    let mut routes = cache.router().changes();
    let mut catalog = svc.subscribe_changes();
    let tf = key.tf();
    let bars_key = tf.map(|tf| TopicKey::Bars(key.instrument.clone(), tf));
    let flow_key = tf.map(|tf| TopicKey::Id(footprint_key(&key.instrument, tf, 1)));
    let mut every_second = tokio::time::interval(EVERY_SECOND);
    every_second.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut flow_feed = None;
    let mut filled = None;
    loop {
        let wants_flow = hub.is_some() && tf.is_some() && cache.wants_flow(&cell).await;
        if wants_flow != flow_feed.is_some() {
            flow_feed = tf.filter(|_| wants_flow).and_then(|tf| {
                hub.as_ref().and_then(|h| {
                    h.acquire(PumpKey::Footprint(key.instrument.clone(), tf, 1))
                        .ok()
                })
            });
        }
        if wants_flow && filled.is_none() {
            filled = hub.as_ref().and_then(|h| h.prints_filled(&key.instrument));
        }
        if wants_flow
            && let Some(h) = hub.as_ref()
            && cache.flow_filling(&cell).await
            && !h.pulling(&key.instrument)
        {
            cache.refill(&cell).await;
        }
        let due = cache.next_due(&cell).await;
        tokio::select! {
            ev = recv(&mut live) => match ev {
                Ok(ev) if Some(&ev.key) == bars_key.as_ref() => {
                    let Ok(u) = serde_json::from_str::<BarUpdate>(ev.data.get()) else {
                        continue;
                    };
                    match key.session {
                        SessionFilter::All => cache.on_bar(&cell, u.bar, u.closed).await,
                        SessionFilter::Rth if u.closed => {
                            let _ = cache.refresh(&cell, true).await;
                        }
                        SessionFilter::Rth => {}
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    cache.lagged(&cell).await;
                }
                Err(broadcast::error::RecvError::Closed) => live = None,
            },
            ev = recv(&mut footprints), if wants_flow => match ev {
                Ok(ev) if Some(&ev.key) == flow_key.as_ref() => {
                    if let Ok(u) = serde_json::from_str::<FootprintUpdate>(ev.data.get()) {
                        cache.on_flow(&cell, u.bar.t.0, Sides::of_update(&u.bar)).await;
                    }
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => footprints = None,
            },
            () = cell.wake.notified() => {
                if let Err(e) = cache.refresh(&cell, false).await {
                    tracing::debug!(error = %e.message, "indicators: a corrected span was not read");
                }
            }
            r = routes.changed() => match r {
                Ok(()) => {
                    let _ = cache.refresh(&cell, true).await;
                }
                Err(_) => std::future::pending::<()>().await,
            },
            r = catalog.recv() => match r {
                Ok(id) => rebind(&svc, &cell, &id).await,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    for (_, asked) in cache.watched_custom(&cell).await {
                        rebind(&svc, &cell, &asked.indicator).await;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => std::future::pending::<()>().await,
            },
            r = async {
                match filled.as_mut() {
                    Some(f) => f.changed().await,
                    None => std::future::pending().await,
                }
            }, if wants_flow => match r {
                Ok(()) => cache.refill(&cell).await,
                Err(_) => filled = None,
            },
            () = async {
                match due {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => cache.advance(&cell).await,
            _ = every_second.tick() => {
                match key.bars {
                    BarKind::Print(_) => {
                        if let Err(e) = cache.rebuild(&cell).await {
                            tracing::debug!(error = %e.message, "indicators: print bars were not built");
                        }
                    }
                    BarKind::Time(_) if wants_flow => cache.flow_tail(&cell).await,
                    BarKind::Time(_) => {}
                }
                cache.settle_opening(&cell, None).await;
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use tessera_core::{InstrumentId, Timeframe};
    use tessera_market::io::SessionFilter;

    use super::*;
    use crate::frame::{BarKind, Change};

    #[test]
    fn bar_times_leave_in_the_epoch_ms_the_desk_rounds_them_to() {
        let print_times = [
            1_791_313_200_123_456_789_i64,
            1_791_313_200_123_500_000,
            1_791_313_200_124_499_999,
            1_791_313_200_999_999_999,
        ];
        let published = Published {
            watch: WatchKey("w".into()),
            indicator: "sma".into(),
            tf: Timeframe::M1,
            version: None,
            rev: 1,
            change: Arc::new(Change {
                replaces: Replaced::All,
                time: print_times.to_vec(),
                columns: Vec::new(),
                drawn: None,
                facts: crate::frame::Facts::default(),
                error: None,
                compute_ms: 0.0,
            }),
        };
        let key = FrameKey {
            instrument: InstrumentId::new("NQZ6.CME").unwrap(),
            bars: BarKind::Print(tessera_core::timeframe::PrintBars::Tick { size: 1 }),
            session: SessionFilter::All,
        };
        let u = update_of(&key, "mock", &published);
        let sent: Vec<f64> = STANDARD
            .decode(u.time)
            .unwrap()
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| f64::from_le_bytes(*b))
            .collect();
        let desk_reads = [
            1_791_313_200_123.0,
            1_791_313_200_124.0,
            1_791_313_200_125.0,
            1_791_313_201_000.0,
        ];
        assert_eq!(sent, desk_reads, "Math.round(ns / 1e6) of the JSON number");
    }
}
