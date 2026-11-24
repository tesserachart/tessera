use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use tessera_broker::orders::OrdersService;
use tessera_protocol::surfaces::WorkspaceDockOutput;
use tessera_protocol::tools::RiskTier;
use tessera_protocol::trade_panel::{
    ExecuteAs, OcoEntry, OcoInput, OcoLegInput, TicketSizing, TicketView, TradeGetPanelInput,
    TradePanelOutput, TradeSetPanelInput,
};
use tessera_tools::{RegistryError, Tool, ToolCtx, ToolError, ToolMeta, ToolRegistry};

use crate::layout::LayoutService;

const DEFAULT_QTY: u32 = 1;
const DEFAULT_RISK: f64 = 250.0;
const DEFAULT_STOP_LIMIT_TICKS: u32 = 2;
const BASE_TICKET: &str = "*";

fn ticket_view(v: Option<&Value>, own: bool) -> TicketView {
    let o = v.and_then(Value::as_object);
    let get = |k: &str| o.and_then(|o| o.get(k));
    let positive = |k: &str| {
        get(k)
            .and_then(Value::as_f64)
            .filter(|x| x.is_finite() && *x > 0.0)
    };
    TicketView {
        account_id: get("accountId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        qty: positive("qty").map_or(DEFAULT_QTY, |q| (q.floor() as u32).max(1)),
        sizing: if get("sizing").and_then(Value::as_str) == Some("risk") {
            TicketSizing::Risk
        } else {
            TicketSizing::Qty
        },
        risk: positive("risk").unwrap_or(DEFAULT_RISK),
        stop_limit_ticks: get("stopLimitTicks")
            .and_then(Value::as_f64)
            .filter(|t| t.is_finite() && *t >= 0.0)
            .map_or(DEFAULT_STOP_LIMIT_TICKS, |t| (t.round() as u32).min(99)),
        execute: match get("execute").and_then(Value::as_str) {
            Some("full") => ExecuteAs::Full,
            Some("micro") => ExecuteAs::Micro,
            _ => ExecuteAs::Chart,
        },
        bracket_open: get("bracket").and_then(Value::as_str) != Some("closed"),
        rules_open: get("rules").and_then(Value::as_str) == Some("open"),
        own,
    }
}

fn ticket_of(trade: &Value, tile: &str) -> TicketView {
    if trade.get("v").and_then(Value::as_u64) == Some(2) {
        let tickets = trade.get("tickets");
        if let Some(own) = tickets.and_then(|t| t.get(tile)) {
            return ticket_view(Some(own), true);
        }
        return ticket_view(tickets.and_then(|t| t.get(BASE_TICKET)), false);
    }
    ticket_view(trade.is_object().then_some(trade), false)
}

fn brackets_of(trade: &Value) -> Vec<OcoEntry> {
    trade
        .get("oco")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, oco)| {
            let (account, root) = key.split_once('|')?;
            Some(OcoEntry {
                account_id: account.to_owned(),
                root: root.to_owned(),
                oco: oco.clone(),
            })
        })
        .collect()
}

fn in_range<T: PartialOrd + std::fmt::Display>(
    what: &str,
    v: T,
    lo: T,
    hi: T,
) -> Result<(), ToolError> {
    if v < lo || v > hi {
        return Err(ToolError::invalid_input(format!(
            "{what} must be {lo}–{hi}, not {v}"
        )));
    }
    Ok(())
}

fn leg_patch(what: &str, leg: &OcoLegInput) -> Result<Map<String, Value>, ToolError> {
    let mut out = Map::new();
    if let Some(on) = leg.on {
        out.insert("on".into(), json!(on));
    }
    if let Some(unit) = leg.unit {
        out.insert("unit".into(), serde_json::to_value(unit)?);
    }
    if let Some(v) = leg.value {
        if !(v.is_finite() && v > 0.0) {
            return Err(ToolError::invalid_input(format!(
                "the {what}'s value must be above 0"
            )));
        }
        out.insert("value".into(), json!(v));
    }
    Ok(out)
}

fn oco_patch(oco: &OcoInput) -> Result<Map<String, Value>, ToolError> {
    let mut out = Map::new();
    if let Some(on) = oco.on {
        out.insert("on".into(), json!(on));
    }
    if let Some(leg) = &oco.stop {
        out.insert("stop".into(), Value::Object(leg_patch("stop", leg)?));
    }
    if let Some(leg) = &oco.target {
        out.insert("target".into(), Value::Object(leg_patch("target", leg)?));
    }
    if let Some(be) = &oco.breakeven {
        let mut m = Map::new();
        if let Some(on) = be.on {
            m.insert("on".into(), json!(on));
        }
        if let Some(t) = be.trigger {
            in_range("breakeven.trigger", t, 1, 1000)?;
            m.insert("trigger".into(), json!(t));
        }
        if let Some(o) = be.offset {
            in_range("breakeven.offset", o, -100, 100)?;
            m.insert("offset".into(), json!(o));
        }
        out.insert("breakeven".into(), Value::Object(m));
    }
    if let Some(tr) = &oco.trail {
        let mut m = Map::new();
        if let Some(on) = tr.on {
            m.insert("on".into(), json!(on));
        }
        if let Some(t) = tr.ticks {
            in_range("trail.ticks", t, 1, 1000)?;
            m.insert("ticks".into(), json!(t));
        }
        if let Some(t) = tr.trigger {
            in_range("trail.trigger", t, 0, 1000)?;
            m.insert("trigger".into(), json!(t));
        }
        if let Some(t) = tr.step {
            in_range("trail.step", t, 1, 1000)?;
            m.insert("step".into(), json!(t));
        }
        out.insert("trail".into(), Value::Object(m));
    }
    Ok(out)
}

fn panel_patch(input: &TradeSetPanelInput) -> Result<Value, ToolError> {
    let mut out = Map::new();
    if let Some(a) = input.account_id.as_deref().map(str::trim) {
        if a.is_empty() {
            return Err(ToolError::invalid_input(
                "accountId names an account (portfolio.get_accounts)",
            ));
        }
        out.insert("accountId".into(), json!(a));
    }
    if let Some(q) = input.qty {
        in_range("qty", q, 1, 1000)?;
        out.insert("qty".into(), json!(q));
    }
    if let Some(s) = input.sizing {
        out.insert("sizing".into(), serde_json::to_value(s)?);
    }
    if let Some(r) = input.risk {
        if !(r.is_finite() && r > 0.0 && r <= 10_000_000.0) {
            return Err(ToolError::invalid_input(
                "risk is the money at the stop, above 0",
            ));
        }
        out.insert("risk".into(), json!(r));
    }
    if let Some(t) = input.stop_limit_ticks {
        in_range("stopLimitTicks", t, 0, 99)?;
        out.insert("stopLimitTicks".into(), json!(t));
    }
    if let Some(e) = input.execute {
        out.insert("execute".into(), serde_json::to_value(e)?);
    }
    if let Some(open) = input.bracket_open {
        out.insert(
            "bracket".into(),
            json!(if open { "open" } else { "closed" }),
        );
    }
    if let Some(open) = input.rules_open {
        out.insert("rules".into(), json!(if open { "open" } else { "closed" }));
    }
    if let Some(oco) = &input.oco {
        let p = oco_patch(oco)?;
        if !p.is_empty() {
            out.insert("oco".into(), Value::Object(p));
        }
    }
    if out.is_empty() {
        return Err(ToolError::invalid_input(
            "give the fields to change: accountId, qty, sizing, risk, stopLimitTicks, execute, bracketOpen, rulesOpen or oco",
        ));
    }
    Ok(Value::Object(out))
}

fn restate(chart: &str, instrument: &str, patch: &Value, account: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    let get = |k: &str| patch.get(k);
    if let Some(a) = account.or_else(|| get("accountId").and_then(Value::as_str)) {
        parts.push(format!("account {a}"));
    }
    if let Some(q) = get("qty").and_then(Value::as_u64) {
        parts.push(format!("{q} contract{}", if q == 1 { "" } else { "s" }));
    }
    match get("sizing").and_then(Value::as_str) {
        Some("risk") => parts.push("size by risk".into()),
        Some("qty") => parts.push("size by contracts".into()),
        _ => {}
    }
    if let Some(r) = get("risk").and_then(Value::as_f64) {
        parts.push(format!("${r} at risk"));
    }
    if let Some(t) = get("stopLimitTicks").and_then(Value::as_u64) {
        parts.push(format!("stop limit {t} ticks past its stop"));
    }
    if let Some(e) = get("execute").and_then(Value::as_str) {
        parts.push(match e {
            "micro" => "trade the micro".to_owned(),
            "full" => "trade the full size".to_owned(),
            _ => "trade the charted contract".to_owned(),
        });
    }
    if let Some(oco) = get("oco") {
        if let Some(on) = oco.get("on").and_then(Value::as_bool) {
            parts.push(format!("bracket {}", if on { "on" } else { "off" }));
        }
        for (k, word) in [("stop", "stop"), ("target", "target")] {
            if let Some(leg) = oco.get(k) {
                let mut w = word.to_owned();
                if let Some(v) = leg.get("value").and_then(Value::as_f64) {
                    let unit = leg.get("unit").and_then(Value::as_str).unwrap_or("");
                    w.push_str(&match unit {
                        "usd" => format!(" ${v}"),
                        "pct" => format!(" {v}% of the balance"),
                        "" => format!(" {v}"),
                        u => format!(" {v} {u}"),
                    });
                } else if let Some(u) = leg.get("unit").and_then(Value::as_str) {
                    w.push_str(&format!(" in {u}"));
                }
                if let Some(on) = leg.get("on").and_then(Value::as_bool) {
                    w.push_str(if on { " on" } else { " off" });
                }
                parts.push(w);
            }
        }
        if let Some(be) = oco.get("breakeven") {
            let mut w = "breakeven".to_owned();
            if let Some(t) = be.get("trigger").and_then(Value::as_u64) {
                w.push_str(&format!(" at {t} ticks"));
            }
            if let Some(o) = be.get("offset").and_then(Value::as_i64) {
                w.push_str(&format!(" {o:+}"));
            }
            if let Some(on) = be.get("on").and_then(Value::as_bool) {
                w.push_str(if on { " on" } else { " off" });
            }
            parts.push(w);
        }
        if let Some(tr) = oco.get("trail") {
            let mut w = "trailing".to_owned();
            if let Some(t) = tr.get("ticks").and_then(Value::as_u64) {
                w.push_str(&format!(" {t} ticks"));
            }
            if let Some(t) = tr.get("trigger").and_then(Value::as_u64) {
                w.push_str(&format!(" from +{t}"));
            }
            if let Some(t) = tr.get("step").and_then(Value::as_u64) {
                w.push_str(&format!(" by {t}"));
            }
            if let Some(on) = tr.get("on").and_then(Value::as_bool) {
                w.push_str(if on { " on" } else { " off" });
            }
            parts.push(w);
        }
    }
    if let Some(open) = get("bracket").and_then(Value::as_str) {
        parts.push(format!("bracket section {open}"));
    }
    if let Some(open) = get("rules").and_then(Value::as_str) {
        parts.push(format!("rules {open}"));
    }
    format!(
        "Trade panel of {chart} ({instrument}): {}",
        parts.join(", ")
    )
}

struct GetPanel(Arc<LayoutService>);

#[async_trait]
impl Tool for GetPanel {
    type Input = TradeGetPanelInput;
    type Output = TradePanelOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("trade.get_panel", "Read the Trade panel", RiskTier::Read)
            .description("A chart's Trade panel setup, what the user's own clicks in Trade, on the chart and on its DOM send with: the account it trades (null: the account new tickets start with, the one last picked), contracts per entry, sizing by contracts or by the money at risk at the stop (risk), a stop limit's offset in ticks, which contract of the family it executes (chart, full, micro), whether its bracket section and the bracket's rules are open; and the brackets the workspace keeps per account and instrument root ({on, stop, target: {on, unit ticks|points|usd|pct, value}, breakeven: {on, trigger, offset}, trail: {on, ticks, trigger, step}}; none kept: a 40-tick stop and an 80-tick target). Defaults to the active chart. trade.set_panel changes it, with the user's approval.")
            .activity("Read the Trade panel")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: TradeGetPanelInput,
    ) -> Result<TradePanelOutput, ToolError> {
        let state = self
            .0
            .chart_state(input.layout_id.as_deref(), input.tile_id.as_deref())?;
        let layout = self.0.get(input.layout_id.as_deref())?;
        Ok(TradePanelOutput {
            layout_id: layout.id,
            ticket: ticket_of(&layout.trade, &state.chart.tile_id),
            tile_id: state.chart.tile_id,
            instrument: state.chart.instrument,
            brackets: brackets_of(&layout.trade),
        })
    }

    fn summarize(&self, o: &TradePanelOutput) -> Option<String> {
        let t = &o.ticket;
        Some(match t.sizing {
            TicketSizing::Qty => format!("{} · {} contracts", o.tile_id, t.qty),
            TicketSizing::Risk => format!("{} · ${} at risk", o.tile_id, t.risk),
        })
    }
}

struct SetPanel(Arc<LayoutService>);

impl SetPanel {
    fn chart(&self, input: &TradeSetPanelInput) -> Result<(String, String, String), ToolError> {
        let state = self
            .0
            .chart_state(input.layout_id.as_deref(), input.tile_id.as_deref())?;
        Ok((
            state.chart.tile_id,
            state.chart.title,
            state.chart.instrument.to_string(),
        ))
    }

    async fn account(
        ctx: &ToolCtx,
        input: &TradeSetPanelInput,
    ) -> Result<Option<String>, ToolError> {
        let (Some(id), Some(orders)) = (
            input.account_id.as_deref().map(str::trim),
            ctx.extensions.get::<OrdersService>(),
        ) else {
            return Ok(None);
        };
        let accounts = orders.accounts().await?;
        let found = accounts.iter().find(|u| u.account.id.as_str() == id);
        match found {
            Some(u) => Ok(Some(u.account.display_name.clone())),
            None => Err(ToolError::not_found(format!(
                "no account {id} (portfolio.get_accounts lists them)"
            ))),
        }
    }
}

#[async_trait]
impl Tool for SetPanel {
    type Input = TradeSetPanelInput;
    type Output = WorkspaceDockOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("trade.set_panel", "Set up the Trade panel", RiskTier::Modify)
            .description("Changes a chart's Trade panel setup, what the user's own clicks then send with (as their own picks in the panel do); only the fields given change. accountId (portfolio.get_accounts), qty (1–1000 contracts), sizing (qty, or risk: the size comes from the money at risk at the stop the user clicks), risk (that money), stopLimitTicks (0–99), execute (chart, full or micro: which contract of the family), bracketOpen and rulesOpen (the sections shown), and oco: the bracket every entry from the panel carries for that account and contract: {on, stop: {on, unit: ticks|points|usd|pct, value}, target: {…}, breakeven: {on, trigger ticks, offset ticks}, trail: {on, ticks behind the best price, trigger ticks of profit before it starts, step ticks per move}}. It ALWAYS asks the user first, whatever the session's mode: say what you prepared and that they allow it in Tessera; never retry one that is waiting. Once allowed the desk applies it (at once to the chart Trade shows; a bracket for another chart when its panel next shows). It sends no order. trade.get_panel reads it.")
            .activity("Set up the Trade panel")
            .always_ask()
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        input: TradeSetPanelInput,
    ) -> Result<WorkspaceDockOutput, ToolError> {
        let patch = panel_patch(&input)?;
        Self::account(ctx, &input).await?;
        let (tile, _, _) = self.chart(&input)?;
        self.0
            .ask_trade_panel(input.layout_id.as_deref(), &tile, patch, &ctx.origin)
            .await
    }

    async fn preview(&self, ctx: &ToolCtx, input: &TradeSetPanelInput) -> Result<Value, ToolError> {
        let patch = panel_patch(input)?;
        let account = Self::account(ctx, input).await?;
        let (tile, title, instrument) = self.chart(input)?;
        Ok(json!({
            "restatement": restate(&title, &instrument, &patch, account.as_deref()),
            "chart": tile,
            "instrument": instrument,
        }))
    }

    fn summarize(&self, o: &WorkspaceDockOutput) -> Option<String> {
        Some(format!(
            "Trade panel of {} · {}",
            o.request.tile_id.as_deref().unwrap_or("the active chart"),
            o.layout_id
        ))
    }
}

pub(crate) fn register(r: &mut ToolRegistry, l: &Arc<LayoutService>) -> Result<(), RegistryError> {
    r.register(GetPanel(Arc::clone(l)))?;
    r.register(SetPanel(Arc::clone(l)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_protocol::trade_panel::{BreakevenInput, OcoUnit, TrailInput};

    #[test]
    fn a_stored_setup_reads_as_the_desk_reads_it() {
        let trade = json!({"v": 2, "tickets": {
            "*": {"accountId": "paper-main", "qty": 3},
            "chart-2": {"qty": 2.7, "sizing": "risk", "risk": 400, "bracket": "closed", "rules": "open", "execute": "micro", "stopLimitTicks": 120},
        }, "oco": {"paper-main|NQ": {"on": true}, "bad": {}}});
        let base = ticket_of(&trade, "chart-1");
        assert!(!base.own);
        assert_eq!(base.account_id.as_deref(), Some("paper-main"));
        assert_eq!(base.qty, 3);
        let own = ticket_of(&trade, "chart-2");
        assert!(own.own);
        assert_eq!(own.qty, 2);
        assert_eq!(own.sizing, TicketSizing::Risk);
        assert!((own.risk - 400.0).abs() < f64::EPSILON);
        assert!(!own.bracket_open && own.rules_open);
        assert_eq!(own.execute, ExecuteAs::Micro);
        assert_eq!(own.stop_limit_ticks, 99);
        let none = ticket_of(&Value::Null, "chart-1");
        assert_eq!((none.qty, none.stop_limit_ticks), (1, 2));
        assert_eq!(ticket_of(&json!({"qty": 4}), "chart-9").qty, 4);
        let b = brackets_of(&trade);
        assert_eq!(b.len(), 1);
        assert_eq!(
            (b[0].account_id.as_str(), b[0].root.as_str()),
            ("paper-main", "NQ")
        );
    }

    #[test]
    fn a_change_is_checked_and_said_in_words() {
        assert!(panel_patch(&TradeSetPanelInput::default()).is_err());
        for bad in [
            TradeSetPanelInput {
                qty: Some(0),
                ..Default::default()
            },
            TradeSetPanelInput {
                risk: Some(-5.0),
                ..Default::default()
            },
            TradeSetPanelInput {
                stop_limit_ticks: Some(100),
                ..Default::default()
            },
            TradeSetPanelInput {
                oco: Some(OcoInput {
                    stop: Some(OcoLegInput {
                        value: Some(0.0),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
            TradeSetPanelInput {
                oco: Some(OcoInput {
                    trail: Some(TrailInput {
                        ticks: Some(0),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
            TradeSetPanelInput {
                oco: Some(OcoInput {
                    trail: Some(TrailInput {
                        step: Some(0),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ] {
            assert!(panel_patch(&bad).is_err(), "{bad:?}");
        }
        let input = TradeSetPanelInput {
            qty: Some(2),
            bracket_open: Some(true),
            oco: Some(OcoInput {
                stop: Some(OcoLegInput {
                    on: Some(true),
                    unit: Some(OcoUnit::Ticks),
                    value: Some(10.0),
                }),
                target: Some(OcoLegInput {
                    unit: Some(OcoUnit::Usd),
                    value: Some(400.0),
                    on: None,
                }),
                breakeven: Some(BreakevenInput {
                    on: Some(true),
                    trigger: Some(8),
                    offset: Some(1),
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        let patch = panel_patch(&input).unwrap();
        assert_eq!(
            patch,
            json!({"qty": 2, "bracket": "open", "oco": {
                "stop": {"on": true, "unit": "ticks", "value": 10.0},
                "target": {"unit": "usd", "value": 400.0},
                "breakeven": {"on": true, "trigger": 8, "offset": 1},
            }})
        );
        assert_eq!(
            restate("Chart 1", "NQZ6.CME", &patch, Some("Paper")),
            "Trade panel of Chart 1 (NQZ6.CME): account Paper, 2 contracts, stop 10 ticks on, target $400, breakeven at 8 ticks +1 on, bracket section open"
        );
    }
}
