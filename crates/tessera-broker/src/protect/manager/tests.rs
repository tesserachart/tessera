use tessera_core::Timestamp;
use tessera_core::accounts::Environment;

use super::*;

fn exit_order(filled: i64) -> Order {
    Order {
        id: OrderId::new("tp-1"),
        broker_order_id: Some("B1-T".into()),
        draft_id: None,
        request: OrderRequest {
            account_id: AccountId::new("sim-1"),
            instrument: InstrumentId::new("MNQZ6.CME").unwrap(),
            side: Side::Sell,
            qty: Qty::from(2),
            order_type: OrderType::Limit,
            limit_price: Some(Price(Decimal::new(20_010, 0))),
            stop_price: None,
            tif: TimeInForce::Day,
            bracket: None,
            client_order_id: None,
            reduce_only: true,
        },
        role: OrderRole::TakeProfit,
        parent_id: Some(OrderId::new("e-1")),
        status: OrderStatus::PartiallyFilled,
        filled_qty: Qty::from(filled),
        avg_fill_price: None,
        queue_ahead: None,
        stop_rules: None,
        triggered_at: None,
        environment: Environment::Sim,
        reason: None,
        created_at: Timestamp(0),
        updated_at: Timestamp(0),
    }
}

#[test]
fn a_fill_the_book_already_showed_is_not_counted_again_when_older_events_replay() {
    let mut inner = Inner::default();
    inner.seen_filled(&exit_order(1));
    assert_eq!(inner.newly_filled(&exit_order(0)), Decimal::ZERO);
    assert_eq!(inner.newly_filled(&exit_order(1)), Decimal::ZERO);
    assert_eq!(inner.newly_filled(&exit_order(2)), Decimal::ONE);
}
