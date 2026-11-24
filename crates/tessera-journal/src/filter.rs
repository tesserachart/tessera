use std::cmp::Ordering;

use chrono::Datelike;
use chrono_tz::Tz;

use crate::model::{JournalTrade, SessionDef, TradeFilter, TradeSortKey};
use crate::stats::{entry_hour, sessions_of};

pub struct FilterCtx<'a> {
    pub tz: Tz,
    pub sessions: &'a [SessionDef],
    pub notes: &'a dyn Fn(&str) -> Option<&'a str>,
}

fn any<T: PartialEq>(want: &Option<Vec<T>>, has: impl FnOnce(&[T]) -> bool) -> bool {
    match want {
        Some(v) if !v.is_empty() => has(v),
        _ => true,
    }
}

pub fn keeps(f: &TradeFilter, t: &JournalTrade, ctx: &FilterCtx<'_>) -> bool {
    if !any(&f.ids, |v| v.contains(&t.id))
        || !any(&f.accounts, |v| v.contains(&t.account_id))
        || !any(&f.symbols, |v| {
            v.iter().any(|s| s.eq_ignore_ascii_case(&t.symbol))
        })
        || f.side.is_some_and(|s| s != t.side)
        || f.status.is_some_and(|s| s != t.status)
        || f.from.is_some_and(|d| t.trade_date < d)
        || f.to.is_some_and(|d| t.trade_date > d)
        || f.outcome.is_some_and(|o| o != t.outcome)
        || !any(&f.results, |v| v.contains(&t.result))
        || !any(&f.setups, |v| {
            v.iter().any(|s| match &t.setup_id {
                Some(id) => id == s,
                None => s == "none",
            })
        })
        || !any(&f.tags, |v| t.tags.iter().any(|g| v.contains(&g.id)))
        || !any(&f.weekdays, |v| {
            v.contains(&(t.trade_date.weekday().number_from_monday() as u8))
        })
        || !any(&f.hours, |v| v.contains(&entry_hour(t, ctx.tz)))
        || !any(&f.sessions, |v| {
            sessions_of(t, ctx.sessions)
                .iter()
                .any(|s| v.iter().any(|w| w.eq_ignore_ascii_case(s)))
        })
        || f.min_pnl.is_some_and(|m| t.net_pnl < m)
        || f.max_pnl.is_some_and(|m| t.net_pnl > m)
        || f.min_qty.is_some_and(|m| t.qty < m)
        || f.max_qty.is_some_and(|m| t.qty > m)
        || f.reviewed.is_some_and(|r| r != t.reviewed)
        || f.min_rating.is_some_and(|m| t.rating.unwrap_or(0) < m)
        || !any(&f.emotions, |v| t.emotion.is_some_and(|e| v.contains(&e)))
    {
        return false;
    }
    if (f.min_r.is_some() || f.max_r.is_some())
        && !t
            .r_multiple
            .is_some_and(|r| f.min_r.is_none_or(|m| r >= m) && f.max_r.is_none_or(|m| r <= m))
    {
        return false;
    }
    if let Some(q) = f.search.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        let q = q.to_lowercase();
        let hit = t.symbol.to_lowercase().contains(&q)
            || t.instrument.to_lowercase().contains(&q)
            || t.account_name.to_lowercase().contains(&q)
            || t.setup_name
                .as_deref()
                .is_some_and(|s| s.to_lowercase().contains(&q))
            || t.tags.iter().any(|g| g.name.to_lowercase().contains(&q))
            || (ctx.notes)(&t.id).is_some_and(|n| n.to_lowercase().contains(&q));
        if !hit {
            return false;
        }
    }
    true
}

fn opt(a: Option<f64>, b: Option<f64>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => a.total_cmp(&b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

pub fn sort(trades: &mut [&JournalTrade], key: TradeSortKey, ascending: bool) {
    trades.sort_by(|a, b| {
        let primary = match key {
            TradeSortKey::Opened => a.opened_at.cmp(&b.opened_at),
            TradeSortKey::Closed => a.closed_at.cmp(&b.closed_at),
            TradeSortKey::Symbol => a.symbol.cmp(&b.symbol),
            TradeSortKey::Side => a.side.sign().cmp(&b.side.sign()),
            TradeSortKey::Qty => a.qty.total_cmp(&b.qty),
            TradeSortKey::Pnl => a.net_pnl.total_cmp(&b.net_pnl),
            TradeSortKey::R
            | TradeSortKey::InitialRisk
            | TradeSortKey::RInitial
            | TradeSortKey::StopMoves
            | TradeSortKey::Unprotected => {
                let value = |t: &JournalTrade| -> Option<f64> {
                    let act = t.activity.as_ref();
                    match key {
                        TradeSortKey::R => t.r_multiple,
                        TradeSortKey::InitialRisk => act.and_then(|x| x.initial_risk),
                        TradeSortKey::RInitial => act.and_then(|x| x.r_initial),
                        TradeSortKey::StopMoves => act.map(|x| f64::from(x.stop_moves)),
                        _ => act.map(|x| x.unprotected_secs),
                    }
                };
                let (va, vb) = (value(a), value(b));
                let o = opt(va, vb);
                return if ascending || va.is_none() || vb.is_none() {
                    o
                } else {
                    o.reverse()
                }
                .then_with(|| b.opened_at.cmp(&a.opened_at));
            }
            TradeSortKey::Hold => a.hold_secs.cmp(&b.hold_secs),
            TradeSortKey::Rating => a.rating.cmp(&b.rating),
            TradeSortKey::Setup => a.setup_name.cmp(&b.setup_name),
            TradeSortKey::Account => a.account_name.cmp(&b.account_name),
            TradeSortKey::Fees => a.fees.total_cmp(&b.fees),
        };
        let primary = if ascending {
            primary
        } else {
            primary.reverse()
        };
        primary
            .then_with(|| b.opened_at.cmp(&a.opened_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}
