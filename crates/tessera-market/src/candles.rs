use std::sync::Arc;

use tessera_core::instrument::ContractSpec;
use tessera_core::{InstrumentId, Timeframe, Timestamp};

use crate::history::Read;
use crate::io::{ContractRun, SessionFilter};
use crate::provider::{BarSeries, BarsRequest, MarketDataProvider, MarketError};
use crate::roll::front_month_bars;
use crate::router::MarketRouter;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandlesAsk {
    pub instrument: InstrumentId,
    pub tf: Timeframe,
    pub from: Option<Timestamp>,
    pub to: Option<Timestamp>,
    pub limit: usize,
    pub session: SessionFilter,
    pub front_months: bool,
}

pub struct Candles {
    pub series: BarSeries,
    pub contracts: Option<Vec<ContractRun>>,
    pub provider: Arc<dyn MarketDataProvider>,
    pub spec: ContractSpec,
}

pub async fn candles(
    router: &MarketRouter,
    ask: CandlesAsk,
    read: Read,
    now: Timestamp,
) -> Result<Candles, MarketError> {
    let provider = router.route_async(&ask.instrument).await?;
    let (_, spec) = provider.spec(&ask.instrument).await?;
    let req = BarsRequest {
        instrument: ask.instrument,
        tf: ask.tf,
        from: ask.from,
        to: ask.to,
        limit: Some(ask.limit),
        rth_only: ask.session == SessionFilter::Rth,
    };
    let (series, contracts) = if ask.front_months {
        let today = spec.sessions.trade_date(now);
        let out = front_month_bars(router, &provider, req, read, today).await?;
        (out.series, out.contracts)
    } else {
        (router.bars_from(&provider, req, read).await?, None)
    };
    Ok(Candles {
        series,
        contracts,
        provider,
        spec,
    })
}
