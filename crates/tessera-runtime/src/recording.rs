use std::sync::{Arc, Weak};
use std::time::Duration;

use tessera_core::InstrumentId;
use tessera_market::hub::MarketHub;
use tessera_market::{MarketDataProvider, MarketRouter};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::settings::SettingsService;

pub const SETTING: &str = "market.recordWatchlists";
const RESOLVE_EVERY: Duration = Duration::from_secs(60);

pub fn spawn(
    hub: Arc<MarketHub>,
    market: Arc<MarketRouter>,
    settings: &Arc<SettingsService>,
) -> JoinHandle<()> {
    let changed = Arc::new(Notify::new());
    {
        let changed = Arc::clone(&changed);
        settings.on_change(move |key, _| {
            if key == SETTING || key == tessera_protocol::watchlists::KEY {
                changed.notify_one();
            }
        });
    }
    let settings = Arc::downgrade(settings);
    let mut connections = market.changes();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(RESOLVE_EVERY);
        loop {
            tokio::select! {
                _ = every.tick() => {}
                _ = changed.notified() => {}
                r = connections.changed() => if r.is_err() { return },
            }
            let Some(wanted) = wanted(&settings, &market).await else {
                return;
            };
            hub.keep_recording(&wanted);
        }
    })
}

async fn wanted(
    settings: &Weak<SettingsService>,
    market: &MarketRouter,
) -> Option<Vec<InstrumentId>> {
    let (on, symbols) = {
        let s = settings.upgrade()?;
        let on = s.value(SETTING).and_then(|v| v.as_bool()).unwrap_or(true);
        let lists = s
            .value(tessera_protocol::watchlists::KEY)
            .map(|v| crate::watchlists::read(&v))
            .unwrap_or_default();
        (
            on,
            lists
                .into_iter()
                .flat_map(|l| l.symbols)
                .collect::<Vec<_>>(),
        )
    };
    let mut out = Vec::new();
    if !on {
        return Some(out);
    }
    for symbol in symbols {
        if let Ok(id) = market.resolve(&symbol).await
            && !out.contains(&id)
        {
            out.push(id);
        }
    }
    Some(out)
}
