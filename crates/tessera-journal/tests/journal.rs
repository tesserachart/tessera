use std::str::FromStr;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::NaiveDate;
use rust_decimal::Decimal;
use tessera_core::ids::{AccountId, FillId, OrderId};
use tessera_core::instrument::{ContractSpec, InstrumentId};
use tessera_core::orders::{Fill, Order, Side};
use tessera_core::{Money, Price, Qty, Timestamp};
use tessera_journal::import::{self, Platform};
use tessera_journal::model::*;
use tessera_journal::{Added, FillSource, JournalService, MarketSource, NewFill};
use tessera_store::Store;
use tessera_store::blobs::BlobStore;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn ny() -> chrono_tz::Tz {
    chrono_tz::America::New_York
}

fn d(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap()
}

fn no_orders(_: &OrderId) -> Option<Order> {
    None
}

struct FakeMarket;

#[async_trait]
impl MarketSource for FakeMarket {
    async fn spec(&self, instrument: &InstrumentId) -> Option<ContractSpec> {
        let cat = tessera_core::catalog::Catalog::seed(NaiveDate::from_ymd_opt(2026, 10, 2)?);
        cat.spec(instrument).cloned()
    }

    async fn bars(
        &self,
        _instrument: &InstrumentId,
        from: Timestamp,
        _to: Timestamp,
    ) -> Option<Vec<(Timestamp, f64, f64)>> {
        Some(vec![(from, 20_620.0, 20_590.0), (from, 20_640.0, 20_595.0)])
    }
}

fn service() -> JournalService {
    let store = Store::open_in_memory().unwrap();
    let dir = std::env::temp_dir().join(format!(
        "tessera-journal-test-{}",
        tessera_core::ids::CallId::generate().0
    ));
    let blobs = BlobStore::open(dir, store.clone()).ok();
    JournalService::open(store, blobs, None, Some(Arc::new(FakeMarket))).unwrap()
}

fn fill(n: u32, side: Side, qty: i64, price: &str, t: &str) -> Fill {
    Fill {
        id: FillId::new(format!("paper-f{n}")),
        broker_fill_id: None,
        order_id: None,
        account_id: AccountId::new("paper-main"),
        instrument: InstrumentId::new("NQZ6.CME").unwrap(),
        side,
        qty: Qty::from(qty),
        price: Price(d(price)),
        ts: Timestamp::parse(t).unwrap(),
        fee: Money::usd(d("2.10")),
        realized_pnl: None,
        source: "paper".into(),
    }
}

#[test]
fn every_source_adds_fills_the_same_way_numbered_as_they_arrive() {
    let j = service();
    let at = "2026-11-02T15:00:00Z";
    let start = j.revision();
    let buy = fill(9, Side::Buy, 2, "20600", at);
    let added = j
        .add_fills(vec![NewFill::plain(buy.clone())], FillSource::Broker)
        .unwrap();
    assert_eq!(added.fills, 1);
    assert_eq!(added.trades.len(), 1);
    assert_eq!(j.revision(), start + 1, "one change for one call");
    assert_eq!(
        j.add_fills(vec![NewFill::plain(buy)], FillSource::Broker)
            .unwrap(),
        Added::default(),
        "a fill already kept adds nothing"
    );
    assert_eq!(j.revision(), start + 1, "and says nothing");

    let sell = Fill {
        id: FillId::new("man-1"),
        source: "manual".into(),
        ..fill(1, Side::Sell, 2, "20610", at)
    };
    let closed = j
        .add_fills(vec![NewFill::plain(sell)], FillSource::Manual)
        .unwrap();
    assert_eq!(
        closed.trades, added.trades,
        "the sell closes the same trade"
    );
    let trades = j.trades();
    let t = &trades[0];
    assert_eq!(
        (t.side, t.status, t.qty),
        (Side::Buy, TradeStatus::Closed, 2.0),
        "at one instant the fill that came first opens, whatever its id"
    );

    let info = ImportInfo {
        id: "imp-test".into(),
        platform: Platform::Rithmic,
        format: "test".into(),
        filename: None,
        account_id: "paper-main".into(),
        created_at: Timestamp::parse(at).unwrap(),
        fills: 0,
        duplicates: 0,
    };
    let imported = j
        .add_fills(
            vec![NewFill::plain(fill(3, Side::Sell, 1, "20620", at))],
            FillSource::Import(Box::new(info)),
        )
        .unwrap();
    assert_eq!(imported.fills, 1);
    let kept = j.catalog().unwrap().imports;
    assert_eq!(
        kept.iter()
            .map(|i| (i.id.as_str(), i.fills))
            .collect::<Vec<_>>(),
        [("imp-test", 1)]
    );
    let short = j
        .trades()
        .iter()
        .find(|t| t.status == TradeStatus::Open)
        .cloned()
        .unwrap();
    assert_eq!((short.side, short.origin), (Side::Sell, FillOrigin::Import));
    assert_eq!(j.revision(), start + 3);
}

#[test]
fn importers_read_each_platform() {
    let (p, r) = import::parse(&fixture("rithmic-rtrader.csv"), None, ny()).unwrap();
    assert_eq!(p, Platform::Rithmic);
    assert_eq!(r.fills.len(), 7);
    assert!(r.warnings.iter().any(|w| w.contains("not filled")));
    assert!(r.fills.iter().all(|f| f.contract.root == "MNQ"));
    let first = r.fills.iter().min_by_key(|f| f.ts).unwrap();
    assert_eq!(first.ts, Timestamp::parse("2024-04-24T13:42:37Z").unwrap());
    assert_eq!(
        first.fee,
        Some(d("1.53")),
        "commission fill rate × quantity"
    );
    let (p, _) =
        import::parse(&fixture("rithmic-rtrader.csv"), Some(Platform::Apex), ny()).unwrap();
    assert_eq!(p, Platform::Rithmic);
    let tokyo = chrono_tz::Asia::Tokyo;
    let first_of = |csv: &str, tz| {
        let (_, r) = import::parse(csv, None, tz).unwrap();
        r.fills.iter().map(|f| f.ts).min().unwrap()
    };
    assert_eq!(
        first_of(&fixture("rithmic-rtrader.csv"), tokyo),
        Timestamp::parse("2024-04-24T13:42:37Z").unwrap(),
        "R | Trader names the zone it writes times in"
    );
    let chicago = fixture("rithmic-rtrader.csv").replace("(EDT)", "(CDT)");
    assert_eq!(
        first_of(&chicago, tokyo),
        Timestamp::parse("2024-04-24T14:42:37Z").unwrap()
    );
    let unnamed = fixture("rithmic-rtrader.csv").replace("(EDT)", "(XYZ)");
    assert_eq!(
        first_of(&unnamed, tokyo),
        Timestamp::parse("2024-04-24T00:42:37Z").unwrap(),
        "a zone it does not name is the import's"
    );

    let (p, r) = import::parse(&fixture("ninjatrader.csv"), None, ny()).unwrap();
    assert_eq!(p, Platform::Ninjatrader);
    assert_eq!(r.fills.len(), 24);
    assert_eq!(r.fills[0].contract.instrument().as_str(), "NQH4.CME");
    assert_eq!(r.fills[0].fee, Some(d("2.29")));

    let (p, r) = import::parse(&fixture("topstepx.csv"), None, ny()).unwrap();
    assert_eq!(p, Platform::Topstepx);
    assert_eq!(r.fills.len(), 30, "two legs a trade");
    assert_eq!(r.fills[1].reported_pnl, Some(d("90")));
    assert_eq!(r.fills[0].side, Side::Sell, "a short opens with a sell");

    let (p, r) = import::parse(&fixture("tradovate-position-history.csv"), None, ny()).unwrap();
    assert_eq!(p, Platform::Tradovate);
    assert_eq!(r.format, "Tradovate position history");
    assert_eq!(r.fills.len(), 2);
    assert_eq!(r.fills[0].side, Side::Buy, "bought first: a long");
    assert_eq!(r.fills[1].reported_pnl, Some(d("198.50")));

    let (_, r) = import::parse(&fixture("tradovate-orders.csv"), None, ny()).unwrap();
    assert_eq!(r.format, "Tradovate orders");
    assert_eq!(r.fills.len(), 6);
    assert!(r.warnings.iter().any(|w| w.contains("cancelled")));

    assert!(import::parse("a,b\n1,2\n", None, ny()).is_err());
    assert!(
        import::parse(&fixture("topstepx.csv"), Some(Platform::Ninjatrader), ny()).is_err(),
        "a file named as another platform's is refused"
    );
}

#[test]
fn an_import_builds_trades_once() {
    let j = service();
    let input = ImportInput {
        csv: fixture("rithmic-rtrader.csv"),
        filename: Some("orders.csv".into()),
        account: Some(ImportAccount {
            id: None,
            name: Some("Eval".into()),
        }),
        ..ImportInput::default()
    };
    let preview = j.import(&input, false).unwrap();
    assert_eq!(
        (preview.fills, preview.new_fills, preview.trades),
        (7, 7, 2)
    );
    assert_eq!(j.trades().len(), 0, "a preview keeps nothing");
    let done = j.import(&input, true).unwrap();
    assert_eq!(done.trades, 2);
    let trades = j.trades();
    assert_eq!(trades.len(), 2);
    let short = &trades[0];
    assert_eq!(short.side, Side::Sell);
    assert_eq!(short.executions, 4);
    assert_eq!(short.gross_pnl, 217.5);
    assert_eq!(short.fees, 4.08);
    assert_eq!(short.net_pnl, 213.42);
    let long = &trades[1];
    assert_eq!((long.side, long.qty), (Side::Buy, 3.0));
    assert_eq!(long.net_pnl, -20.06);
    assert_eq!(long.account_name, "Eval");
    assert_eq!(long.symbol, "MNQ");
    let again = j.import(&input, true).unwrap();
    assert_eq!((again.new_fills, again.duplicates), (0, 7));
    assert_eq!(j.trades().len(), 2);
    let cat = j.catalog().unwrap();
    assert_eq!(cat.imports.len(), 1);
    j.delete_import(&cat.imports[0].id).unwrap();
    assert!(j.trades().is_empty());
}

#[tokio::test]
async fn fills_make_trades_with_partials_and_reversals() {
    let j = service();
    let fills = vec![
        fill(1, Side::Buy, 1, "20600", "2026-10-01T19:00:00-04:00"),
        fill(2, Side::Buy, 1, "20610", "2026-10-01T19:05:00-04:00"),
        fill(3, Side::Sell, 1, "20620", "2026-10-01T20:00:00-04:00"),
        fill(4, Side::Sell, 3, "20630", "2026-10-01T21:00:00-04:00"),
    ];
    assert_eq!(j.ingest(fills.clone(), &no_orders).await.unwrap(), 4);
    assert_eq!(j.ingest(fills, &no_orders).await.unwrap(), 0, "idempotent");
    let t = j.trades();
    assert_eq!(t.len(), 2);
    let open = t.iter().find(|t| t.status == TradeStatus::Open).unwrap();
    assert_eq!((open.side, open.qty), (Side::Sell, 2.0));
    let long = t.iter().find(|t| t.status == TradeStatus::Closed).unwrap();
    assert_eq!(long.gross_pnl, 800.0);
    assert_eq!(
        long.trade_date,
        NaiveDate::from_ymd_opt(2026, 10, 2).unwrap()
    );
    let detail = j
        .trade(&GetTradeInput {
            id: long.id.clone(),
            filter: None,
        })
        .await
        .unwrap();
    let kinds: Vec<_> = detail.executions.iter().map(|e| e.kind).collect();
    use tessera_journal::trades::ExecutionKind::*;
    assert_eq!(kinds, vec![Entry, ScaleIn, ScaleOut, Exit]);
    assert_eq!(detail.executions[3].qty, 1.0, "the reversal's closing part");
    assert!(detail.trade.mfe.is_some(), "MAE/MFE measured from bars");
    assert_eq!(detail.trade.mae, Some(-600.0));
    assert_eq!(detail.trade.mfe, Some(1400.0));
    let open_id = open.id.clone();
    j.ingest(
        vec![fill(5, Side::Buy, 2, "20640", "2026-10-02T10:00:00-04:00")],
        &no_orders,
    )
    .await
    .unwrap();
    let closed = j
        .trades()
        .iter()
        .find(|t| t.id == open_id)
        .cloned()
        .unwrap();
    assert_eq!(closed.status, TradeStatus::Closed);
    assert_eq!(closed.gross_pnl, -400.0);
}

#[tokio::test]
async fn what_the_trader_adds_survives_a_restart() {
    let store = Store::open_in_memory().unwrap();
    let j = JournalService::open(store.clone(), None, None, None).unwrap();
    j.ingest(
        vec![
            fill(1, Side::Buy, 1, "20600", "2026-10-02T10:00:00-04:00"),
            fill(2, Side::Sell, 1, "20625", "2026-10-02T10:30:00-04:00"),
        ],
        &no_orders,
    )
    .await
    .unwrap();
    let id = j.trades()[0].id.clone();
    let setup = j
        .save_setup(&SaveSetupInput {
            name: Some("Opening drive".into()),
            rules: Some(vec![SetupRuleInput {
                id: None,
                text: "Wait for the first pullback".into(),
                category: Some("entry".into()),
            }]),
            ..SaveSetupInput::default()
        })
        .unwrap();
    let tag = j
        .save_tag(&SaveTagInput {
            name: "Chased".into(),
            group: Some("Mistake".into()),
            ..SaveTagInput::default()
        })
        .unwrap();
    let linked = j
        .save_setup(&SaveSetupInput {
            id: Some(setup.id.clone()),
            study_id: Some(Some("study-1".into())),
            ..SaveSetupInput::default()
        })
        .unwrap();
    assert_eq!(linked.study_id.as_deref(), Some("study-1"));
    let rule = setup.rules[0].id.clone();
    let row = j
        .update(&UpdateTradeInput {
            id: id.clone(),
            notes: Some(Some("Clean drive off the open.".into())),
            setup_id: Some(Some(setup.id.clone())),
            rating: Some(Some(4)),
            stop_price: Some(Some(20_590.0)),
            tag_ids: Some(vec![tag.id.clone()]),
            rules: Some(vec![RuleTick {
                rule_id: rule.clone(),
                checked: true,
            }]),
            ..UpdateTradeInput::default()
        })
        .unwrap();
    assert_eq!(row.net_pnl, 495.8);
    assert_eq!(row.r_multiple, Some(2.48));
    assert_eq!(row.result, TradeResult::Manual);
    drop(j);
    let j = JournalService::open(store, None, None, None).unwrap();
    let again = j.trades()[0].clone();
    assert_eq!(again.id, id, "the same id after a restart");
    assert_eq!(again.setup_name.as_deref(), Some("Opening drive"));
    assert_eq!(again.rating, Some(4));
    assert_eq!(again.tags[0].group, "Mistake");
    assert!(again.has_notes);
    let cat = j.catalog().unwrap();
    assert_eq!(cat.setups[0].adherence[0].followed, 1);
    assert_eq!(cat.setups[0].stats.n, 1);
    assert_eq!(cat.setups[0].study_id.as_deref(), Some("study-1"));
    let unlinked = j
        .save_setup(&SaveSetupInput {
            id: Some(setup.id.clone()),
            study_id: Some(None),
            ..SaveSetupInput::default()
        })
        .unwrap();
    assert_eq!(unlinked.study_id, None);
    assert_eq!(unlinked.name, "Opening drive");
    let hits = j
        .search(&SearchInput {
            query: "drive off".into(),
            limit: None,
        })
        .unwrap();
    assert_eq!(hits.hits[0].id, id);
}

fn row(id: &str, net: f64, day: &str, r: Option<f64>) -> JournalTrade {
    let t = Timestamp::parse(&format!("{day}T14:00:00Z")).unwrap();
    JournalTrade {
        id: id.into(),
        account_id: "a".into(),
        account_name: "A".into(),
        instrument: "NQZ6.CME".into(),
        symbol: "NQ".into(),
        side: Side::Buy,
        status: TradeStatus::Closed,
        qty: 1.0,
        max_qty: 1.0,
        entry_price: 1.0,
        exit_price: Some(1.0),
        opened_at: t,
        closed_at: Some(Timestamp(t.0 + 600_000_000_000)),
        trade_date: NaiveDate::from_str(day).unwrap(),
        hold_secs: Some(600),
        gross_pnl: net,
        fees: 0.0,
        net_pnl: net,
        points: None,
        ticks: None,
        price_decimals: 2,
        outcome: if net > 3.0 {
            Outcome::Win
        } else if net < -3.0 {
            Outcome::Loss
        } else {
            Outcome::Breakeven
        },
        result: TradeResult::Manual,
        stop_price: None,
        target_price: None,
        plan_from: None,
        risk: None,
        r_multiple: r,
        planned_rr: None,
        mae: None,
        mfe: None,
        mae_price: None,
        mfe_price: None,
        setup_id: None,
        setup_name: None,
        tags: Vec::new(),
        rating: None,
        reviewed: false,
        emotion: None,
        exit_reason: None,
        has_notes: false,
        attachments: 0,
        origin: FillOrigin::Broker,
        source: "paper".into(),
        reported_pnl: None,
        executions: 2,
        activity: None,
    }
}

#[test]
fn statistics_match_a_hand_count() {
    let rows = [
        row("1", 100.0, "2026-10-01", Some(1.0)),
        row("2", -50.0, "2026-10-01", Some(-0.5)),
        row("3", 200.0, "2026-10-01", Some(2.0)),
        row("4", 2.0, "2026-10-02", None),
        row("5", -100.0, "2026-10-02", Some(-1.0)),
        row("6", -100.0, "2026-10-05", Some(-1.0)),
        row("7", 150.0, "2026-10-05", None),
    ];
    let refs: Vec<&JournalTrade> = rows.iter().collect();
    let s = tessera_journal::stats::compute(
        &refs,
        ny(),
        &JournalSettings::default().sessions,
        3.0,
        false,
    );
    let o = &s.overview;
    assert_eq!(
        (o.all.n, o.all.wins, o.all.losses, o.all.breakevens),
        (7, 3, 3, 1)
    );
    assert_eq!(o.all.net, 202.0);
    assert_eq!(o.all.win_rate, Some(50.0), "breakevens left out");
    assert_eq!(o.all.profit_factor, Some(1.8), "450 / 250");
    assert_eq!(o.all.avg_win, 150.0);
    assert_eq!(o.all.avg_loss, 83.33);
    assert_eq!(o.all.expectancy, 33.34, "0.5 × 150 − 0.5 × 83.33");
    assert_eq!(o.payoff_ratio, Some(1.8));
    assert_eq!(o.max_drawdown, 200.0);
    assert_eq!(o.max_drawdown_pct, Some(79.37));
    assert_eq!(o.current_drawdown, 50.0);
    assert_eq!((o.max_win_streak, o.max_loss_streak), (1, 2));
    assert_eq!(o.current_streak, 1);
    assert_eq!(o.all.n_r, 5);
    assert_eq!(o.all.total_r, Some(0.5));
    assert_eq!((o.green_days, o.red_days), (2, 1));
    assert_eq!(s.by.day.len(), 3);
    assert_eq!(s.by.weekday[0].label, "Mon");
    assert_eq!(s.by.weekday[0].n, 2);
    assert_eq!(s.sequences.after_2_losses.n, 1);
    assert_eq!(s.sequences.after_2_losses.net, 150.0);
    assert_eq!(s.sequences.after_1_loss.n, 2);
    let lo_hi = (o.win_rate_low.unwrap(), o.win_rate_high.unwrap());
    assert!(lo_hi.0 < 50.0 && lo_hi.1 > 50.0);
    assert_eq!(
        s.by.r[2].n, 3,
        "−1R to 0 holds −1R (ranges are [low, high))"
    );
    assert_eq!(s.by.r[1].n, 0);
}

#[tokio::test]
async fn days_calendar_and_logged_trades() {
    let j = service();
    let t = j
        .log_trade(&LogTradeInput {
            account: "Notebook".into(),
            symbol: "MNQZ6".into(),
            side: Side::Sell,
            qty: 2.0,
            entry_price: 20_700.0,
            entry_time: "2026-10-05T14:00:00Z".into(),
            exit_price: Some(20_680.0),
            exit_time: Some("2026-10-05T14:20:00Z".into()),
            fees: Some(1.0),
            stop_price: Some(20_710.0),
            target_price: Some(20_680.0),
            setup_id: None,
            notes: Some("Faded the gap.".into()),
        })
        .await
        .unwrap();
    assert_eq!(t.net_pnl, 79.0);
    assert_eq!(t.result, TradeResult::Target);
    assert_eq!(t.planned_rr, Some(2.0));
    let date = NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
    let day = j
        .save_day(&SaveDayInput {
            date,
            content: Some("Gap down, faded it.".into()),
            start: Some(true),
            checks: Some(vec![RuleTick {
                rule_id: "pre-market".into(),
                checked: true,
            }]),
        })
        .unwrap();
    assert_eq!(day.trades.len(), 1);
    assert!(day.checklist[0].checked);
    assert!(day.started_at.is_some());
    let cal = j.calendar(
        &GetCalendarInput::default(),
        NaiveDate::from_ymd_opt(2026, 10, 8).unwrap(),
    );
    assert_eq!(cal.days.len(), 1);
    assert!(cal.days[0].journaled);
    assert_eq!(cal.journal_streak, 1);
    assert_eq!(cal.total.net, 79.0);
    let export = j.export(&ExportInput::default());
    assert!(
        export
            .csv
            .lines()
            .nth(1)
            .unwrap()
            .contains("Faded the gap.")
    );
    let att = j
        .add_attachment(&AddAttachmentInput {
            trade_id: Some(t.id.clone()),
            date: None,
            filename: "entry.png".into(),
            media_type: "image/png".into(),
            data_base64: tessera_journal::b64::encode(b"\x89PNG fake"),
            caption: None,
        })
        .unwrap();
    assert_eq!(j.trades()[0].attachments, 1);
    let back = j.attachment(&att.id).unwrap();
    assert_eq!(
        tessera_journal::b64::decode(&back.data_base64).unwrap(),
        b"\x89PNG fake"
    );
    j.delete_trade(&t.id).unwrap();
    assert!(j.trades().is_empty());
}

fn eval_import() -> ImportInput {
    ImportInput {
        csv: fixture("rithmic-rtrader.csv"),
        filename: Some("orders.csv".into()),
        account: Some(ImportAccount {
            id: None,
            name: Some("Eval".into()),
        }),
        ..ImportInput::default()
    }
}

#[tokio::test]
async fn deleted_trades_go_to_the_trash_and_come_back() {
    let store = Store::open_in_memory().unwrap();
    let j = JournalService::open(store.clone(), None, None, None).unwrap();
    j.import(&eval_import(), true).unwrap();
    j.ingest(
        vec![
            fill(1, Side::Buy, 1, "20600", "2026-10-02T10:00:00-04:00"),
            fill(2, Side::Sell, 1, "20625", "2026-10-02T10:30:00-04:00"),
        ],
        &no_orders,
    )
    .await
    .unwrap();
    let all = j.trades();
    assert_eq!(all.len(), 3);
    let broker = all
        .iter()
        .find(|t| t.origin == FillOrigin::Broker)
        .unwrap()
        .id
        .clone();
    let imported: Vec<String> = all
        .iter()
        .filter(|t| t.origin == FillOrigin::Import)
        .map(|t| t.id.clone())
        .collect();
    let gone = imported[0].clone();
    let net_before = j.stats(&GetStatsInput::default()).overview.all.net;
    let gone_net = all.iter().find(|t| t.id == gone).unwrap().net_pnl;

    let err = j.delete_trade(&broker).unwrap_err();
    assert!(err.message.contains("cannot be deleted"));

    j.delete_trade(&gone).unwrap();
    let list = j.list(&ListTradesInput::default());
    assert_eq!(list.total, 2);
    assert!(list.trades.iter().all(|t| t.id != gone));
    let stats = j.stats(&GetStatsInput::default());
    assert_eq!(stats.overview.all.n, 2);
    assert_eq!(
        (stats.overview.all.net * 100.0).round(),
        ((net_before - gone_net) * 100.0).round()
    );
    assert_eq!(j.catalog().unwrap().trash, 1);
    let trash = j.list_trash();
    assert_eq!(trash.trades.len(), 1);
    assert_eq!(trash.trades[0].trade.id, gone, "as it was, with its id");
    assert_eq!(trash.trades[0].trade.net_pnl, gone_net);
    let again = j.import(&eval_import(), true).unwrap();
    assert_eq!(again.new_fills, 0);
    assert_eq!(j.trades().len(), 2);

    drop(j);
    let j = JournalService::open(store, None, None, None).unwrap();
    assert_eq!(j.trades().len(), 2);
    assert_eq!(j.list_trash().trades[0].trade.id, gone);

    j.restore_trade(&gone).unwrap();
    assert!(j.trades().iter().any(|t| t.id == gone), "the same id");
    assert!(j.list_trash().trades.is_empty());
    assert_eq!(j.stats(&GetStatsInput::default()).overview.all.n, 3);
    assert!(j.restore_trade(&gone).is_err(), "no longer in the Trash");

    let out = j
        .bulk_delete(&BulkDeleteInput {
            ids: vec![gone.clone(), broker.clone(), "t-nope".into()],
        })
        .unwrap();
    assert_eq!((out.changed, out.skipped), (1, 1));
    assert_eq!(j.trades().len(), 2);
    j.delete_trade(&imported[1]).unwrap();
    assert_eq!(j.list_trash().trades.len(), 2);

    let n = j
        .purge_trash(&PurgeTrashInput {
            ids: Some(vec![gone.clone()]),
        })
        .unwrap();
    assert_eq!(n.changed, 1);
    assert_eq!(j.list_trash().trades.len(), 1);
    assert!(j.restore_trade(&gone).is_err());
    j.purge_trash(&PurgeTrashInput::default()).unwrap();
    assert!(j.list_trash().trades.is_empty());
    assert_eq!(j.trades().len(), 1);
    assert_eq!(j.import(&eval_import(), true).unwrap().new_fills, 7);
    assert_eq!(j.trades().len(), 3);
}

#[tokio::test]
async fn compliance_counts_rules_followed() {
    let j = service();
    j.ingest(
        vec![
            fill(1, Side::Buy, 1, "20600", "2026-10-02T10:00:00-04:00"),
            fill(2, Side::Sell, 1, "20625", "2026-10-02T10:30:00-04:00"),
            fill(3, Side::Buy, 1, "20600", "2026-10-02T11:00:00-04:00"),
            fill(4, Side::Sell, 1, "20590", "2026-10-02T11:30:00-04:00"),
            fill(5, Side::Buy, 1, "20600", "2026-10-02T12:00:00-04:00"),
            fill(6, Side::Sell, 1, "20610", "2026-10-02T12:30:00-04:00"),
        ],
        &no_orders,
    )
    .await
    .unwrap();
    let setup = j
        .save_setup(&SaveSetupInput {
            name: Some("Opening drive".into()),
            rules: Some(vec![
                SetupRuleInput {
                    id: None,
                    text: "Wait for the pullback".into(),
                    category: Some("entry".into()),
                },
                SetupRuleInput {
                    id: None,
                    text: "Stop below the low".into(),
                    category: Some("risk".into()),
                },
            ]),
            ..SaveSetupInput::default()
        })
        .unwrap();
    let (entry, risk) = (setup.rules[0].id.clone(), setup.rules[1].id.clone());
    let trades = j.trades();
    let mut ids: Vec<(Timestamp, String)> =
        trades.iter().map(|t| (t.opened_at, t.id.clone())).collect();
    ids.sort();
    let tick = |id: &str, rules: Vec<(String, bool)>| {
        j.update(&UpdateTradeInput {
            id: id.into(),
            setup_id: Some(Some(setup.id.clone())),
            rules: Some(
                rules
                    .into_iter()
                    .map(|(rule_id, checked)| RuleTick { rule_id, checked })
                    .collect(),
            ),
            ..UpdateTradeInput::default()
        })
        .unwrap();
    };
    tick(&ids[0].1, vec![(entry.clone(), true), (risk.clone(), true)]);
    tick(&ids[1].1, vec![(entry.clone(), true)]);
    let c = j.compliance(&GetComplianceInput::default());
    assert_eq!(c.trades_with_setups, 2);
    assert_eq!(c.overall, Some(0.75));
    assert_eq!(c.by_category.entry, Some(1.0));
    assert_eq!(c.by_category.risk, Some(0.5));
    assert_eq!(c.by_category.exit, None, "no exit rule applied");
    assert_eq!(c.missed.len(), 1);
    assert_eq!(c.missed[0].rule_id, risk);
    assert_eq!(c.missed[0].rule_name, "Stop below the low");
    assert_eq!(c.missed[0].setup_name, "Opening drive");
    assert_eq!(c.missed[0].count, 1);
    let one = j.compliance(&GetComplianceInput {
        filter: Some(TradeFilter {
            ids: Some(vec![ids[0].1.clone()]),
            ..TradeFilter::default()
        }),
    });
    assert_eq!((one.trades_with_setups, one.overall), (1, Some(1.0)));
    assert!(one.missed.is_empty());
}

#[tokio::test]
async fn recent_days_are_the_latest_written_newest_first() {
    let j = service();
    j.ingest(
        vec![
            fill(1, Side::Buy, 1, "20600", "2026-10-02T10:00:00-04:00"),
            fill(2, Side::Sell, 1, "20625", "2026-10-02T10:30:00-04:00"),
        ],
        &no_orders,
    )
    .await
    .unwrap();
    let date = |s: &str| NaiveDate::from_str(s).unwrap();
    for (d, content) in [
        ("2026-09-30", "Quiet."),
        ("2026-10-02", "Drive off the open."),
        ("2026-10-01", "Chopped."),
        ("2026-10-05", "   "),
    ] {
        j.save_day(&SaveDayInput {
            date: date(d),
            content: Some(content.into()),
            start: None,
            checks: None,
        })
        .unwrap();
    }
    let out = j
        .recent_days(&RecentDaysInput {
            limit: 2,
            accounts: None,
        })
        .unwrap();
    let dates: Vec<String> = out.days.iter().map(|d| d.date.to_string()).collect();
    assert_eq!(
        dates,
        ["2026-10-02", "2026-10-01"],
        "blank entries left out"
    );
    assert_eq!(out.days[0].content, "Drive off the open.");
    assert_eq!(out.days[0].net_pnl, Some(495.8));
    assert_eq!(out.days[0].trades, 1);
    assert_eq!((out.days[1].net_pnl, out.days[1].trades), (None, 0));
    let other = j
        .recent_days(&RecentDaysInput {
            limit: 10,
            accounts: Some(vec!["someone-else".into()]),
        })
        .unwrap();
    assert_eq!(other.days.len(), 3);
    assert_eq!(other.days[0].net_pnl, None, "only the accounts asked for");
}

#[test]
fn one_saved_filter_is_the_default() {
    let j = service();
    let save = |id: Option<String>, name: &str, is_default: Option<bool>| {
        j.save_filter(&SaveFilterInput {
            id,
            name: name.into(),
            filter: TradeFilter::default(),
            is_default,
        })
        .unwrap()
    };
    let a = save(None, "Losers", Some(true));
    assert!(a.is_default);
    let b = save(None, "NQ", Some(true));
    let defaults = |j: &JournalService| -> Vec<(String, bool)> {
        j.catalog()
            .unwrap()
            .filters
            .into_iter()
            .map(|f| (f.name, f.is_default))
            .collect()
    };
    assert_eq!(
        defaults(&j),
        [("Losers".to_owned(), false), ("NQ".to_owned(), true)]
    );
    let b = save(Some(b.id), "NQ only", None);
    assert!(b.is_default);
    assert_eq!(defaults(&j)[1], ("NQ only".to_owned(), true));
    save(Some(b.id), "NQ only", Some(false));
    assert!(defaults(&j).iter().all(|(_, d)| !d));
    let _ = a;
}

#[tokio::test]
async fn drawings_round_trip_on_a_trade() {
    let j = service();
    j.ingest(
        vec![
            fill(1, Side::Buy, 1, "20600", "2026-10-02T10:00:00-04:00"),
            fill(2, Side::Sell, 1, "20625", "2026-10-02T10:30:00-04:00"),
        ],
        &no_orders,
    )
    .await
    .unwrap();
    let id = j.trades()[0].id.clone();
    let get = |id: &str| GetTradeInput {
        id: id.into(),
        filter: None,
    };
    assert!(j.trade(&get(&id)).await.unwrap().drawings.is_empty());
    let drawings = vec![
        serde_json::json!({"kind": "hline", "price": 20610.5, "style": {"color": "#7f9fbf"}}),
        serde_json::json!({"kind": "box", "points": [[1, 2], [3, 4]]}),
    ];
    j.save_drawings(&SaveTradeDrawingsInput {
        trade_id: id.clone(),
        drawings: drawings.clone(),
    })
    .unwrap();
    assert_eq!(j.trade(&get(&id)).await.unwrap().drawings, drawings);
    j.save_drawings(&SaveTradeDrawingsInput {
        trade_id: id.clone(),
        drawings: Vec::new(),
    })
    .unwrap();
    assert!(j.trade(&get(&id)).await.unwrap().drawings.is_empty());
    assert!(
        j.save_drawings(&SaveTradeDrawingsInput {
            trade_id: "t-nope".into(),
            drawings: Vec::new(),
        })
        .is_err()
    );
}

#[test]
fn calmar_and_net_per_symbol_and_month() {
    let mut rows = vec![
        row("1", 100.0, "2026-10-01", Some(1.0)),
        row("2", -50.0, "2026-10-01", Some(-0.5)),
        row("3", 200.0, "2026-10-01", Some(2.0)),
        row("4", 2.0, "2026-10-02", None),
        row("5", -100.0, "2026-10-02", Some(-1.0)),
        row("6", -100.0, "2026-10-05", Some(-1.0)),
        row("7", 150.0, "2026-10-05", None),
    ];
    let refs: Vec<&JournalTrade> = rows.iter().collect();
    let s = tessera_journal::stats::compute(&refs, ny(), &[], 3.0, true);
    assert_eq!(s.overview.calmar, Some(92.0));
    assert_eq!(s.by_symbol_month.len(), 1, "kept when compact");
    let mut es_sep = row("8", 40.0, "2026-09-30", None);
    es_sep.symbol = "ES".into();
    let mut es_oct = row("9", -15.5, "2026-10-05", None);
    es_oct.symbol = "ES".into();
    rows.push(es_sep);
    rows.push(es_oct);
    let refs: Vec<&JournalTrade> = rows.iter().collect();
    let s = tessera_journal::stats::compute(&refs, ny(), &[], 3.0, false);
    let got: Vec<(String, String, f64, u32)> = s
        .by_symbol_month
        .iter()
        .map(|m| (m.month.clone(), m.symbol.clone(), m.net, m.n))
        .collect();
    assert_eq!(
        got,
        [
            ("2026-09".to_owned(), "ES".to_owned(), 40.0, 1),
            ("2026-10".to_owned(), "ES".to_owned(), -15.5, 1),
            ("2026-10".to_owned(), "NQ".to_owned(), 202.0, 7),
        ]
    );
    let up = [row("1", 100.0, "2026-10-01", None)];
    let refs: Vec<&JournalTrade> = up.iter().collect();
    let s = tessera_journal::stats::compute(&refs, ny(), &[], 3.0, false);
    assert_eq!(s.overview.calmar, None);
}

#[tokio::test]
async fn tags_carry_their_trades_net() {
    let j = service();
    j.ingest(
        vec![
            fill(1, Side::Buy, 1, "20600", "2026-10-02T10:00:00-04:00"),
            fill(2, Side::Sell, 1, "20625", "2026-10-02T10:30:00-04:00"),
            fill(3, Side::Buy, 1, "20600", "2026-10-02T11:00:00-04:00"),
            fill(4, Side::Sell, 1, "20590", "2026-10-02T11:30:00-04:00"),
            fill(5, Side::Buy, 1, "20600", "2026-10-02T12:00:00-04:00"),
        ],
        &no_orders,
    )
    .await
    .unwrap();
    let tag = j
        .save_tag(&SaveTagInput {
            name: "A+".into(),
            ..SaveTagInput::default()
        })
        .unwrap();
    let ids: Vec<String> = j.trades().iter().map(|t| t.id.clone()).collect();
    j.bulk(&BulkUpdateInput {
        ids,
        add_tags: Some(vec![tag.id.clone()]),
        ..BulkUpdateInput::default()
    })
    .unwrap();
    let cat = j.catalog().unwrap();
    let t = cat.tags.iter().find(|t| t.id == tag.id).unwrap();
    assert_eq!(t.uses, 3);
    assert_eq!(t.net, 291.6);
}

fn entered(id: &str, at: &str) -> JournalTrade {
    let t = Timestamp::parse(at).unwrap();
    JournalTrade {
        opened_at: t,
        closed_at: Some(Timestamp(t.0 + 60_000_000_000)),
        ..row(id, 100.0, &at[..10], None)
    }
}

#[test]
fn sessions_keep_their_own_markets_clock_across_the_dst_mismatch() {
    let sessions = JournalSettings::default().sessions;
    let of = |at: &str| tessera_journal::stats::sessions_of(&entered("t", at), &sessions);
    assert_eq!(of("2026-03-31T13:45:00Z"), ["New York"], "14:45 in London");
    assert_eq!(
        of("2026-03-10T13:45:00Z"),
        ["London", "New York"],
        "the week New York has moved its clocks and London has not: 13:45 in London is 09:45 in New York"
    );
    assert_eq!(of("2026-03-31T07:15:00Z"), ["London"], "08:15 in London");
    assert_eq!(of("2026-03-10T07:30:00Z"), Vec::<String>::new());
    assert_eq!(of("2026-03-10T01:00:00Z"), ["Asia"]);
    assert_eq!(of("2026-03-10T21:00:00Z"), ["After hours"]);
}

#[test]
fn hours_and_today_follow_the_users_time_zone() {
    let j = service();
    let late = Timestamp::parse("2026-10-25T23:30:00Z").unwrap();
    j.set_display_zone(chrono_tz::Asia::Tokyo);
    assert_eq!(j.today(late).to_string(), "2026-10-26");
    j.set_display_zone(chrono_tz::America::New_York);
    assert_eq!(j.today(late).to_string(), "2026-10-25");
    let rows = [
        entered("1", "2026-10-23T13:30:00Z"),
        entered("2", "2026-10-26T13:30:00Z"),
    ];
    let refs: Vec<&JournalTrade> = rows.iter().collect();
    let hours = |tz| {
        let s = tessera_journal::stats::compute(
            &refs,
            tz,
            &JournalSettings::default().sessions,
            3.0,
            false,
        );
        (
            s.timezone.clone(),
            s.by.hour.iter().map(|b| b.key.clone()).collect::<Vec<_>>(),
        )
    };
    assert_eq!(
        hours(chrono_tz::Europe::London),
        (
            "Europe/London".to_owned(),
            vec!["13".to_owned(), "14".to_owned()]
        ),
        "London's clocks went back on 25 October"
    );
    assert_eq!(
        hours(chrono_tz::Asia::Tokyo),
        ("Asia/Tokyo".to_owned(), vec!["22".to_owned()])
    );
}

#[test]
fn a_session_names_a_real_time_zone() {
    let j = service();
    let mut sessions = JournalSettings::default().sessions;
    sessions[1].timezone = "Europe/Londres".into();
    let err = j
        .set_settings(&SetSettingsInput {
            sessions: Some(sessions),
            ..SetSettingsInput::default()
        })
        .unwrap_err();
    assert!(err.message.contains("Europe/Londres"), "{}", err.message);
}

const REVERSAL: &str = "Instrument,Action,Quantity,Price,Time,ID,E/X,Position,Order ID,Name,Commission,Rate,Account,Connection,
NQ 03-24,Buy,1,16793.00,1/17/2024 1:10:38 PM,7001,Entry,-,,,$2.29,1,SIM-REV,SIM,
NQ 03-24,Sell,2,16800.00,1/17/2024 1:15:42 PM,7002,Exit,-,,,$4.58,1,SIM-REV,SIM,
NQ 03-24,Buy,1,16790.00,1/17/2024 1:29:19 PM,7003,Exit,-,,,$2.29,1,SIM-REV,SIM,
";

#[test]
fn deleting_the_trade_a_reversing_fill_closes_leaves_the_trade_it_opens() {
    let store = Store::open_in_memory().unwrap();
    let j = JournalService::open(store.clone(), None, None, None).unwrap();
    j.import(
        &ImportInput {
            csv: REVERSAL.into(),
            ..ImportInput::default()
        },
        true,
    )
    .unwrap();
    let mut all: Vec<JournalTrade> = j.trades().iter().cloned().collect();
    all.sort_by_key(|t| t.opened_at);
    assert_eq!(all.len(), 2);
    let (long, short) = (all[0].clone(), all[1].clone());
    assert_eq!((long.side, short.side), (Side::Buy, Side::Sell));
    assert_eq!(short.qty, 1.0);
    let fees: f64 = all.iter().map(|t| t.fees).sum();
    assert!((fees - 9.16).abs() < 1e-9, "{fees}");
    j.update(&UpdateTradeInput {
        id: short.id.clone(),
        notes: Some(Some("faded the spike".into())),
        ..UpdateTradeInput::default()
    })
    .unwrap();

    let opened = |j: &JournalService| -> JournalTrade {
        let all = j.trades();
        assert_eq!(all.len(), 1, "{all:?}");
        all[0].clone()
    };
    j.delete_trade(&long.id).unwrap();
    let left = opened(&j);
    assert_eq!(left.id, short.id);
    assert_eq!((left.side, left.qty), (Side::Sell, 1.0));
    assert!(left.has_notes);
    assert_eq!(j.list_trash().trades[0].trade.id, long.id);
    assert_eq!(j.list_trash().trades[0].trade.qty, 1.0);

    j.restore_trade(&long.id).unwrap();
    let mut back: Vec<String> = j.trades().iter().map(|t| t.id.clone()).collect();
    back.sort();
    let mut both = vec![long.id.clone(), short.id.clone()];
    both.sort();
    assert_eq!(back, both);

    j.delete_trade(&long.id).unwrap();
    j.purge_trash(&PurgeTrashInput::default()).unwrap();
    drop(j);
    let j = JournalService::open(store, None, None, None).unwrap();
    let left = opened(&j);
    assert_eq!(left.id, short.id);
    assert_eq!(left.side, Side::Sell);
    assert!(left.has_notes);
}

fn one_fill_csv(n: usize) -> String {
    format!(
        "Instrument,Action,Quantity,Price,Time,ID,E/X,Position,Order ID,Name,Commission,Rate,Account,Connection,\n\
         ES 03-24,Buy,1,4800.00,1/17/2024 1:10:38 PM,{},Entry,-,,,$2.29,1,SIM-SEQ,SIM,\n",
        9000 + n
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fills_added_at_once_from_every_source_take_distinct_places() {
    let store = Store::open_in_memory().unwrap();
    let j = Arc::new(JournalService::open(store.clone(), None, None, None).unwrap());
    let mut tasks = Vec::new();
    for w in 0..4u32 {
        let fed = Arc::clone(&j);
        tasks.push(tokio::spawn(async move {
            let j = fed;
            for i in 0..20u32 {
                let n = w * 100 + i;
                j.ingest(
                    vec![fill(n, Side::Buy, 1, "20600", "2026-10-02T10:00:00-04:00")],
                    &no_orders,
                )
                .await
                .unwrap();
            }
        }));
        let imported = Arc::clone(&j);
        tasks.push(tokio::task::spawn_blocking(move || {
            let j = imported;
            for i in 0..20usize {
                j.import(
                    &ImportInput {
                        csv: one_fill_csv(w as usize * 100 + i),
                        ..ImportInput::default()
                    },
                    true,
                )
                .unwrap();
            }
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let conn = store.conn().unwrap();
    let (rows, places): (i64, i64) = conn
        .query_row(
            "SELECT count(*), count(DISTINCT seq) FROM journal_fills",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(rows, 160);
    assert_eq!(
        places, rows,
        "two fills share a place in the order they came in"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_trade_opened_while_fills_come_in_has_neighbours_from_one_list() {
    let j = Arc::new(service());
    let round_trip = |n: u32, minutes: i64| {
        let t = Timestamp::parse("2026-10-02T10:00:00-04:00").unwrap().0 + minutes * 60_000_000_000;
        let at = |k: i64| Timestamp(t + k).to_rfc3339();
        vec![
            fill(2 * n, Side::Buy, 1, "20600", &at(0)),
            fill(2 * n + 1, Side::Sell, 1, "20601", &at(1_000_000_000)),
        ]
    };
    j.ingest(round_trip(0, 0), &no_orders).await.unwrap();
    let first = j.trades()[0].id.clone();
    j.ingest(round_trip(1, 10), &no_orders).await.unwrap();
    let newer = j.trades()[0].id.clone();
    let feeding = {
        let j = Arc::clone(&j);
        tokio::spawn(async move {
            for n in 2..400u32 {
                j.ingest(round_trip(n, 10 + i64::from(n)), &no_orders)
                    .await
                    .unwrap();
            }
        })
    };
    let mut opened = Vec::new();
    for _ in 0..3 {
        let (j, first) = (Arc::clone(&j), first.clone());
        let feeding = feeding.abort_handle();
        opened.push(tokio::spawn(async move {
            let mut seen = Vec::new();
            while !feeding.is_finished() {
                let d = j
                    .trade(&GetTradeInput {
                        id: first.clone(),
                        filter: None,
                    })
                    .await
                    .unwrap();
                seen.push((d.trade.id, d.prev_id, d.next_id));
            }
            seen
        }));
    }
    feeding.await.unwrap();
    for o in opened {
        for (id, prev, next) in o.await.unwrap() {
            assert_eq!(id, first);
            assert_eq!(prev, None, "the oldest trade has none before it");
            assert_eq!(next.as_deref(), Some(newer.as_str()));
        }
    }
}
