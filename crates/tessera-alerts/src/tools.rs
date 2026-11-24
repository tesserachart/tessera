use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{Tool, ToolCtx, ToolError, ToolMeta};

use crate::io::{
    Alert, AlertsCreateInput, AlertsDeleteInput, AlertsDeleteOutput, AlertsDiscordOutput,
    AlertsHistoryInput, AlertsHistoryOutput, AlertsListInput, AlertsListOutput, AlertsPauseInput,
    AlertsSetDiscordInput, AlertsTestDiscordInput, AlertsUpdateInput,
};
use crate::service::AlertsService;

pub const CONDITIONS: &str = "Steps: each is {subject, op, target, on}. subject: the price ({\"kind\":\"price\"}, the default) or an indicator's plot. op: crosses_above, crosses_below, crosses (the subject reaches the target from the other side; a touch counts), above, below (states: fire while true). target: {\"kind\":\"value\",\"value\":21000}; a level by its identity {\"kind\":\"level\",\"key\":\"acme.classic.zero_gamma\",\"label\":\"Zero Gamma\"} (keys from intel.get_levels and concepts.get_levels: tessera.concepts.pdh/pdl/pdc, poc/vah/val…; the alert follows the level's current value); a labelled line a custom indicator draws {\"kind\":\"indicator_line\",\"indicator\":\"ci_…\",\"label\":\"London high\"} (the newest line with that label, e.g. a sessions indicator's London or Asia high and low); a drawn line {\"kind\":\"drawing\",\"drawingId\":\"dr_…\"} (horizontal line or ray, trend line, ray; chart.get_state lists them); an indicator's plot {\"kind\":\"plot\",\"indicator\":\"ema\",\"inputs\":{\"length\":9},\"plot\":\"ema\"} (built-ins sma, ema, wma, rsi, atr, bollinger, macd, stochastic, or a custom ci_…; read at bar close). on: trade (every print, the default) or bar_close (each close of the alert's interval; required for plots). Order flow: subject {\"kind\":\"big_trade\",\"side\":\"ask\"} (an aggressor order's size as it ends: one order's prints and other orders on the same side within 5 ms that do not retreat, joined as Tessera's big trades join them) or {\"kind\":\"print\",\"side\":\"bid\"} (one print's size); side ask (a buyer lifted the offer), bid (a seller hit the bid) or either; op at_least; target {\"kind\":\"value\",\"value\":50} in contracts: \"a big trade of at least 50 at the ask\". A firing then carries the size and side, and its sound says Big buyer or Big seller. A sequence is several steps that must happen in order within withinBars bars of the interval, or it starts over: \"sweeps the London high and reclaims it within 3 bars\" is [{op: crosses_above, target: the London-high line, on: trade}, {op: below, target: the same line, on: bar_close}] with withinBars 3 (a low: crosses_below, then above). repeat once (default; spent after firing, alerts.pause with paused false re-arms it) or every (cooldownSecs apart, default 60). expiresAt ends it. deliver {sound, desktop, discord} defaults to the user's choice in Settings.";

pub struct Create(pub Arc<AlertsService>);

#[async_trait]
impl Tool for Create {
    type Input = AlertsCreateInput;
    type Output = Alert;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("alerts.create", "Create an alert", RiskTier::Modify)
            .description(format!(
                "Creates an alert the runtime evaluates on the live feed, window open or not; when it fires the user hears a sound and sees a toast, a desktop notification and, if chosen, a Discord post (a phone push). {CONDITIONS} Returns the alert with its title in words; check the title says what the user asked."
            ))
            .activity("Creating an alert")
    }

    async fn call(&self, ctx: &ToolCtx, input: AlertsCreateInput) -> Result<Alert, ToolError> {
        self.0.create(&ctx.origin, input).await
    }

    fn summarize(&self, out: &Alert) -> Option<String> {
        Some(out.title.clone())
    }
}

pub struct List(pub Arc<AlertsService>);

#[async_trait]
impl Tool for List {
    type Input = AlertsListInput;
    type Output = AlertsListOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("alerts.list", "List alerts", RiskTier::Read)
            .description("The user's alerts, newest first: each with its steps, its title in words, its status (active, paused, triggered: a once alert that fired, expired), how often it fired and what the evaluator sees now (live.price: the level or line value it watches; live.step: the step a sequence waits for; live.problem: why it cannot be evaluated). Filter by instrument or status.")
            .activity("Reading alerts")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AlertsListInput,
    ) -> Result<AlertsListOutput, ToolError> {
        let instrument = match input
            .instrument
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(s) => Some(
                tessera_market::MarketDataProvider::resolve(self.0.market().as_ref(), s)
                    .await
                    .map_err(tessera_market::market_error)?,
            ),
            None => None,
        };
        let alerts = self
            .0
            .all()
            .into_iter()
            .filter(|a| instrument.as_ref().is_none_or(|i| *i == a.instrument))
            .filter(|a| input.status.is_none_or(|s| s == a.status))
            .collect();
        Ok(AlertsListOutput {
            alerts,
            discord: self.0.discord_configured(),
        })
    }

    fn summarize(&self, out: &AlertsListOutput) -> Option<String> {
        Some(format!("{} alerts", out.alerts.len()))
    }
}

pub struct Update(pub Arc<AlertsService>);

#[async_trait]
impl Tool for Update {
    type Input = AlertsUpdateInput;
    type Output = Alert;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("alerts.update", "Change an alert", RiskTier::Modify)
            .description(format!(
                "Changes an alert; what is absent stays. withinBars 0 and expiresAt 0 remove them; an empty message removes it; price moves a one-step alert at a fixed price. {CONDITIONS}"
            ))
            .activity("Changing an alert")
    }

    async fn call(&self, ctx: &ToolCtx, input: AlertsUpdateInput) -> Result<Alert, ToolError> {
        self.0.update(&ctx.origin, input).await
    }

    fn summarize(&self, out: &Alert) -> Option<String> {
        Some(out.title.clone())
    }
}

pub struct Pause(pub Arc<AlertsService>);

#[async_trait]
impl Tool for Pause {
    type Input = AlertsPauseInput;
    type Output = Alert;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("alerts.pause", "Pause or resume an alert", RiskTier::Modify)
            .description("Pauses an alert (paused true, the default) or resumes it (paused false), which also re-arms a once alert that fired or one past its expiry (its expiry then goes).")
            .activity("Pausing an alert")
            .idempotent(true)
    }

    async fn call(&self, _ctx: &ToolCtx, input: AlertsPauseInput) -> Result<Alert, ToolError> {
        self.0.pause(&input.id, input.paused.unwrap_or(true)).await
    }

    fn summarize(&self, out: &Alert) -> Option<String> {
        Some(format!("{} · {:?}", out.title, out.status).to_lowercase())
    }
}

pub struct Delete(pub Arc<AlertsService>);

#[async_trait]
impl Tool for Delete {
    type Input = AlertsDeleteInput;
    type Output = AlertsDeleteOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("alerts.delete", "Delete an alert", RiskTier::Modify)
            .description("Deletes an alert and its firing history.")
            .activity("Deleting an alert")
            .idempotent(true)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AlertsDeleteInput,
    ) -> Result<AlertsDeleteOutput, ToolError> {
        Ok(AlertsDeleteOutput {
            deleted: self.0.delete(&input.id).await?,
        })
    }
}

pub struct History(pub Arc<AlertsService>);

#[async_trait]
impl Tool for History {
    type Input = AlertsHistoryInput;
    type Output = AlertsHistoryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("alerts.history", "Alert history", RiskTier::Read)
            .description("Firings, newest first: when (the print's or the bar's time), the price that fired it and the value it was compared with, the connection the data came from, and what Discord and the analyst made of it. One alert's with alertId.")
            .activity("Reading alert history")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AlertsHistoryInput,
    ) -> Result<AlertsHistoryOutput, ToolError> {
        let limit = input.limit.unwrap_or(50).clamp(1, 500) as usize;
        Ok(AlertsHistoryOutput {
            fires: self.0.history(input.alert_id.as_deref(), limit).await?,
        })
    }

    fn summarize(&self, out: &AlertsHistoryOutput) -> Option<String> {
        Some(format!("{} firings", out.fires.len()))
    }
}

pub struct SetDiscord(pub Arc<AlertsService>);

#[async_trait]
impl Tool for SetDiscord {
    type Input = AlertsSetDiscordInput;
    type Output = AlertsDiscordOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("alerts.set_discord", "Set the Discord webhook", RiskTier::Modify)
            .description("Keeps the Discord webhook alerts post to in the OS keychain (absent or empty removes it).")
            .user_only()
            .quiet()
            .redact(&["url"])
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        input: AlertsSetDiscordInput,
    ) -> Result<AlertsDiscordOutput, ToolError> {
        Ok(AlertsDiscordOutput {
            configured: self.0.set_discord(input.url).await?,
            sent: false,
        })
    }
}

pub struct TestDiscord(pub Arc<AlertsService>);

#[async_trait]
impl Tool for TestDiscord {
    type Input = AlertsTestDiscordInput;
    type Output = AlertsDiscordOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new(
            "alerts.test_discord",
            "Test the Discord webhook",
            RiskTier::Read,
        )
        .description("Posts a test message to the Discord webhook.")
        .user_only()
        .timeout_ms(15_000)
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _input: AlertsTestDiscordInput,
    ) -> Result<AlertsDiscordOutput, ToolError> {
        self.0.test_discord().await?;
        Ok(AlertsDiscordOutput {
            configured: true,
            sent: true,
        })
    }
}
