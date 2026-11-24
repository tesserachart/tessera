//! Rithmic holds a native bracket's legs and places them itself once the entry fills.

use rithmic_rs::rti::RithmicOrderNotification;
use rithmic_rs::{
    OrderSide, RithmicBracketOrder, RithmicError, RithmicOcoOrder, RithmicOcoOrderLeg, RithmicOrder,
};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use tessera_broker::BrokerError;
use tessera_core::ids::OrderId;
use tessera_core::instrument::InstrumentId;
use tessera_core::money::{Price, Qty};
use tessera_core::orders::{Bracket, Order, OrderRequest, OrderRole, OrderType, Side, TimeInForce};
use tessera_core::time::Timestamp;

use crate::send::OrderEntry;
use crate::symbols::parse_instrument_id;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct BracketPlan {
    pub entry: OrderId,
    /// Rithmic copies the entry's user tag onto the legs it places.
    pub tag: String,
    pub side: Side,
    pub reference: Decimal,
    pub tick: Decimal,
    pub stop: Option<OrderId>,
    pub target: Option<OrderId>,
    pub stop_ticks: Option<i32>,
    pub target_ticks: Option<i32>,
}

impl BracketPlan {
    pub fn leg(&self, role: OrderRole) -> Option<&OrderId> {
        match role {
            OrderRole::StopLoss => self.stop.as_ref(),
            OrderRole::TakeProfit => self.target.as_ref(),
            _ => None,
        }
    }

    pub fn ticks(&self, role: OrderRole) -> Option<i32> {
        match role {
            OrderRole::StopLoss => self.stop_ticks,
            OrderRole::TakeProfit => self.target_ticks,
            _ => None,
        }
    }

    pub fn set_ticks(&mut self, role: OrderRole, ticks: i32) {
        match role {
            OrderRole::StopLoss => self.stop_ticks = Some(ticks),
            OrderRole::TakeProfit => self.target_ticks = Some(ticks),
            _ => {}
        }
    }

    pub fn leg_price(&self, role: OrderRole, ticks: i32) -> Price {
        self.leg_price_from(role, ticks, self.reference)
    }

    pub fn leg_price_from(&self, role: OrderRole, ticks: i32, from: Decimal) -> Price {
        let away = self.tick * Decimal::from(ticks);
        let up = matches!(
            (self.side, role),
            (Side::Buy, OrderRole::TakeProfit) | (Side::Sell, OrderRole::StopLoss)
        );
        Price(if up { from + away } else { from - away })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct InDoubt {
    pub tag: String,
    pub sentence: String,
    pub at: Timestamp,
}

const IN_DOUBT_KEPT: i64 = 120 * tessera_core::time::NANOS_PER_SEC;

impl InDoubt {
    pub fn holds(&self, now: Timestamp) -> bool {
        now.0.saturating_sub(self.at.0) < IN_DOUBT_KEPT
    }

    pub fn shown_by(&self, tag: &str) -> bool {
        tag == self.tag
            || tag
                .strip_prefix(self.tag.as_str())
                .is_some_and(|rest| rest.starts_with('-'))
    }
}

pub(super) fn contract(instrument: &InstrumentId) -> Result<(String, String), BrokerError> {
    parse_instrument_id(instrument)
        .ok_or_else(|| BrokerError::Unsupported(format!("{instrument} is not a Rithmic contract")))
}

pub(super) fn rithmic_side(side: Side) -> OrderSide {
    match side {
        Side::Buy => OrderSide::Buy,
        Side::Sell => OrderSide::Sell,
    }
}

pub(super) fn rithmic_type(t: OrderType) -> rithmic_rs::OrderType {
    match t {
        OrderType::Market => rithmic_rs::OrderType::Market,
        OrderType::Limit => rithmic_rs::OrderType::Limit,
        OrderType::Stop => rithmic_rs::OrderType::StopMarket,
        OrderType::StopLimit => rithmic_rs::OrderType::StopLimit,
    }
}

pub(super) fn rithmic_tif(t: TimeInForce) -> rithmic_rs::TimeInForce {
    match t {
        TimeInForce::Day => rithmic_rs::TimeInForce::Day,
        TimeInForce::Gtc => rithmic_rs::TimeInForce::Gtc,
        TimeInForce::Ioc => rithmic_rs::TimeInForce::Ioc,
        TimeInForce::Fok => rithmic_rs::TimeInForce::Fok,
    }
}

pub(super) fn whole_qty(q: Qty) -> Result<i32, BrokerError> {
    let v = q.value();
    if v.fract() != Decimal::ZERO || v <= Decimal::ZERO {
        return Err(BrokerError::Rejected(
            "Futures are traded in whole contracts.".into(),
        ));
    }
    i32::try_from(v).map_err(|_| BrokerError::Rejected("The quantity is too large.".into()))
}

pub(super) const STOP_RULES_HELD: &str = "Tessera moves the stop by its breakeven and trailing \
     rules while it runs; Rithmic holds the stop where it last moved.";

pub(super) fn ticks_for(
    side: Side,
    role: OrderRole,
    reference: Decimal,
    price: Decimal,
    tick: Decimal,
) -> Result<i32, BrokerError> {
    let what = if role == OrderRole::StopLoss {
        "stop"
    } else {
        "target"
    };
    let above = matches!(
        (side, role),
        (Side::Buy, OrderRole::TakeProfit) | (Side::Sell, OrderRole::StopLoss)
    );
    let away = if above {
        price - reference
    } else {
        reference - price
    };
    if away <= Decimal::ZERO {
        let side_words = if above { "above" } else { "below" };
        return Err(BrokerError::Rejected(format!(
            "The {what} must be {side_words} the entry at {}.",
            reference.normalize()
        )));
    }
    let ticks = (away / tick).round();
    match ticks.to_i32() {
        Some(t) if t >= 1 => Ok(t),
        _ => Err(BrokerError::Rejected(format!(
            "The {what} must be at least one tick from the entry."
        ))),
    }
}

fn sent_ticks(n: u32) -> Result<i32, BrokerError> {
    i32::try_from(n)
        .map_err(|_| BrokerError::Rejected("The bracket is too far from the entry.".into()))
}

pub(super) fn bracket_reference(
    request: &OrderRequest,
    market: Option<Decimal>,
) -> Result<Decimal, BrokerError> {
    let own = match request.order_type {
        OrderType::Limit | OrderType::StopLimit => request.limit_price,
        OrderType::Stop => request.stop_price,
        OrderType::Market => None,
    };
    own.map(|p| p.0).or(market).ok_or_else(|| {
        BrokerError::Unavailable(format!(
            "No price for {} yet to place the bracket from; try again once it trades.",
            request.instrument.symbol()
        ))
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct LegTicks {
    pub stop: Option<i32>,
    pub target: Option<i32>,
    pub reference: Decimal,
    pub tick: Decimal,
}

pub(super) fn entry_for(
    request: &OrderRequest,
    tag: &str,
    tick: Option<Decimal>,
    market: Option<Decimal>,
) -> Result<(OrderEntry, Option<LegTicks>), BrokerError> {
    let (symbol, exchange) = contract(&request.instrument)?;
    let qty = whole_qty(request.qty)?;
    let bracket = request.bracket.filter(|b| !b.is_empty());
    let Some(b) = bracket else {
        let mut o = RithmicOrder::new()
            .symbol(symbol)
            .exchange(exchange)
            .quantity(qty)
            .transaction_type(rithmic_side(request.side))
            .price_type(rithmic_type(request.order_type))
            .duration(rithmic_tif(request.tif))
            .user_tag(tag);
        if let Some(p) = request.limit_price {
            o = o.price(p.to_f64());
        }
        if let Some(p) = request.stop_price {
            o = o.trigger_price(p.to_f64());
        }
        let o = o.build().map_err(|e| BrokerError::Rejected(plain(&e)))?;
        return Ok((OrderEntry::New(Box::new(o)), None));
    };
    let tick = tick.filter(|t| *t > Decimal::ZERO).ok_or_else(|| {
        BrokerError::Unavailable(format!(
            "The tick of {} is not known yet; open its chart and send the bracket again.",
            request.instrument.symbol()
        ))
    })?;
    let reference = bracket_reference(request, market)?;
    let stop = match b.stop_ticks {
        Some(n) => Some(sent_ticks(n)?),
        None => b
            .stop_loss
            .map(|p| ticks_for(request.side, OrderRole::StopLoss, reference, p.0, tick))
            .transpose()?,
    };
    let target = match b.target_ticks {
        Some(n) => Some(sent_ticks(n)?),
        None => b
            .take_profit
            .map(|p| ticks_for(request.side, OrderRole::TakeProfit, reference, p.0, tick))
            .transpose()?,
    };
    let mut o = RithmicBracketOrder::new()
        .symbol(symbol)
        .exchange(exchange)
        .quantity(qty)
        .action(rithmic_side(request.side))
        .price_type(rithmic_type(request.order_type))
        .duration(rithmic_tif(request.tif))
        .localid(tag);
    if let Some(p) = request.limit_price {
        o = o.price(p.to_f64());
    }
    if let Some(p) = request.stop_price {
        o = o.trigger_price(p.to_f64());
    }
    if let Some(t) = target {
        o = o.target(t);
    }
    if let Some(t) = stop {
        o = o.stop(t).stop_market_on_reject(true);
    }
    let o = o.build().map_err(|e| BrokerError::Rejected(plain(&e)))?;
    Ok((
        OrderEntry::Bracket(Box::new(o)),
        Some(LegTicks {
            stop,
            target,
            reference,
            tick,
        }),
    ))
}

pub(super) fn attach_for(
    entry: &Order,
    bracket: &Bracket,
    qty: Qty,
    tag: &str,
) -> Result<(OrderEntry, Vec<(OrderRole, OrderRequest)>), BrokerError> {
    let (symbol, exchange) = contract(&entry.request.instrument)?;
    let q = whole_qty(qty)?;
    let side = entry.request.side.opposite();
    let legs: Vec<(OrderRole, OrderRequest)> = [
        (OrderRole::StopLoss, bracket.stop_loss),
        (OrderRole::TakeProfit, bracket.take_profit),
    ]
    .into_iter()
    .filter_map(|(role, price)| {
        let price = price?;
        let stop = role == OrderRole::StopLoss;
        Some((
            role,
            OrderRequest {
                account_id: entry.request.account_id.clone(),
                instrument: entry.request.instrument.clone(),
                side,
                qty,
                order_type: if stop {
                    OrderType::Stop
                } else {
                    OrderType::Limit
                },
                limit_price: (!stop).then_some(price),
                stop_price: stop.then_some(price),
                tif: entry.request.tif,
                bracket: None,
                client_order_id: None,
                reduce_only: true,
            },
        ))
    })
    .collect();
    let sent = match legs.as_slice() {
        [] => {
            return Err(BrokerError::Rejected(
                "No stop and no target to attach.".into(),
            ));
        }
        [(role, r)] => {
            let mut o = RithmicOrder::new()
                .symbol(symbol)
                .exchange(exchange)
                .quantity(q)
                .transaction_type(rithmic_side(side))
                .price_type(rithmic_type(r.order_type))
                .duration(rithmic_tif(r.tif))
                .user_tag(leg_tag(tag, *role));
            if let Some(p) = r.limit_price {
                o = o.price(p.to_f64());
            }
            if let Some(p) = r.stop_price {
                o = o.trigger_price(p.to_f64());
            }
            OrderEntry::New(Box::new(
                o.build().map_err(|e| BrokerError::Rejected(plain(&e)))?,
            ))
        }
        many => oco_for(many, tag)?,
    };
    Ok((sent, legs))
}

const GROUP_LEGS: [&str; 2] = ["-oco-sl", "-oco-tp"];

pub(super) fn leg_tag(tag: &str, role: OrderRole) -> String {
    let leg = if role == OrderRole::StopLoss {
        GROUP_LEGS[0]
    } else {
        GROUP_LEGS[1]
    };
    crate::account::exit_tag(format!("{tag}{leg}"), true)
}

pub(super) fn is_group_leg(tag: &str) -> bool {
    GROUP_LEGS
        .iter()
        .any(|leg| tag.ends_with(&crate::account::exit_tag((*leg).to_owned(), true)))
}

pub(super) fn exit_role(t: OrderType) -> Option<OrderRole> {
    match t {
        OrderType::Stop | OrderType::StopLimit => Some(OrderRole::StopLoss),
        OrderType::Limit => Some(OrderRole::TakeProfit),
        OrderType::Market => None,
    }
}

pub(super) fn oco_for(
    legs: &[(OrderRole, OrderRequest)],
    tag: &str,
) -> Result<OrderEntry, BrokerError> {
    let mut group = RithmicOcoOrder::new();
    for (role, r) in legs {
        let (symbol, exchange) = contract(&r.instrument)?;
        let mut leg = RithmicOcoOrderLeg::new()
            .symbol(symbol)
            .exchange(exchange)
            .quantity(whole_qty(r.qty)?)
            .transaction_type(rithmic_side(r.side))
            .price_type(rithmic_type(r.order_type))
            .duration(rithmic_tif(r.tif))
            .user_tag(leg_tag(tag, *role));
        if let Some(p) = r.limit_price {
            leg = leg.price(p.to_f64());
        }
        if let Some(p) = r.stop_price {
            leg = leg.trigger_price(p.to_f64());
        }
        group = group.leg(leg.build().map_err(|e| BrokerError::Rejected(plain(&e)))?);
    }
    Ok(OrderEntry::Oco(Box::new(
        group
            .build()
            .map_err(|e| BrokerError::Rejected(plain(&e)))?,
    )))
}

pub(super) fn leg_role(n: &RithmicOrderNotification) -> Option<OrderRole> {
    match n.price_type? {
        1 => Some(OrderRole::TakeProfit),
        3 | 4 => Some(OrderRole::StopLoss),
        _ => None,
    }
}

pub(super) fn is_leg_of(n: &RithmicOrderNotification, entry_basket: &str, tag: &str) -> bool {
    let Some(basket) = n.basket_id.as_deref().filter(|b| !b.is_empty()) else {
        return false;
    };
    if basket == entry_basket {
        return false;
    }
    n.original_basket_id.as_deref() == Some(entry_basket)
        || n.linked_basket_ids
            .as_deref()
            .is_some_and(|l| l.split([',', ' ']).any(|b| b.trim() == entry_basket))
        || n.user_tag
            .as_deref()
            .is_some_and(|t| !t.is_empty() && t == tag)
}

pub(super) fn plain(e: &RithmicError) -> String {
    match e {
        RithmicError::RequestRejected(r) => {
            let m = r
                .message
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .unwrap_or("no reason given");
            sentence(&format!("Rithmic refused it: {m}"))
        }
        RithmicError::InvalidArgument(m) => sentence(m),
        RithmicError::NoTradeRoute { exchange, .. } => sentence(&format!(
            "Rithmic has no order route to {exchange} for this login"
        )),
        other => sentence(&other.to_string()),
    }
}

pub(super) fn rejected_words(text: Option<&str>) -> Option<String> {
    let t = text.map(str::trim).filter(|t| !t.is_empty())?;
    Some(sentence(&format!("Rejected: {t}")))
}

pub(super) fn sentence(s: &str) -> String {
    let s = s.trim();
    if s.ends_with(['.', '!', '?']) {
        s.to_owned()
    } else {
        format!("{s}.")
    }
}

pub(super) fn may_have_left(e: &RithmicError) -> bool {
    !matches!(
        e,
        RithmicError::RequestRejected(_)
            | RithmicError::InvalidArgument(_)
            | RithmicError::NoTradeRoute { .. }
            | RithmicError::ProtocolError(_)
    )
}

pub(super) fn in_doubt_words(sentence: &str) -> String {
    format!(
        "{sentence}: Rithmic did not confirm it before the connection was lost, so it may or may \
         not be working. Tessera will not send it again; it shows here if Rithmic has it once the \
         account reconnects. Check the firm's platform before sending it again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn request(side: Side, order_type: OrderType, bracket: Option<Bracket>) -> OrderRequest {
        OrderRequest {
            account_id: tessera_core::ids::AccountId::new("rithmic-apex-x"),
            instrument: crate::symbols::instrument_id("MNQZ6", "CME"),
            side,
            qty: Qty::from(2),
            order_type,
            limit_price: (order_type == OrderType::Limit).then(|| Price(d("20000"))),
            stop_price: None,
            tif: TimeInForce::Day,
            bracket,
            client_order_id: None,
            reduce_only: false,
        }
    }

    fn bracket(stop: &str, target: &str) -> Bracket {
        Bracket {
            stop_loss: Some(Price(d(stop))),
            take_profit: Some(Price(d(target))),
            ..Bracket::default()
        }
    }

    #[test]
    fn a_bracket_is_sent_in_ticks_from_the_entry() {
        let r = request(
            Side::Buy,
            OrderType::Limit,
            Some(bracket("19990", "20020.25")),
        );
        let (entry, plan) = entry_for(&r, "tag-1", Some(d("0.25")), None).unwrap();
        let OrderEntry::Bracket(b) = entry else {
            panic!("a bracket")
        };
        assert_eq!(b.stop_ticks, [40]);
        assert_eq!(b.target_ticks, [81]);
        assert_eq!(b.stop_quantity, [2]);
        assert_eq!(b.localid, "tag-1");
        assert_eq!(b.price, Some(20000.0));
        let legs = plan.unwrap();
        assert_eq!((legs.stop, legs.target), (Some(40), Some(81)));
        let p = BracketPlan {
            entry: OrderId::new("e"),
            tag: "tag-1".into(),
            side: Side::Buy,
            reference: legs.reference,
            tick: legs.tick,
            stop: None,
            target: None,
            stop_ticks: legs.stop,
            target_ticks: legs.target,
        };
        assert_eq!(p.leg_price(OrderRole::StopLoss, 40), Price(d("19990")));
        assert_eq!(p.leg_price(OrderRole::TakeProfit, 81), Price(d("20020.25")));

        let r = request(
            Side::Sell,
            OrderType::Limit,
            Some(bracket("20010", "19980")),
        );
        assert!(entry_for(&r, "t", Some(d("0.25")), None).is_ok());
        let r = request(Side::Buy, OrderType::Limit, Some(bracket("20010", "20020")));
        let e = entry_for(&r, "t", Some(d("0.25")), None).unwrap_err();
        assert_eq!(
            e,
            BrokerError::Rejected("The stop must be below the entry at 20000.".into())
        );
        let r = request(
            Side::Buy,
            OrderType::Limit,
            Some(bracket("19999.9", "20010")),
        );
        assert!(entry_for(&r, "t", Some(d("0.25")), None).is_err());
    }

    #[test]
    fn a_bracket_in_ticks_goes_to_rithmic_as_those_ticks_from_the_fill() {
        let b = Bracket {
            stop_ticks: Some(40),
            target_ticks: Some(80),
            ..Bracket::default()
        };
        for last in ["20001", "19960.25", "20044"] {
            let r = request(Side::Sell, OrderType::Market, Some(b));
            let (entry, _) = entry_for(&r, "t", Some(d("0.25")), Some(d(last))).unwrap();
            let OrderEntry::Bracket(sent) = entry else {
                panic!("a bracket")
            };
            assert_eq!(sent.stop_ticks, [40], "{last}");
            assert_eq!(sent.target_ticks, [80], "{last}");
        }
    }

    #[test]
    fn a_market_brackets_ticks_count_from_the_last_trade() {
        let r = request(
            Side::Buy,
            OrderType::Market,
            Some(bracket("19990", "20010")),
        );
        assert!(matches!(
            entry_for(&r, "t", Some(d("0.25")), None),
            Err(BrokerError::Unavailable(_))
        ));
        assert!(matches!(
            entry_for(&r, "t", None, Some(d("20000"))),
            Err(BrokerError::Unavailable(_))
        ));
        let (entry, _) = entry_for(&r, "t", Some(d("0.25")), Some(d("20001"))).unwrap();
        let OrderEntry::Bracket(b) = entry else {
            panic!("a bracket")
        };
        assert_eq!(b.stop_ticks, [44]);
        assert_eq!(b.target_ticks, [36]);
        assert_eq!(b.price, None);
    }

    #[test]
    fn a_bracket_with_stop_rules_goes_with_its_fixed_legs_and_a_market_stop_on_reject() {
        let mut b = bracket("19990", "20010");
        b.trail = Some(tessera_core::orders::TrailRule {
            distance_ticks: 8,
            trigger_ticks: 0,
            step_ticks: 1,
        });
        let r = request(Side::Buy, OrderType::Limit, Some(b));
        let (entry, _) = entry_for(&r, "t", Some(d("0.25")), None).unwrap();
        let OrderEntry::Bracket(sent) = entry else {
            panic!("a bracket")
        };
        assert_eq!(
            (sent.stop_ticks.as_slice(), sent.target_ticks.as_slice()),
            (&[40][..], &[40][..])
        );
        assert_eq!(sent.stop_market_on_reject, Some(true));
        assert_eq!(sent.break_even_ticks, None);
        assert_eq!(sent.trailing_stop_trigger_ticks, None);
        let target_only = Bracket {
            stop_loss: None,
            ..bracket("19990", "20010")
        };
        let r = request(Side::Buy, OrderType::Limit, Some(target_only));
        let (entry, _) = entry_for(&r, "t", Some(d("0.25")), None).unwrap();
        let OrderEntry::Bracket(sent) = entry else {
            panic!("a bracket")
        };
        assert_eq!(sent.stop_market_on_reject, None);
    }

    #[test]
    fn a_plain_order_carries_its_tag_and_prices() {
        let mut r = request(Side::Buy, OrderType::StopLimit, None);
        r.limit_price = Some(Price(d("20001")));
        r.stop_price = Some(Price(d("20000")));
        let (entry, plan) = entry_for(&r, "tag-2", None, None).unwrap();
        assert!(plan.is_none());
        let OrderEntry::New(o) = entry else {
            panic!("a new order")
        };
        assert_eq!(o.user_tag, "tag-2");
        assert_eq!((o.price, o.trigger_price), (Some(20001.0), Some(20000.0)));
        assert_eq!(o.price_type, rithmic_rs::OrderType::StopLimit);
        r.qty = Qty(d("1.5"));
        assert!(entry_for(&r, "t", None, None).is_err());
    }

    #[test]
    fn a_stop_limit_with_a_bracket_is_sent_with_its_trigger_and_its_limit() {
        let mut r = request(
            Side::Sell,
            OrderType::StopLimit,
            Some(bracket("20009.5", "19979.5")),
        );
        r.stop_price = Some(Price(d("20000")));
        r.limit_price = Some(Price(d("19999.5")));
        let (entry, plan) = entry_for(&r, "tag-3", Some(d("0.25")), None).unwrap();
        let OrderEntry::Bracket(b) = entry else {
            panic!("a bracket")
        };
        assert_eq!(b.price_type, rithmic_rs::OrderType::StopLimit);
        assert_eq!((b.price, b.trigger_price), (Some(19999.5), Some(20000.0)));
        assert_eq!(
            (b.stop_ticks.as_slice(), b.target_ticks.as_slice()),
            (&[40][..], &[80][..])
        );
        assert_eq!(plan.unwrap().reference, d("19999.5"));
    }

    #[test]
    fn a_filled_adds_legs_go_as_one_oco_group_or_a_lone_order() {
        let entry = Order {
            id: OrderId::new("e"),
            broker_order_id: Some("B9".into()),
            draft_id: None,
            request: request(Side::Buy, OrderType::Market, None),
            role: OrderRole::Entry,
            parent_id: None,
            status: tessera_core::orders::OrderStatus::Filled,
            filled_qty: Qty::from(2),
            avg_fill_price: Some(Price(d("20000"))),
            queue_ahead: None,
            stop_rules: None,
            triggered_at: None,
            environment: tessera_core::accounts::Environment::Eval,
            reason: None,
            created_at: Timestamp(0),
            updated_at: Timestamp(0),
        };
        let (sent, legs) =
            attach_for(&entry, &bracket("19990", "20020"), Qty::from(5), "t").unwrap();
        let OrderEntry::Oco(group) = sent else {
            panic!("one OCO group")
        };
        assert_eq!(group.legs.len(), 2);
        assert!(group.legs.iter().all(|l| l.quantity == 5));
        assert_eq!(group.legs[0].trigger_price, Some(19990.0));
        assert_eq!(group.legs[1].price, Some(20020.0));
        assert_eq!(legs[0].0, OrderRole::StopLoss);
        assert!(
            legs.iter()
                .all(|(_, r)| r.side == Side::Sell && r.reduce_only)
        );
        let stop_only = Bracket {
            take_profit: None,
            ..bracket("19990", "20020")
        };
        let (sent, legs) = attach_for(&entry, &stop_only, Qty::from(5), "t").unwrap();
        assert!(matches!(sent, OrderEntry::New(_)));
        assert_eq!(legs.len(), 1);
        assert!(attach_for(&entry, &Bracket::default(), Qty::from(5), "t").is_err());
    }

    #[test]
    fn an_order_in_doubt_ends_when_rithmic_shows_it_or_after_two_minutes() {
        let d = InDoubt {
            tag: "e1-legs".into(),
            sentence: String::new(),
            at: Timestamp(0),
        };
        assert!(d.shown_by("e1-legs"));
        assert!(d.shown_by(&leg_tag("e1-legs", OrderRole::StopLoss)));
        assert!(!d.shown_by("e1-legsx"));
        assert!(d.holds(Timestamp(119 * tessera_core::time::NANOS_PER_SEC)));
        assert!(!d.holds(Timestamp(120 * tessera_core::time::NANOS_PER_SEC)));
    }

    #[test]
    fn a_groups_legs_carry_their_role_and_the_exit_mark() {
        let sl = leg_tag("t-1", OrderRole::StopLoss);
        let tp = leg_tag("t-1", OrderRole::TakeProfit);
        assert_eq!(
            (sl.as_str(), tp.as_str()),
            ("t-1-oco-sl-ro", "t-1-oco-tp-ro")
        );
        assert!(is_group_leg(&sl) && is_group_leg(&tp));
        assert!(!is_group_leg("chart-sl-ro"));
        assert!(!is_group_leg("t-1-ro"));
    }

    #[test]
    fn legs_are_found_by_parent_link_or_tag() {
        let mut n = RithmicOrderNotification::default();
        n.basket_id = Some("L1".into());
        assert!(!is_leg_of(&n, "E1", "tag"));
        n.original_basket_id = Some("E1".into());
        assert!(is_leg_of(&n, "E1", "tag"));
        n.original_basket_id = None;
        n.linked_basket_ids = Some("L2,E1".into());
        assert!(is_leg_of(&n, "E1", "tag"));
        n.linked_basket_ids = None;
        n.user_tag = Some("tag".into());
        assert!(is_leg_of(&n, "E1", "tag"));
        n.basket_id = Some("E1".into());
        assert!(!is_leg_of(&n, "E1", "tag"));
        n.price_type = Some(4);
        assert_eq!(leg_role(&n), Some(OrderRole::StopLoss));
        n.price_type = Some(1);
        assert_eq!(leg_role(&n), Some(OrderRole::TakeProfit));
    }

    #[test]
    fn rithmics_refusals_read_as_words() {
        let e = RithmicError::InvalidArgument("quantity must be positive".into());
        assert_eq!(plain(&e), "quantity must be positive.");
        assert!(!may_have_left(&e));
        assert!(may_have_left(&RithmicError::ConnectionClosed));
        assert!(may_have_left(&RithmicError::SendFailed));
        assert_eq!(rejected_words(Some(" ")), None);
        assert_eq!(
            rejected_words(Some("Price out of range")).as_deref(),
            Some("Rejected: Price out of range.")
        );
    }
}
