use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::NaiveDate;
use parking_lot::Mutex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::SharedClock;
use tessera_store::ticks::TickStore;
use ts_rs::TS;

use crate::provider::{HistoryUse, MarketDataProvider};
use crate::router::MarketRouter;

pub const COUNT_EVERY: Duration = Duration::from_secs(60);
pub const WEEK_DAYS: i64 = 7;

/// What one connection's history service sent, so a login's data allowance can be watched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPulled {
    /// The connection.
    pub source: String,
    /// Today (UTC).
    pub today: HistoryUse,
    /// The last seven days (UTC), today included.
    pub week: HistoryUse,
    /// Every day this machine counted.
    pub total: HistoryUse,
}

type Instance = (String, usize);

pub struct HistoryMeter {
    router: Arc<MarketRouter>,
    store: Arc<TickStore>,
    clock: SharedClock,
    seen: Mutex<HashMap<Instance, HistoryUse>>,
}

impl std::fmt::Debug for HistoryMeter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HistoryMeter").finish_non_exhaustive()
    }
}

fn instance(p: &Arc<dyn MarketDataProvider>) -> Instance {
    (p.id().to_owned(), Arc::as_ptr(p).cast::<()>() as usize)
}

impl HistoryMeter {
    pub fn new(router: Arc<MarketRouter>, store: Arc<TickStore>, clock: SharedClock) -> Arc<Self> {
        Arc::new(Self {
            router,
            store,
            clock,
            seen: Mutex::default(),
        })
    }

    fn today(&self) -> NaiveDate {
        self.clock.now().to_datetime().date_naive()
    }

    pub fn count(&self) -> tessera_store::Result<()> {
        let day = self.today();
        let fresh: Vec<(String, HistoryUse)> = {
            let mut seen = self.seen.lock();
            self.router
                .providers()
                .iter()
                .filter_map(|p| {
                    let now = p.history_use();
                    let before = seen.insert(instance(p), now).unwrap_or_default();
                    let fresh = now.since(before);
                    (fresh != HistoryUse::default()).then(|| (p.id().to_owned(), fresh))
                })
                .collect()
        };
        for (source, used) in fresh {
            self.store
                .add_history_use(&source, day, used.requests, used.bytes)?;
        }
        Ok(())
    }

    pub fn pulled(&self) -> tessera_store::Result<Vec<HistoryPulled>> {
        self.count()?;
        let today = self.today();
        let week_from = today - chrono::Duration::days(WEEK_DAYS - 1);
        let mut out: Vec<HistoryPulled> = Vec::new();
        for d in self.store.history_use()? {
            let used = HistoryUse {
                requests: d.requests,
                bytes: d.bytes,
            };
            if out.last().is_none_or(|p| p.source != d.source) {
                out.push(HistoryPulled {
                    source: d.source.clone(),
                    today: HistoryUse::default(),
                    week: HistoryUse::default(),
                    total: HistoryUse::default(),
                });
            }
            let p = out.last_mut().expect("pushed above");
            p.total.add(used);
            if d.day >= week_from {
                p.week.add(used);
            }
            if d.day == today {
                p.today.add(used);
            }
        }
        Ok(out)
    }

    pub fn spawn(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let meter = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(COUNT_EVERY).await;
                let Some(m) = meter.upgrade() else { return };
                let counted = tokio::task::spawn_blocking(move || m.count()).await;
                if let Ok(Err(e)) = counted {
                    tracing::warn!(error = %e, "history use was not counted");
                }
            }
        })
    }
}
