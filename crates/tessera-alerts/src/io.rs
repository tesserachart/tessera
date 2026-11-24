use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tessera_core::{InstrumentId, Timeframe, Timestamp};
use ts_rs::TS;

pub const MESSAGE_MAX: usize = 500;
pub const STEPS_MAX: usize = 4;
pub const ALERTS_MAX: usize = 500;
pub const COOLDOWN_MAX: u32 = 86_400;
pub const WITHIN_MAX: u32 = 500;

/// The side that crossed the spread, for an order-flow subject.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FlowSide {
    /// At the ask: a buyer lifted the offer.
    Ask,
    /// At the bid: a seller hit the bid.
    Bid,
    /// Either side.
    Either,
}

impl FlowSide {
    pub fn takes(self, aggressor_sign: i8) -> bool {
        match self {
            FlowSide::Ask => aggressor_sign > 0,
            FlowSide::Bid => aggressor_sign < 0,
            FlowSide::Either => aggressor_sign != 0,
        }
    }

    pub fn words(self) -> &'static str {
        match self {
            FlowSide::Ask => " at the ask",
            FlowSide::Bid => " at the bid",
            FlowSide::Either => "",
        }
    }

    pub fn stack_words(self) -> &'static str {
        match self {
            FlowSide::Ask => "buy ",
            FlowSide::Bid => "sell ",
            FlowSide::Either => "",
        }
    }
}

fn default_ratio() -> f64 {
    3.0
}

fn default_min_volume() -> f64 {
    5.0
}

fn one_tick() -> u32 {
    1
}

/// What one side of a step reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Operand {
    /// The instrument's price: the last trade on a `trade` step, the bar's close on a `bar_close`
    /// step.
    Price,
    /// A fixed price.
    Value {
        /// The price.
        value: f64,
    },
    /// A level by its identity, as its vendor names it (`acme.classic.zero_gamma`,
    /// `tessera.concepts.pdh`): the alert follows the level's current value as it updates.
    #[serde(rename_all = "camelCase")]
    Level {
        /// The level's stable key (`<source>.<package>.<field>`).
        key: String,
        /// Only this provider's level (`acme`, `tessera-concepts`); any provider carrying the key
        /// when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        provider: Option<String>,
        /// The level's name as it reads (`Zero Gamma`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        label: Option<String>,
    },
    /// A labelled line a custom indicator draws (`London high`): the newest line with that label,
    /// recomputed at each bar close of the alert's interval.
    #[serde(rename_all = "camelCase")]
    IndicatorLine {
        /// The custom indicator's id (`ci_…`).
        indicator: String,
        /// Its inputs (absent: its defaults).
        #[serde(default)]
        inputs: Map<String, Value>,
        /// The line's label text, exactly as drawn.
        label: String,
        /// The indicator's name as it reads.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        name: Option<String>,
    },
    /// A line drawn on a chart (horizontal line or ray, trend line, ray, extended line): its value
    /// at the time, as it is now (moving the line moves the alert).
    #[serde(rename_all = "camelCase")]
    Drawing {
        /// The drawing's id (`dr_…`).
        drawing_id: String,
        /// What it reads as (`Trend line`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        label: Option<String>,
    },
    /// The size of a big trade as it ends: one aggressor order's prints, and other orders on the
    /// same side within 5 ms that do not retreat (a sweep), joined as Tessera's big trades join
    /// them. A subject only, compared `at_least` with a value in contracts.
    BigTrade {
        /// The side that crossed the spread.
        side: FlowSide,
    },
    /// The size of one print, on every trade. A subject only, compared `at_least` with a value in
    /// contracts.
    Print {
        /// The side that crossed the spread.
        side: FlowSide,
    },
    /// Price trading back into a stacked imbalance zone that is still open on the alert's
    /// interval, as the stacked_imbalance study draws it: a closed bar's stack of adjacent rows
    /// where one side's aggression beat the other's on the diagonal by `ratio`, open from that bar
    /// until a later bar trades into it or three trading days pass. Each zone fires at most once,
    /// on the first trade inside it. A subject only, compared `at_least` with the minimum stack in
    /// rows.
    #[serde(rename_all = "camelCase")]
    StackedImbalance {
        /// `ask`: a buy stack (buyers lifted the offer); `bid`: a sell stack (sellers hit the
        /// bid); `either`.
        side: FlowSide,
        /// How many times the other side's volume one side must trade on the diagonal (default 3,
        /// 1.5 to 20).
        #[serde(default = "default_ratio")]
        ratio: f64,
        /// Volume the imbalanced side must reach (default 5).
        #[serde(default = "default_min_volume")]
        min_volume: f64,
        /// How far the imbalanced side must lead the other, in contracts (default 0).
        #[serde(default)]
        min_difference: f64,
        /// Count a side against a row the bar traded nothing at (default false).
        #[serde(default)]
        include_zero: bool,
        /// Ticks per footprint row (default 1; the study passes its own rows).
        #[serde(default = "one_tick")]
        row_ticks: u32,
    },
    /// One plot of an indicator (a built-in such as `ema`, or a custom `ci_…`) on the alert's
    /// interval, read at each bar close.
    #[serde(rename_all = "camelCase")]
    Plot {
        /// `ema`, `sma`, `rsi`, … or a custom indicator's id.
        indicator: String,
        /// Its inputs (`{"length": 9}`; absent: its defaults).
        #[serde(default)]
        inputs: Map<String, Value>,
        /// The plot's key (`ema`, `upper`, `hist`).
        plot: String,
        /// What it reads as (`EMA 9`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        label: Option<String>,
    },
}

impl Operand {
    pub fn price() -> Self {
        Self::Price
    }

    pub fn needs_bar_close(&self) -> bool {
        matches!(self, Self::Plot { .. })
    }

    pub fn is_flow(&self) -> bool {
        matches!(self, Self::BigTrade { .. } | Self::Print { .. })
    }

    pub fn is_event(&self) -> bool {
        self.is_flow() || matches!(self, Self::StackedImbalance { .. })
    }

    pub fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Price, Self::Price) => true,
            (Self::BigTrade { side: a }, Self::BigTrade { side: b })
            | (Self::Print { side: a }, Self::Print { side: b }) => a == b,
            (a @ Self::StackedImbalance { .. }, b @ Self::StackedImbalance { .. }) => a == b,
            (Self::Value { value: a }, Self::Value { value: b }) => a == b,
            (
                Self::Level {
                    key: a,
                    provider: pa,
                    ..
                },
                Self::Level {
                    key: b,
                    provider: pb,
                    ..
                },
            ) => a == b && pa == pb,
            (
                Self::IndicatorLine {
                    indicator: a,
                    inputs: ia,
                    label: la,
                    ..
                },
                Self::IndicatorLine {
                    indicator: b,
                    inputs: ib,
                    label: lb,
                    ..
                },
            ) => a == b && ia == ib && la == lb,
            (Self::Drawing { drawing_id: a, .. }, Self::Drawing { drawing_id: b, .. }) => a == b,
            (
                Self::Plot {
                    indicator: a,
                    inputs: ia,
                    plot: pa,
                    ..
                },
                Self::Plot {
                    indicator: b,
                    inputs: ib,
                    plot: pb,
                    ..
                },
            ) => a == b && ia == ib && pa == pb,
            _ => false,
        }
    }

    pub fn is_indicator(&self) -> bool {
        matches!(self, Self::Plot { .. } | Self::IndicatorLine { .. })
    }

    pub fn words(&self) -> String {
        match self {
            Self::Price => "price".to_owned(),
            Self::Value { value } => fmt_price(*value),
            Self::Level { key, label, .. } => label.clone().unwrap_or_else(|| key.clone()),
            Self::IndicatorLine { label, name, .. } => match name {
                Some(n) => format!("{label} ({n})"),
                None => label.clone(),
            },
            Self::Drawing { label, .. } => label.clone().unwrap_or_else(|| "a drawn line".into()),
            Self::BigTrade { side } => format!("a big trade{}", side.words()),
            Self::Print { side } => format!("a print{}", side.words()),
            Self::StackedImbalance { side, .. } => {
                format!("a {}stacked imbalance", side.stack_words())
            }
            Self::Plot {
                indicator,
                plot,
                label,
                inputs,
            } => label.clone().unwrap_or_else(|| {
                let len = inputs
                    .get("length")
                    .or_else(|| inputs.get("period"))
                    .map(|v| format!(" {v}"))
                    .unwrap_or_default();
                if plot == indicator {
                    format!("{}{len}", indicator.to_uppercase())
                } else {
                    format!("{}{len} {plot}", indicator.to_uppercase())
                }
            }),
        }
    }
}

pub fn fmt_price(v: f64) -> String {
    let s = format!("{v:.6}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_owned()
}

/// How a step compares its subject with its target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AlertOp {
    /// Reaches the target from below (a touch counts).
    CrossesAbove,
    /// Reaches the target from above (a touch counts).
    CrossesBelow,
    /// Reaches the target from either side.
    Crosses,
    /// Is above the target.
    Above,
    /// Is below the target.
    Below,
    /// Is at least the target: an order-flow subject's size against a value.
    AtLeast,
}

impl AlertOp {
    pub fn words(self) -> &'static str {
        match self {
            Self::CrossesAbove => "crosses above",
            Self::CrossesBelow => "crosses below",
            Self::Crosses => "crosses",
            Self::Above => "is above",
            Self::Below => "is below",
            Self::AtLeast => "is at least",
        }
    }
}

/// What a step is evaluated on.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum EvaluateOn {
    /// Every trade (the last price).
    #[default]
    Trade,
    /// Each close of a bar of the alert's interval.
    BarClose,
}

/// One condition of an alert; an alert's steps must happen in order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlertStep {
    /// What is compared: the price (default) or an indicator's plot.
    #[serde(default = "Operand::price")]
    pub subject: Operand,
    /// How.
    pub op: AlertOp,
    /// With what.
    pub target: Operand,
    /// On every trade (default) or at each bar close of the alert's interval.
    #[serde(default)]
    pub on: EvaluateOn,
}

impl AlertStep {
    pub fn words(&self, interval: Timeframe, again: bool) -> String {
        let target = if again {
            "it".to_owned()
        } else {
            self.target.words()
        };
        let state = matches!(self.op, AlertOp::Above | AlertOp::Below);
        match (&self.subject, self.on) {
            (Operand::BigTrade { side }, _) => {
                format!("prints a big trade of at least {target}{}", side.words())
            }
            (Operand::Print { side }, _) => {
                format!("prints at least {target}{} in one print", side.words())
            }
            (Operand::StackedImbalance { side, .. }, _) => format!(
                "returns to a {}stacked imbalance of at least {target} {}",
                side.stack_words(),
                if target == "1" { "row" } else { "rows" }
            ),
            (Operand::Price, EvaluateOn::BarClose) if state => {
                let side = if self.op == AlertOp::Above {
                    "above"
                } else {
                    "below"
                };
                format!("a {interval} bar closes {side} {target}")
            }
            (Operand::Price, EvaluateOn::Trade) => format!("{} {target}", self.op.words()),
            (Operand::Price, EvaluateOn::BarClose) => {
                format!("{} {target} on a {interval} close", self.op.words())
            }
            (subject, on) => {
                let on = match on {
                    EvaluateOn::Trade => String::new(),
                    EvaluateOn::BarClose => format!(" on a {interval} close"),
                };
                format!("{} {} {target}{on}", subject.words(), self.op.words())
            }
        }
    }
}

/// Whether an alert fires once or every time.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum AlertRepeat {
    /// Once, then it is spent (re-arm it to watch again).
    #[default]
    Once,
    /// Every time, at most once per cool-down.
    Every,
}

/// Where a firing is delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertDelivery {
    /// A sound in the app.
    pub sound: bool,
    /// A desktop notification.
    pub desktop: bool,
    /// A post to the user's Discord webhook (Discord's app turns it into a phone push).
    pub discord: bool,
}

impl Default for AlertDelivery {
    fn default() -> Self {
        Self {
            sound: true,
            desktop: true,
            discord: false,
        }
    }
}

/// Where an alert stands.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum AlertStatus {
    /// Watching.
    #[default]
    Active,
    /// Paused by the user or the analyst.
    Paused,
    /// A once alert that fired.
    Triggered,
    /// Past its expiry.
    Expired,
}

/// What the evaluator knows of an alert now (not stored).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertLive {
    /// The price the alert watches now: its current step's target (a level's or a line's current
    /// value), for its marker on the chart.
    pub price: Option<f64>,
    /// The step a sequence waits for (0: the first).
    pub step: u32,
    /// Bars counted since a sequence's first step.
    pub bars: u32,
    /// Why it cannot be evaluated now (`no level acme.classic.zero_gamma on NQZ6.CME`).
    pub problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// Id (`al_…`).
    pub id: String,
    /// The symbol as given (`NQ` follows the front month; `NQZ6.CME` is that contract).
    pub symbol: String,
    /// The contract it watches now.
    pub instrument: InstrumentId,
    /// Bars of this interval close `bar_close` steps and count a sequence's window.
    pub interval: Timeframe,
    /// Its steps, in order (one for a plain alert).
    pub steps: Vec<AlertStep>,
    /// A sequence's window: every later step within this many bars of the first.
    pub within_bars: Option<u32>,
    /// Once or every time.
    pub repeat: AlertRepeat,
    /// Every-time alerts: seconds before it may fire again.
    pub cooldown_secs: u32,
    /// When it stops watching.
    pub expires_at: Option<Timestamp>,
    /// The words it carries when it fires.
    pub message: Option<String>,
    /// Where a firing goes.
    pub deliver: AlertDelivery,
    /// When it fires, ask the analyst session that created it to look (a turn with the alert's
    /// context). The user's switch.
    pub ask_analyst: bool,
    /// Where it stands.
    pub status: AlertStatus,
    /// The condition in words (`NQ crosses above London high, then a 5m bar closes below it within
    /// 3 bars`).
    pub title: String,
    /// Who created it: `user`, `agent` or `external`.
    pub created_by: String,
    /// The analyst session that created it.
    pub session_id: Option<String>,
    /// Created.
    pub created_at: Timestamp,
    /// Last changed.
    pub updated_at: Timestamp,
    /// Last fired.
    pub fired_at: Option<Timestamp>,
    /// Times fired.
    pub fire_count: u32,
    /// What the evaluator knows now.
    #[serde(default)]
    pub live: AlertLive,
}

impl Alert {
    pub fn describe(
        symbol: &str,
        interval: Timeframe,
        steps: &[AlertStep],
        within: Option<u32>,
    ) -> String {
        let mut parts = Vec::with_capacity(steps.len());
        for (i, s) in steps.iter().enumerate() {
            let again = i > 0 && steps[i - 1].target.same(&s.target);
            let w = s.words(interval, again);
            parts.push(if i == 0 { w } else { format!("then {w}") });
        }
        let mut t = format!("{} {}", symbol_words(symbol), parts.join(", "));
        if steps.len() > 1
            && let Some(n) = within
        {
            t.push_str(&format!(" within {n} bar{}", if n == 1 { "" } else { "s" }));
        }
        t
    }

    pub fn is_active(&self) -> bool {
        self.status == AlertStatus::Active
    }

    pub fn needs_bars(&self) -> bool {
        self.steps.len() > 1
            || self.steps.iter().any(|s| {
                s.on == EvaluateOn::BarClose
                    || s.subject.is_indicator()
                    || s.target.is_indicator()
                    || matches!(s.subject, Operand::StackedImbalance { .. })
            })
    }
}

fn symbol_words(symbol: &str) -> String {
    let Some((base, _venue)) = symbol.split_once('.') else {
        return symbol.to_owned();
    };
    let b = base.as_bytes();
    let n = b.len();
    let month = |c: u8| b"FGHJKMNQUVXZ".contains(&c);
    if (3..=5).contains(&n)
        && b[n - 1].is_ascii_digit()
        && month(b[n - 2])
        && b[..n - 2].iter().all(u8::is_ascii_alphanumeric)
        && b[0].is_ascii_uppercase()
    {
        format!("{} {}", &base[..n - 2], &base[n - 2..])
    } else {
        base.to_owned()
    }
}

/// One firing of an alert.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertFire {
    /// Id (`af_…`).
    pub id: String,
    /// The alert.
    pub alert_id: String,
    /// Its symbol.
    pub symbol: String,
    /// The contract it fired on.
    pub instrument: InstrumentId,
    /// The condition in words.
    pub title: String,
    /// The alert's message.
    pub message: Option<String>,
    /// The instrument's price that fired it (the trade, or the bar's close).
    pub price: f64,
    /// The value it was compared with (the level's, the line's).
    pub target: Option<f64>,
    /// When (the print's or the bar's time).
    pub at: Timestamp,
    /// The bar time the chart marks it at.
    pub bar_time: Option<Timestamp>,
    /// The connection the data came from (`Apex · Rithmic`).
    pub source: String,
    /// Where it goes.
    pub deliver: AlertDelivery,
    /// Discord's outcome: `sent`, or why not.
    pub discord: Option<String>,
    /// The analyst's outcome: `asked`, or why not.
    pub analyst: Option<String>,
    /// An order-flow alert's size that fired it, in contracts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<f64>,
    /// An order-flow alert's side: `ask` (a buyer) or `bid` (a seller).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub side: Option<FlowSide>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AlertsCreateInput {
    /// Instrument id or symbol (`NQ` follows the front month, `NQZ6.CME` is that contract).
    pub instrument: String,
    /// The steps, in order: one for a plain alert; two or more for a sequence (a sweep of a level,
    /// then a close back on the other side).
    pub steps: Vec<AlertStep>,
    /// Bar interval of `bar_close` steps, indicator plots and the window (default `1m`).
    #[serde(default)]
    pub interval: Option<Timeframe>,
    /// A sequence's window in bars of the interval: every later step within this many bars of the
    /// first, or it starts over.
    #[serde(default)]
    pub within_bars: Option<u32>,
    /// `once` (default) or `every`.
    #[serde(default)]
    pub repeat: Option<AlertRepeat>,
    /// Every-time alerts: seconds before it may fire again (default 60).
    #[serde(default)]
    pub cooldown_secs: Option<u32>,
    /// When it stops watching (RFC 3339, a date, or UTC nanoseconds).
    #[serde(default)]
    pub expires_at: Option<Timestamp>,
    /// Words it carries when it fires (at most 500 characters).
    #[serde(default)]
    pub message: Option<String>,
    /// Where it goes (default: the user's defaults in Settings).
    #[serde(default)]
    pub deliver: Option<AlertDelivery>,
    /// Ask the analyst session that created it to look when it fires (the user's switch; default
    /// off). In a trading session Tessera started for the user it is the session's own, on by
    /// default: the alerts it sets wake it.
    #[serde(default)]
    pub ask_analyst: Option<bool>,
}

/// `alerts.update` input: what is absent stays.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AlertsUpdateInput {
    /// The alert.
    pub id: String,
    /// Another instrument or symbol.
    #[serde(default)]
    pub instrument: Option<String>,
    /// New steps.
    #[serde(default)]
    pub steps: Option<Vec<AlertStep>>,
    /// Another interval.
    #[serde(default)]
    pub interval: Option<Timeframe>,
    /// A sequence's window in bars; 0 removes it.
    #[serde(default)]
    pub within_bars: Option<u32>,
    /// `once` or `every`.
    #[serde(default)]
    pub repeat: Option<AlertRepeat>,
    /// Cool-down in seconds.
    #[serde(default)]
    pub cooldown_secs: Option<u32>,
    /// A new expiry; 0 removes it.
    #[serde(default)]
    pub expires_at: Option<Timestamp>,
    /// A new message; empty removes it.
    #[serde(default)]
    pub message: Option<String>,
    /// Where it goes.
    #[serde(default)]
    pub deliver: Option<AlertDelivery>,
    /// Ask the analyst when it fires (the user's switch).
    #[serde(default)]
    pub ask_analyst: Option<bool>,
    /// Move a one-step alert's fixed price (its marker dragged on the chart).
    #[serde(default)]
    pub price: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AlertsPauseInput {
    /// The alert.
    pub id: String,
    /// `true` (default) pauses; `false` resumes, and re-arms a fired or expired alert.
    #[serde(default)]
    pub paused: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlertsDeleteInput {
    /// The alert.
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertsDeleteOutput {
    /// It existed and is gone.
    pub deleted: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AlertsListInput {
    /// Only alerts on this instrument or symbol.
    #[serde(default)]
    pub instrument: Option<String>,
    /// Only alerts in this state.
    #[serde(default)]
    pub status: Option<AlertStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertsListOutput {
    /// The alerts, newest first.
    pub alerts: Vec<Alert>,
    /// A Discord webhook is set.
    pub discord: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AlertsHistoryInput {
    /// Only this alert's firings.
    #[serde(default)]
    pub alert_id: Option<String>,
    /// At most this many, newest first (default 50, at most 500).
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertsHistoryOutput {
    /// Firings, newest first.
    pub fires: Vec<AlertFire>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AlertsSetDiscordInput {
    /// The channel's webhook URL (`https://discord.com/api/webhooks/…`); absent or empty removes
    /// it. Kept in the OS keychain only.
    #[serde(default)]
    pub url: Option<String>,
}

/// `alerts.set_discord` / `alerts.test_discord` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AlertsDiscordOutput {
    /// A webhook is set.
    pub configured: bool,
    /// A test message went out (`alerts.test_discord`).
    pub sent: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlertsTestDiscordInput {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum AlertsEvent {
    Snapshot {
        alerts: Vec<Alert>,
        recent: Vec<AlertFire>,
        discord: bool,
    },
    Changed {
        alert: Alert,
    },
    Removed {
        id: String,
    },
    Fired {
        fire: AlertFire,
    },
    Delivered {
        fire: AlertFire,
    },
    Discord {
        configured: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn steps_parse_with_defaults_and_read_in_words() {
        let s: AlertStep = serde_json::from_value(json!({
            "op": "crosses_above",
            "target": {"kind": "indicator_line", "indicator": "ci_1", "label": "London high", "name": "Sessions"}
        }))
        .unwrap();
        assert_eq!(s.subject, Operand::Price);
        assert_eq!(s.on, EvaluateOn::Trade);
        let back: AlertStep = serde_json::from_value(json!({
            "op": "below",
            "target": {"kind": "indicator_line", "indicator": "ci_1", "label": "London high"},
            "on": "bar_close"
        }))
        .unwrap();
        let t = Alert::describe("NQ", Timeframe::M5, &[s, back], Some(3));
        assert_eq!(
            t,
            "NQ crosses above London high (Sessions), then a 5m bar closes below it within 3 bars"
        );
        let ema: AlertStep = serde_json::from_value(json!({
            "subject": {"kind": "plot", "indicator": "ema", "inputs": {"length": 9}, "plot": "ema"},
            "op": "crosses_above",
            "target": {"kind": "plot", "indicator": "ema", "inputs": {"length": 21}, "plot": "ema"},
            "on": "bar_close"
        }))
        .unwrap();
        assert_eq!(
            Alert::describe("ESZ6.CME", Timeframe::M1, &[ema], None),
            "ES Z6 EMA 9 crosses above EMA 21 on a 1m close"
        );
        assert!(
            serde_json::from_value::<AlertStep>(
                json!({"op": "crosses", "target": {"kind": "value", "value": 1}, "x": 1})
            )
            .is_err()
        );
    }

    #[test]
    fn a_contract_reads_as_the_app_shows_it() {
        assert_eq!(symbol_words("NQZ6.CME"), "NQ Z6");
        assert_eq!(symbol_words("MESH7.CME"), "MES H7");
        assert_eq!(symbol_words("NQ"), "NQ");
        assert_eq!(symbol_words("QQQ"), "QQQ");
        assert_eq!(symbol_words("BTC-USD.CB"), "BTC-USD");
        let close = AlertStep {
            subject: Operand::Price,
            op: AlertOp::Crosses,
            target: Operand::Value { value: 21000.0 },
            on: EvaluateOn::BarClose,
        };
        assert_eq!(
            Alert::describe("NQZ6.CME", Timeframe::M1, &[close], None),
            "NQ Z6 crosses 21000 on a 1m close"
        );
    }

    #[test]
    fn prices_read_without_trailing_zeros() {
        assert_eq!(fmt_price(21000.0), "21000");
        assert_eq!(fmt_price(21000.25), "21000.25");
        assert_eq!(fmt_price(0.1), "0.1");
    }
}
