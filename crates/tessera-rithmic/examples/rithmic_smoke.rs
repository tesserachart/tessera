use std::time::Duration;

use futures::StreamExt;
use tessera_core::timeframe::Timeframe;
use tessera_market::{BarsRequest, MarketDataProvider, MarketRouter};
use tessera_rithmic::{RithmicLogin, RithmicMarket, RithmicOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = args.next().unwrap_or_else(|| "NQ".into());
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(5);

    let login = RithmicLogin::from_default_file()?;
    let opts = RithmicOptions::for_system(&login.system_name);
    println!("logging in to {} as app Tessera", login.system_name);
    let market = RithmicMarket::connect(login, opts).await?;
    println!(
        "provider {} ({}), health {:?}",
        market.id(),
        market.display_name(),
        market.health().status
    );

    let id = market.resolve(&root).await?;
    let (inst, spec) = market.spec(&id).await?;
    println!(
        "{root} -> {id}: {} · tick {} = {} {} · {} decimals · expiry {}",
        inst.name,
        spec.tick_size,
        spec.tick_value.amount,
        spec.currency,
        spec.price_decimals,
        spec.expiry.map_or("?".into(), |d| d.to_string())
    );

    let mut quotes = market.subscribe_quotes(std::slice::from_ref(&id))?;
    let mut trades = market.subscribe_trades(std::slice::from_ref(&id))?;
    let router = MarketRouter::new();
    router.add(market.clone())?;
    let mut depth = router.subscribe_depth(&id, 5)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    let (mut nq, mut nt, mut nb) = (0usize, 0usize, 0usize);
    let (mut buys, mut sells) = (0usize, 0usize);
    let mut last_book = None;
    let started = std::time::Instant::now();
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            Some(q) = quotes.next() => {
                nq += 1;
                if nq <= 3 {
                    println!(
                        "quote  {} x {}  /  {} x {}   last {}",
                        fmt(q.bid), fmt(q.bid_size), fmt(q.ask), fmt(q.ask_size), fmt(q.last)
                    );
                }
            }
            Some(t) = trades.next() => {
                nt += 1;
                match t.aggressor {
                    tessera_core::market::Aggressor::Buy => buys += 1,
                    tessera_core::market::Aggressor::Sell => sells += 1,
                    tessera_core::market::Aggressor::Unknown => {}
                }
                if nt <= 5 {
                    println!(
                        "trade  {} x {} {:?} ({:?}) at {}",
                        t.price, t.size, t.aggressor, t.aggressor_source, t.ts.to_rfc3339()
                    );
                }
            }
            Some(b) = depth.next() => {
                nb += 1;
                if nb == 1 {
                    println!("book built after {} ms", started.elapsed().as_millis());
                }
                last_book = Some(b);
            }
        }
    }
    println!(
        "{seconds}s: {nq} quotes, {nt} trades ({buys} buy / {sells} sell aggressor), \
         {nb} book snapshots"
    );
    if let Some(b) = last_book {
        println!("book at {}:", b.ts.to_rfc3339());
        for (bid, ask) in b.bids.iter().zip(b.asks.iter()) {
            println!(
                "  {:>6} ({:>3})  {:>10}  |  {:<10}  ({:>3}) {:<6}",
                bid.size.to_string(),
                bid.orders.unwrap_or(0),
                bid.price.to_string(),
                ask.price.to_string(),
                ask.orders.unwrap_or(0),
                ask.size.to_string()
            );
        }
    }
    drop((quotes, trades, depth));

    let mut live = market.subscribe_bars(&id, Timeframe::M5)?;
    for _ in 0..2 {
        match tokio::time::timeout(Duration::from_secs(15), live.next()).await {
            Ok(Some(lb)) => println!(
                "live 5m {}  o {} h {} l {} c {} v {}{}",
                lb.bar.t.to_rfc3339(),
                lb.bar.o,
                lb.bar.h,
                lb.bar.l,
                lb.bar.c,
                lb.bar.v,
                if lb.closed { " (closed)" } else { "" }
            ),
            _ => break,
        }
    }
    drop(live);

    let found = market.search("micro", None, 4).await?;
    println!(
        "search \"micro\": {}",
        found
            .iter()
            .map(|i| i.id.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );

    let bars = market
        .get_bars(BarsRequest::latest(id.clone(), Timeframe::M1, 120))
        .await?;
    println!(
        "{} 1m bars (last open: {}):",
        bars.bars.len(),
        bars.last_bar_open
    );
    for b in bars.bars.iter().rev().take(3).rev() {
        println!(
            "  {}  o {} h {} l {} c {} v {}",
            b.t.to_rfc3339(),
            b.o,
            b.h,
            b.l,
            b.c,
            b.v
        );
    }
    println!("templates sent: {:?}", market.template_counts());
    market.shutdown().await;
    Ok(())
}

fn fmt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map_or_else(|| "-".into(), |x| x.to_string())
}
