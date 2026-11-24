use rithmic_rs::rti::messages::RithmicMessage;
use rithmic_rs::rti::{BestBidOffer, ResponseDepthByOrderSnapshot};
use tessera_core::market::Aggressor;
use tessera_core::money::{Price, Qty};
use tessera_core::session::SessionCalendar;
use tessera_core::time::{NANOS_PER_MINUTE, Timestamp};
use tessera_core::timeframe::Timeframe;
use tessera_rithmic::book::BookFeed;
use tessera_rithmic::frames;
use tessera_rithmic::history::finish;
use tessera_rithmic::map::{self, BarUnit, QuoteState};
use tessera_rithmic::symbols;

mod synthetic;

fn p(s: &str) -> Price {
    s.parse().unwrap()
}

#[test]
fn front_month_and_reference_data_map_to_a_rithmic_contract() {
    let msgs = synthetic::recording();
    let front = msgs
        .iter()
        .find_map(|m| match m {
            RithmicMessage::ResponseFrontMonthContract(f) => Some(f),
            _ => None,
        })
        .unwrap();
    let id = symbols::instrument_id(
        front.trading_symbol.as_deref().unwrap(),
        front.trading_exchange.as_deref().unwrap(),
    );
    assert_eq!(id.as_str(), "ESZ6.CME-RITHMIC");
    let reference = msgs
        .iter()
        .find_map(|m| match m {
            RithmicMessage::ResponseReferenceData(r) => Some(r),
            _ => None,
        })
        .unwrap();
    let (inst, spec) = symbols::spec_from_reference("ESZ6", "CME", Some(reference), true, 2026);
    assert_eq!(inst.id, id);
    assert_eq!(inst.name, "E-mini S&P 500 Dec 2026");
    assert_eq!(inst.root.as_deref(), Some("ES"));
    assert!(inst.is_front);
    assert_eq!(spec.tick_size, p("0.25"));
    assert_eq!(spec.multiplier, "50".parse().unwrap());
    assert_eq!(spec.tick_value.amount, "12.5".parse().unwrap());
    assert_eq!(spec.price_decimals, 2);
    assert_eq!(
        spec.expiry.map(|d| d.to_string()).as_deref(),
        Some("2026-12-18")
    );
    assert_eq!(
        spec.last_trade,
        Some(Timestamp::parse("2026-12-18T09:30:00-05:00").unwrap())
    );
    assert_eq!(spec.sessions, SessionCalendar::CmeEquityIndex);
}

#[test]
fn every_print_carries_the_exchange_aggressor_on_the_tick_grid() {
    let id = symbols::instrument_id("ESZ6", "CME");
    let msgs = synthetic::recording();
    let prints: Vec<_> = msgs
        .iter()
        .filter_map(|m| match m {
            RithmicMessage::LastTrade(t) => map::trade(&id, t, map::Grid::default()),
            _ => None,
        })
        .collect();
    assert!(prints.len() > 50, "{} prints", prints.len());
    let snapshots = msgs
        .iter()
        .filter(|m| matches!(m, RithmicMessage::LastTrade(t) if t.is_snapshot == Some(true)))
        .count();
    assert_eq!(snapshots, 1, "the subscription snapshot is not a print");
    let (spec_tick, mut buys, mut sells) = (p("0.25"), 0, 0);
    for (a, b) in prints.iter().zip(prints.iter().skip(1)) {
        assert!(b.ts >= a.ts, "prints arrive in exchange-time order");
    }
    for t in &prints {
        assert_eq!(t.price.0 % spec_tick.0, rust_decimal::Decimal::ZERO);
        assert!(t.size > Qty::ZERO);
        match t.aggressor {
            Aggressor::Buy => buys += 1,
            Aggressor::Sell => sells += 1,
            Aggressor::Unknown => panic!("a live print without an aggressor flag"),
        }
    }
    assert!(buys > 0 && sells > 0);
    assert!(prints.iter().all(|t| t.order_key.is_some()));
    let pairs = prints.windows(2);
    let joined = pairs
        .clone()
        .filter(|w| w[0].order_key == w[1].order_key)
        .count();
    assert!(joined > 50, "{joined} fills joined to the print before");
    assert!(
        pairs
            .clone()
            .filter(|w| w[0].order_key == w[1].order_key)
            .all(|w| w[0].ts == w[1].ts && w[0].aggressor == w[1].aggressor)
    );
    assert!(
        pairs.clone().any(|w| w[0].ts == w[1].ts
            && w[0].aggressor == w[1].aggressor
            && w[0].order_key != w[1].order_key),
        "two orders at one time"
    );
    let mut agg = tessera_market::orderflow::big_trades::OrderAggregator::new(
        p("0.25"),
        tessera_market::orderflow::big_trades::Grouping::default(),
    );
    let mut events: Vec<_> = prints.iter().filter_map(|t| agg.push(t)).collect();
    events.extend(agg.finish());
    let orders: u32 = events.iter().map(|e| e.orders).sum();
    assert_eq!(
        orders as usize,
        prints.len() - joined,
        "every order counted once"
    );
    assert!(
        events.len() < prints.len() - joined,
        "some orders continue others"
    );
    assert!(
        events
            .iter()
            .any(|e| e.orders > 1 && e.last_t.0 - e.t.0 > 0)
    );
}

#[test]
fn the_mbo_book_matches_the_bbo_feed() {
    let mut feed = BookFeed::default();
    let mut frames: Vec<ResponseDepthByOrderSnapshot> = Vec::new();
    let mut quote = QuoteState::default();
    let (mut checked, mut exact, mut prices) = (0, 0, 0);
    let mut price_moves = 0;
    let mut buffered = 0;
    for m in synthetic::recording() {
        match m {
            RithmicMessage::ResponseDepthByOrderSnapshot(f) => {
                let last = f.depth_side.is_none();
                frames.push(f);
                if last {
                    feed.on_snapshot(&frames, map::Grid::default());
                }
            }
            RithmicMessage::DepthByOrder(u) => {
                price_moves += u.prev_depth_price_flag.iter().filter(|f| **f).count();
                if feed.book().is_none() {
                    buffered += 1;
                }
                feed.on_update(u).unwrap();
            }
            RithmicMessage::BestBidOffer(b) => {
                quote.apply_bbo(&b);
                let Some(book) = feed.book() else { continue };
                let (bb, ba) = (book.best_bid().unwrap(), book.best_ask().unwrap());
                let (qb, qa) = (quote.bid.unwrap(), quote.ask.unwrap());
                checked += 1;
                if (bb.price, ba.price) == (qb.0, qa.0) {
                    prices += 1;
                }
                if (bb.price, bb.size, ba.price, ba.size) == (qb.0, qb.1, qa.0, qa.1) {
                    exact += 1;
                }
                assert!(bb.price < ba.price, "the book never crosses");
                assert_orders_match(&b, bb.orders, ba.orders);
            }
            _ => {}
        }
    }
    let book = feed.book().expect("the snapshot landed");
    let stats = book.stats();
    assert!(buffered > 0, "some updates waited for the snapshot");
    assert!(stats.skipped > 0, "the snapshot covered some of them");
    assert!(price_moves > 0, "the session holds price changes");
    assert_eq!(stats.unknown_deletes, 0);
    assert_eq!(stats.unknown_changes, 0);
    assert!(book.order_count() > 10_000);
    let (bids, asks) = book.depth();
    assert!(bids > 100 && asks > 100);
    assert!(checked >= 5, "{checked} BBOs checked");
    // BBO and depth-by-order travel as separate messages, so a BBO can lead its order update.
    assert_eq!(prices, checked);
    assert!(exact * 10 >= checked * 8, "{exact}/{checked} exact");
    let snap = book.snapshot(&symbols::instrument_id("ESZ6", "CME"), 10, Timestamp(0));
    assert_eq!((snap.bids.len(), snap.asks.len()), (10, 10));
    assert!(snap.bids.windows(2).all(|w| w[0].price > w[1].price));
    assert!(snap.asks.windows(2).all(|w| w[0].price < w[1].price));
    assert!(snap.ts > Timestamp::parse("2026-10-07T00:00:00Z").unwrap());
}

fn assert_orders_match(b: &BestBidOffer, bid_orders: u32, ask_orders: u32) {
    for (feed, book) in [(b.bid_orders, bid_orders), (b.ask_orders, ask_orders)] {
        if let Some(n) = feed {
            assert!(
                (i64::from(n) - i64::from(book)).abs() <= 5,
                "BBO says {n} orders, the book {book}"
            );
        }
    }
}

#[test]
fn quote_state_folds_the_session() {
    let id = symbols::instrument_id("ESZ6", "CME");
    let mut q = QuoteState::default();
    for m in synthetic::recording() {
        match m {
            RithmicMessage::BestBidOffer(b) => q.apply_bbo(&b),
            RithmicMessage::LastTrade(t) => q.apply_trade(&t),
            RithmicMessage::TradeStatistics(s) => q.apply_stats(&s),
            _ => {}
        }
    }
    let quote = q.to_quote(&id, SessionCalendar::CmeEquityIndex, Timestamp(0));
    assert!(quote.bid.unwrap() < quote.ask.unwrap());
    let s = quote.session.unwrap();
    assert_eq!(s.trade_date.to_string(), "2026-10-07");
    assert!(s.volume.unwrap() > Qty::from(100_000));
    let (low, high, last) = (s.low.unwrap(), s.high.unwrap(), quote.last.unwrap());
    assert!(low <= last && last <= high);
    assert!(s.open.is_some() && s.prev_close.is_some());
}

#[test]
fn replayed_minute_bars_open_on_the_minute_and_aggregate() {
    let bars: Vec<_> = synthetic::recording()
        .iter()
        .filter_map(|m| match m {
            RithmicMessage::ResponseTimeBarReplay(b) => map::time_bar(
                b,
                BarUnit::Seconds(60),
                SessionCalendar::CmeEquityIndex,
                map::Grid::default(),
            ),
            _ => None,
        })
        .collect();
    assert!(bars.len() >= 25, "{} bars", bars.len());
    for w in bars.windows(2) {
        assert_eq!(w[1].t.0 - w[0].t.0, NANOS_PER_MINUTE);
    }
    assert!(
        bars.iter()
            .all(|b| b.t.0 % NANOS_PER_MINUTE == 0 && b.is_consistent())
    );
    let total: Qty = bars.iter().fold(Qty::ZERO, |a, b| a + b.v);
    let m5 = finish(
        bars,
        Timeframe::M5,
        SessionCalendar::CmeEquityIndex,
        None,
        None,
        None,
        false,
    );
    assert!(m5.len() >= 5);
    assert!(m5.iter().all(|b| b.t.0 % (5 * NANOS_PER_MINUTE) == 0));
    assert_eq!(m5.iter().fold(Qty::ZERO, |a, b| a + b.v), total);
}

fn order_batches(resend: Option<usize>) -> (Vec<Vec<tessera_market::OrderBookEvent>>, BookFeed) {
    use tessera_rithmic::book::BookEvent;
    let mut feed = BookFeed::default();
    let mut frames: Vec<ResponseDepthByOrderSnapshot> = Vec::new();
    let mut batches: Vec<Vec<tessera_market::OrderBookEvent>> = Vec::new();
    for m in synthetic::recording() {
        match m {
            RithmicMessage::ResponseDepthByOrderSnapshot(f) => {
                let last = f.depth_side.is_none();
                frames.push(f);
                if last {
                    feed.on_snapshot(&frames, map::Grid::default());
                    batches.push(feed.book().unwrap().image(Timestamp(0)));
                }
            }
            RithmicMessage::DepthByOrder(u) => {
                if let Some(BookEvent::Changes(_, events)) = feed.on_update(u).unwrap()
                    && !batches.is_empty()
                {
                    batches.push(events);
                    if resend == Some(batches.len() - 1) {
                        batches.push(feed.book().unwrap().image(Timestamp(0)));
                    }
                }
            }
            _ => {}
        }
    }
    (batches, feed)
}

#[tokio::test(start_paused = true)]
async fn the_mbo_book_streams_conflated_and_a_resent_image_lands_whole() {
    use futures::StreamExt;
    use std::time::Duration;

    let updates = order_batches(None).0.len() - 1;
    assert!(updates > 100, "{updates} updates");
    let (batches, feed) = order_batches(Some(updates / 2));
    let image = batches[0].len();
    assert!(image > 10_000, "a deep book: {image} events");
    assert_eq!(batches.len(), updates + 2);
    let id = symbols::instrument_id("ESZ6", "CME");
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut books = tessera_market::router::derived_depth(
        tokio_stream::wrappers::UnboundedReceiverStream::new(rx).boxed(),
        &id,
        10,
    );
    tokio::spawn(async move {
        for b in batches {
            for e in b {
                tx.send(e).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    });
    let started = tokio::time::Instant::now();
    let mut seen = Vec::new();
    while let Some(b) = books.next().await {
        seen.push(b);
    }
    let elapsed = started.elapsed().as_millis() as usize;
    assert!(elapsed >= updates, "{elapsed} ms");
    assert!(
        seen.iter()
            .all(|b| !b.bids.is_empty() && !b.asks.is_empty()),
        "never an empty book"
    );
    assert!(
        seen.len() <= elapsed / 25 + 2,
        "{} books in {elapsed} ms",
        seen.len()
    );
    assert!(seen.len() >= elapsed / 25 / 2, "{} books", seen.len());
    let last = seen.last().unwrap();
    let fed = feed.book().unwrap().snapshot(&id, 10, Timestamp(0));
    assert_eq!(last.bids, fed.bids);
    assert_eq!(last.asks, fed.asks);

    use tessera_market::hub::depth_history::{COLUMN_NS, DepthRecorder};
    let mut rec = DepthRecorder::default();
    rec.set_tick(p("0.25").0);
    let lo = seen.iter().map(|b| b.ts).min().unwrap();
    let hi = seen.iter().map(|b| b.ts).max().unwrap();
    for b in &seen {
        rec.on_book(b);
    }
    rec.on_lost(hi.0 + 1);
    let cols = rec.columns(i64::MIN, i64::MAX);
    let seconds = (hi.0 / COLUMN_NS - lo.0 / COLUMN_NS + 1) as usize;
    assert!(
        cols.len() >= 2 && cols.len() <= seconds + 1,
        "{} columns",
        cols.len()
    );
    assert!(cols.last().unwrap().ended);
    let best = |b: &tessera_core::market::BookSnapshot| b.bids[0].price.0 / p("0.25").0;
    let bids: Vec<_> = seen.iter().map(best).collect();
    let (min, max) = (bids.iter().min().unwrap(), bids.iter().max().unwrap());
    for c in cols.iter().filter(|c| !c.ended) {
        assert!(c.t % COLUMN_NS == 0);
        let top = c
            .cells
            .iter()
            .filter(|x| x.bid && x.mean > 0.0)
            .map(|x| x.tick)
            .max()
            .unwrap();
        let top = rust_decimal::Decimal::from(top);
        assert!(top >= *min && top <= *max, "the inside bid of the second");
    }
}
