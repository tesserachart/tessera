use chrono::NaiveDate;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tessera_core::Timestamp;
use tessera_core::orders::Side;
use ts_rs::TS;

use crate::activity::{ActivitySummary, Actor, Leg, MoveDirection, OrderEvent, PathStep, StopMove};
use crate::import::{Platform, RowError};
use crate::trades::ExecutionKind;

pub type Clearable<T> = Option<Option<T>>;

pub(crate) fn clearable<'de, D, T>(d: D) -> Result<Clearable<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Open while the position is held, closed once flat.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TradeStatus {
    /// Still held.
    Open,
    /// Flat again.
    Closed,
}

/// A closed trade's outcome against the breakeven band (net P&L within ±threshold is breakeven).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Net above the band.
    Win,
    /// Net below the band.
    Loss,
    /// Inside the band.
    Breakeven,
    /// Not closed.
    Open,
}

/// How a trade ended (TheTraderLog's result): the trader's own exit reason when given, else what
/// the closing order was (a bracket's stop or target), else where the exit stood against the
/// stop and target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TradeResult {
    /// At the target.
    Target,
    /// At the original stop.
    Stop,
    /// At a stop trailed into profit.
    Trailed,
    /// At a stop moved to the entry.
    Breakeven,
    /// Closed by hand.
    Manual,
    /// Still open.
    Open,
}

/// The trader's reason for the exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    /// Closed by hand.
    Manual,
    /// The original stop.
    StopLoss,
    /// A trailed stop.
    TrailingStop,
    /// The target.
    TakeProfit,
    /// Time (end of session).
    TimeBased,
    /// Stopped at the entry.
    Breakeven,
}

/// The trader's state of mind (TheTraderLog's moods).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Emotion {
    Confident,
    Neutral,
    Anxious,
    Fearful,
    Greedy,
    Frustrated,
    Excited,
}

impl Emotion {
    pub const ALL: [Emotion; 7] = [
        Emotion::Confident,
        Emotion::Neutral,
        Emotion::Anxious,
        Emotion::Fearful,
        Emotion::Greedy,
        Emotion::Frustrated,
        Emotion::Excited,
    ];

    pub fn word(self) -> &'static str {
        match self {
            Emotion::Confident => "Confident",
            Emotion::Neutral => "Neutral",
            Emotion::Anxious => "Anxious",
            Emotion::Fearful => "Fearful",
            Emotion::Greedy => "Greedy",
            Emotion::Frustrated => "Frustrated",
            Emotion::Excited => "Excited",
        }
    }
}

/// Where a trade's fills came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FillOrigin {
    /// A connection's own fills (Tessera Paper, Rithmic).
    Broker,
    /// An imported export.
    Import,
    /// Logged by hand.
    Manual,
}

/// A tag on a trade.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Colour (`#rrggbb`).
    pub color: String,
    /// Its group (`Mistake`), or empty.
    pub group: String,
}

/// A trade as the journal lists it: built from its fills, with what the trader added.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalTrade {
    /// Stable id (from the account, the instrument and the trade's first fill).
    pub id: String,
    /// Account id.
    pub account_id: String,
    /// The account as the trader knows it.
    pub account_name: String,
    /// Exact instrument (`NQZ6.CME`).
    pub instrument: String,
    /// What it is grouped and shown by: a future's root (`NQ`), a stock's ticker.
    pub symbol: String,
    /// `buy` for a long, `sell` for a short.
    pub side: Side,
    /// Open or closed.
    pub status: TradeStatus,
    /// Quantity entered (all adds).
    pub qty: f64,
    /// Largest position held.
    pub max_qty: f64,
    /// Average entry price.
    pub entry_price: f64,
    /// Average exit price (of the partial exits while open).
    pub exit_price: Option<f64>,
    /// First entry.
    #[ts(type = "number")]
    pub opened_at: Timestamp,
    /// Last exit.
    #[ts(type = "number | null")]
    pub closed_at: Option<Timestamp>,
    /// Trade date: the session date of the exit (of the entry while open).
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub trade_date: NaiveDate,
    /// Seconds held (to the exit).
    #[ts(type = "number | null")]
    pub hold_secs: Option<i64>,
    /// P&L before fees, from the contract spec (realized so far while open).
    pub gross_pnl: f64,
    /// Fees and commissions.
    pub fees: f64,
    /// Net P&L.
    pub net_pnl: f64,
    /// Points per unit, signed by direction.
    pub points: Option<f64>,
    /// Ticks per unit.
    pub ticks: Option<f64>,
    /// Decimals to show prices with.
    pub price_decimals: u32,
    /// Win, loss, breakeven or open.
    pub outcome: Outcome,
    /// How it ended.
    pub result: TradeResult,
    /// The stop it was planned with: the trader's, else the first stop that covered it (its
    /// recorded activity), else the entry order's bracket.
    pub stop_price: Option<f64>,
    /// The target it was planned with.
    pub target_price: Option<f64>,
    /// Where the stop and target came from: `you`, `activity` (the first stop and target that
    /// covered it) or `order` (the entry order's bracket).
    pub plan_from: Option<String>,
    /// Money at risk at the stop: with a stop you set, |entry − stop| × point value × quantity;
    /// else, when its recorded orders show a stop, the activity's initial risk (none when an entry
    /// had no stop); else, from its entry orders' stop, |entry − stop| × point value × quantity.
    pub risk: Option<f64>,
    /// Net P&L in units of that risk; none without a risk.
    pub r_multiple: Option<f64>,
    /// Planned reward to risk (|target − entry| / |entry − stop|).
    pub planned_rr: Option<f64>,
    /// Largest move against the trade while held, in money (from 1-minute bars).
    pub mae: Option<f64>,
    /// Largest move in its favour while held, in money (from 1-minute bars; hindsight).
    pub mfe: Option<f64>,
    /// The price of the largest adverse move.
    pub mae_price: Option<f64>,
    /// The price of the largest favourable move.
    pub mfe_price: Option<f64>,
    /// Setup (playbook) id.
    pub setup_id: Option<String>,
    /// Setup name.
    pub setup_name: Option<String>,
    /// Tags.
    pub tags: Vec<TagRef>,
    /// 1–5.
    pub rating: Option<u8>,
    /// Reviewed by the trader.
    pub reviewed: bool,
    /// Mood.
    pub emotion: Option<Emotion>,
    /// The trader's exit reason.
    pub exit_reason: Option<ExitReason>,
    /// The trade has notes.
    pub has_notes: bool,
    /// Screenshots and files attached.
    pub attachments: u32,
    /// Where its fills came from.
    pub origin: FillOrigin,
    /// The fills' source (`paper`, `rithmic`, `csv:projectx`).
    pub source: String,
    /// The platform's own P&L (imports that report one), for reconciliation.
    pub reported_pnl: Option<f64>,
    /// Number of executions.
    pub executions: u32,
    /// What its recorded order activity measures: the initial stop and risk, R on that risk, stop
    /// moves, time without a stop, how it ended. Null when none of its orders is known.
    pub activity: Option<ActivitySummary>,
}

/// One execution of a trade.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRow {
    /// Fill id.
    pub fill_id: String,
    /// Entry, add, partial exit or exit.
    pub kind: ExecutionKind,
    /// Side of the fill.
    pub side: Side,
    /// Quantity.
    pub qty: f64,
    /// Price.
    pub price: f64,
    /// Time.
    #[ts(type = "number")]
    pub ts: Timestamp,
    /// Its share of fees.
    pub fee: f64,
    /// Gross P&L this part realized.
    pub realized: Option<f64>,
    /// The order it filled (`stop_loss`, `take_profit`), when the connection said.
    pub role: Option<String>,
}

/// A file attached to a trade or a day.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    /// Id.
    pub id: String,
    /// File name.
    pub filename: String,
    /// Media type (`image/png`).
    pub media_type: String,
    /// Bytes.
    #[ts(type = "number")]
    pub size: u64,
    /// Caption.
    pub caption: Option<String>,
    /// When attached.
    #[ts(type = "number")]
    pub created_at: Timestamp,
}

/// A setup rule as checked on a trade.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuleCheck {
    /// Rule id.
    pub rule_id: String,
    /// Its text.
    pub text: String,
    /// `entry`, `exit`, `risk` or `management`.
    pub category: String,
    /// Followed on this trade.
    pub checked: bool,
}

/// `journal.get_trade` output: the trade with its executions, notes, files and its setup's rules.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradeDetail {
    /// The trade.
    pub trade: JournalTrade,
    /// Executions in time order.
    pub executions: Vec<ExecutionRow>,
    /// Notes (Markdown).
    pub notes: String,
    /// Files.
    pub attachments: Vec<AttachmentInfo>,
    /// Its setup's rules and whether each was followed.
    pub rules: Vec<RuleCheck>,
    /// The trade before it (by entry time, among those the filter keeps).
    pub prev_id: Option<String>,
    /// The trade after it.
    pub next_id: Option<String>,
    /// Point value per unit (money per 1.0 of price).
    pub point_value: f64,
    /// Tick size.
    pub tick_size: f64,
    /// Why MAE/MFE are missing (no bars for its time), when they are.
    pub excursion_note: Option<String>,
    /// Its order activity: the stop and target over time, each change and who made it.
    pub activity: Option<TradeActivity>,
    /// What the trader drew on its chart (`journal.save_trade_drawings`; the chart's own JSON,
    /// kept as given), empty when nothing.
    pub drawings: Vec<Value>,
}

/// A trade's order activity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradeActivity {
    /// What it measures.
    pub summary: ActivitySummary,
    /// The tightest working stop from the entry on (a step line: each price holds until the next
    /// step; null while no stop worked).
    pub stop_path: Vec<PathStep>,
    /// The nearest working target.
    pub target_path: Vec<PathStep>,
    /// Each stop move while the position was open.
    pub moves: Vec<StopMove>,
    /// Every change of its orders, in time order, with who made it.
    pub rows: Vec<ActivityRow>,
    /// Where the paths end (the exit, or the latest moment known while open).
    #[ts(type = "number")]
    pub end: Timestamp,
    /// Since when its account's orders are recorded as they change.
    #[ts(type = "number | null")]
    pub live_since: Option<Timestamp>,
}

/// One change of an order, with who made it and what it was to a trade.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    /// The change.
    pub event: OrderEvent,
    /// The trade it belongs to.
    pub trade_id: Option<String>,
    /// What the order was to that trade.
    pub leg: Option<Leg>,
    /// Who made it.
    pub actor: Actor,
    /// A covering stop's move: tightened or widened.
    pub direction: Option<MoveDirection>,
    /// Ticks moved.
    pub ticks: Option<f64>,
}

/// Since when an account's orders are recorded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityAccount {
    /// Account id.
    pub account_id: String,
    /// Recorded as they change from here (activity is complete from then).
    #[ts(type = "number | null")]
    pub live_since: Option<Timestamp>,
    /// When its earlier orders were reconstructed from the paper broker's stored orders and the
    /// audit of Tessera's order calls.
    #[ts(type = "number | null")]
    pub backfilled_at: Option<Timestamp>,
}

/// `journal.get_activity` input. Every field narrows.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetActivityInput {
    /// One trade's orders.
    pub trade_id: Option<String>,
    /// One account.
    pub account_id: Option<String>,
    /// A symbol (`NQ`) or an exact instrument (`NQZ6.CME`).
    pub instrument: Option<String>,
    /// First trade date (inclusive, `YYYY-MM-DD`: the CME session date for futures).
    #[ts(as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub from: Option<NaiveDate>,
    /// Last trade date (inclusive).
    #[ts(as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub to: Option<NaiveDate>,
    /// Most rows (default 500, at most 5000), newest kept.
    pub limit: Option<u32>,
}

/// `journal.get_activity` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOutput {
    /// Changes, in time order.
    pub rows: Vec<ActivityRow>,
    /// Changes the query matched (rows may hold fewer).
    pub total: u32,
    /// Since when each account's orders are recorded.
    pub accounts: Vec<ActivityAccount>,
}

/// Which trades a list, a report or an export covers. Every field narrows; absent fields keep
/// everything.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TradeFilter {
    /// Account ids.
    pub accounts: Option<Vec<String>>,
    /// Symbols (`NQ`, `QQQ`).
    pub symbols: Option<Vec<String>>,
    /// Long (`buy`) or short (`sell`).
    pub side: Option<Side>,
    /// Open or closed.
    pub status: Option<TradeStatus>,
    /// First trade date (inclusive, `YYYY-MM-DD`).
    #[ts(as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub from: Option<NaiveDate>,
    /// Last trade date (inclusive).
    #[ts(as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub to: Option<NaiveDate>,
    /// Win, loss or breakeven.
    pub outcome: Option<Outcome>,
    /// How they ended.
    pub results: Option<Vec<TradeResult>>,
    /// Setup ids (`none`: trades without a setup).
    pub setups: Option<Vec<String>>,
    /// Tag ids (a trade with any of them).
    pub tags: Option<Vec<String>>,
    /// Weekdays of the trade date (1 Monday … 7 Sunday).
    pub weekdays: Option<Vec<u8>>,
    /// Entry hours (0–23, in the journal's time zone).
    pub hours: Option<Vec<u8>>,
    /// Session names (by entry time).
    pub sessions: Option<Vec<String>>,
    /// Least net P&L.
    pub min_pnl: Option<f64>,
    /// Most net P&L.
    pub max_pnl: Option<f64>,
    /// Least R (trades without a stop are left out when set).
    pub min_r: Option<f64>,
    /// Most R.
    pub max_r: Option<f64>,
    /// Least quantity.
    pub min_qty: Option<f64>,
    /// Most quantity.
    pub max_qty: Option<f64>,
    /// Reviewed or not.
    pub reviewed: Option<bool>,
    /// Least rating.
    pub min_rating: Option<u8>,
    /// Moods.
    pub emotions: Option<Vec<Emotion>>,
    /// Words in the symbol, setup, tags or notes.
    pub search: Option<String>,
    /// These trades only.
    pub ids: Option<Vec<String>>,
}

/// A column to sort trades by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TradeSortKey {
    /// Entry time.
    #[default]
    Opened,
    /// Exit time.
    Closed,
    Symbol,
    Side,
    /// Quantity.
    Qty,
    /// Net P&L.
    Pnl,
    /// R multiple.
    R,
    /// Initial risk (money at the first stop).
    InitialRisk,
    /// R on the initial risk.
    RInitial,
    StopMoves,
    /// Time without a working stop.
    Unprotected,
    /// Time held.
    Hold,
    Rating,
    /// Setup name.
    Setup,
    /// Account name.
    Account,
    Fees,
}

/// `journal.list_trades` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ListTradesInput {
    /// Which trades.
    pub filter: Option<TradeFilter>,
    /// Sort column (default entry time).
    pub sort: Option<TradeSortKey>,
    /// Ascending (default newest / largest first).
    pub ascending: Option<bool>,
    /// Page size (default 200, at most 2000; agents should ask for less).
    pub limit: Option<u32>,
    /// Rows to skip.
    pub offset: Option<u32>,
}

/// `journal.list_trades` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListTradesOutput {
    /// The page.
    pub trades: Vec<JournalTrade>,
    /// Trades the filter keeps.
    pub total: u32,
    /// Measured over every trade the filter keeps (not only the page).
    pub summary: Bucket,
}

/// `journal.get_trade` input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetTradeInput {
    /// Trade id.
    pub id: String,
    /// The list it was opened from, for the previous and next trade.
    #[serde(default)]
    pub filter: Option<TradeFilter>,
}

/// A group of trades measured together: a day, a setup, an hour.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    /// Key (`2026-10-02`, `setup id`, `14`).
    pub key: String,
    /// What the trader reads (`Fri 2 Oct`, `Opening drive`, `14:00`).
    pub label: String,
    /// Closed trades.
    pub n: u32,
    /// Winners.
    pub wins: u32,
    /// Losers.
    pub losses: u32,
    /// Breakevens.
    pub breakevens: u32,
    /// Net P&L.
    pub net: f64,
    /// Sum of winners.
    pub gross_profit: f64,
    /// Sum of losers (positive).
    pub gross_loss: f64,
    /// Fees.
    pub fees: f64,
    /// Net per trade.
    pub avg: f64,
    /// Winners over winners and losers (breakevens left out), percent.
    pub win_rate: Option<f64>,
    /// Gross profit over gross loss (null without losses).
    pub profit_factor: Option<f64>,
    /// Average winner.
    pub avg_win: f64,
    /// Average loser (positive).
    pub avg_loss: f64,
    /// win rate × average winner − loss rate × average loser.
    pub expectancy: f64,
    /// Trades with a known R.
    pub n_r: u32,
    /// Sum of R.
    pub total_r: Option<f64>,
    /// Average R.
    pub avg_r: Option<f64>,
    /// Trades with an R on their initial risk (from their recorded activity).
    pub n_r_initial: u32,
    /// Mean R on the initial risk.
    pub avg_r_initial: Option<f64>,
    /// Distinct trade dates.
    pub days: u32,
}

/// The headline statistics of a set of trades.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The closed trades, measured as one bucket.
    pub all: Bucket,
    /// Trades still open (not measured).
    pub open: u32,
    /// Wilson 95% interval of the win rate, percent.
    pub win_rate_low: Option<f64>,
    /// Upper end.
    pub win_rate_high: Option<f64>,
    /// Average winner over average loser.
    pub payoff_ratio: Option<f64>,
    /// Best trade.
    pub largest_win: f64,
    /// Worst trade.
    pub largest_loss: f64,
    /// Mean over sample standard deviation of trade P&L (per trade, not annualized).
    pub sharpe: Option<f64>,
    /// Mean over the downside deviation of losing trades.
    pub sortino: Option<f64>,
    /// Average winner in R.
    pub avg_win_r: Option<f64>,
    /// Average loser in R (negative).
    pub avg_loss_r: Option<f64>,
    /// Deepest drawdown of the equity curve (money, from its peak).
    pub max_drawdown: f64,
    /// That drawdown as a percent of its peak.
    pub max_drawdown_pct: Option<f64>,
    /// How far the curve is below its peak now.
    pub current_drawdown: f64,
    /// Net over the deepest drawdown.
    pub recovery_factor: Option<f64>,
    /// Calmar ratio: the net annualized over the calendar span from the first entry to the last
    /// exit (× 365 / days, a day at least) over the deepest drawdown, both in money; null without
    /// a drawdown. (TheTraderLog's divides the net as a percent of the curve's peak by the
    /// drawdown's percent of its own peak and annualizes calendar days by 252; with no account
    /// capital the journal measures both in money.)
    pub calmar: Option<f64>,
    /// Root mean square of drawdown percent over trades.
    pub ulcer_index: f64,
    /// Share of trades closed below the curve's peak, percent.
    pub time_in_drawdown_pct: f64,
    /// Drawdowns of at least $1.
    pub drawdowns: u32,
    /// Average time held, seconds.
    pub avg_hold_secs: Option<f64>,
    /// Average time winners were held.
    pub avg_hold_win_secs: Option<f64>,
    /// Average time losers were held.
    pub avg_hold_loss_secs: Option<f64>,
    /// Current streak: positive wins, negative losses (a breakeven ends it).
    pub current_streak: i32,
    /// Longest run of winners.
    pub max_win_streak: u32,
    /// Longest run of losers.
    pub max_loss_streak: u32,
    /// Kelly fraction measured from these trades, percent (0 without an edge).
    pub kelly_pct: Option<f64>,
    /// Days with a profit.
    pub green_days: u32,
    /// Days with a loss.
    pub red_days: u32,
    /// Net per trading day.
    pub avg_day: Option<f64>,
    /// Best day.
    pub best_day: Option<Bucket>,
    /// Worst day.
    pub worst_day: Option<Bucket>,
    /// Average MAE (money), over trades with bars.
    pub avg_mae: Option<f64>,
    /// Average MFE (money; hindsight).
    pub avg_mfe: Option<f64>,
    /// Trades with MAE/MFE.
    pub n_excursion: u32,
    /// First trade's entry.
    #[ts(type = "number | null")]
    pub first: Option<Timestamp>,
    /// Last trade's exit.
    #[ts(type = "number | null")]
    pub last: Option<Timestamp>,
}

/// One point of the equity curve (one per closed trade, by exit time).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EquityPoint {
    /// Trade number (1-based).
    pub i: u32,
    /// Trade id.
    pub trade_id: String,
    /// Exit time.
    #[ts(type = "number")]
    pub t: Timestamp,
    /// The trade's net.
    pub pnl: f64,
    /// Cumulative net.
    pub equity: f64,
    /// Highest cumulative net so far (from 0).
    pub peak: f64,
    /// Peak − equity.
    pub drawdown: f64,
}

/// A drawdown: from a peak of the curve to its recovery.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrawdownPeriod {
    /// Exit time of the trade at the peak.
    #[ts(type = "number")]
    pub start: Timestamp,
    /// Exit time at the trough.
    #[ts(type = "number")]
    pub trough: Timestamp,
    /// Exit time of the trade that recovered it; null while it lasts.
    #[ts(type = "number | null")]
    pub recovered: Option<Timestamp>,
    /// Curve at the peak.
    pub peak: f64,
    /// Depth (money).
    pub depth: f64,
    /// Depth as a percent of the peak.
    pub depth_pct: Option<f64>,
    /// Trades closed below the peak.
    pub trades: u32,
}

/// Streaks of winners and losers.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Streaks {
    /// How many winning runs of each length (index 0 = length 1).
    pub win_runs: Vec<u32>,
    /// How many losing runs of each length.
    pub loss_runs: Vec<u32>,
    /// Trades inside winning runs of two or more.
    pub in_win_runs: Bucket,
    /// Trades inside losing runs of two or more.
    pub in_loss_runs: Bucket,
}

/// The trade that follows an outcome (TheTraderLog's revenge-trading panel, measured).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Sequences {
    /// Trades right after a winner.
    pub after_win: Bucket,
    /// Trades right after a loser.
    pub after_loss: Bucket,
    /// After exactly one loser in a row.
    pub after_1_loss: Bucket,
    /// After two in a row.
    pub after_2_losses: Bucket,
    /// After three or more.
    pub after_3_losses: Bucket,
    /// Pearson correlation of trades per day with that day's net (5 days or more).
    pub trades_per_day_correlation: Option<f64>,
}

/// The breakdowns of a report.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Breakdowns {
    /// Per trade date.
    pub day: Vec<Bucket>,
    /// Per week (Monday).
    pub week: Vec<Bucket>,
    /// Per month.
    pub month: Vec<Bucket>,
    /// Per weekday of the trade date (Mon … Sun).
    pub weekday: Vec<Bucket>,
    /// Per entry hour.
    pub hour: Vec<Bucket>,
    /// Per session of the entry.
    pub session: Vec<Bucket>,
    /// Per symbol.
    pub symbol: Vec<Bucket>,
    /// Long and short.
    pub side: Vec<Bucket>,
    /// Per setup (and none).
    pub setup: Vec<Bucket>,
    /// Per tag (a trade counts under each of its tags).
    pub tag: Vec<Bucket>,
    /// Per account.
    pub account: Vec<Bucket>,
    /// Per time held.
    pub hold: Vec<Bucket>,
    /// Per position size.
    pub size: Vec<Bucket>,
    /// Per R range.
    pub r: Vec<Bucket>,
    /// Per planned reward to risk.
    pub planned_rr: Vec<Bucket>,
    /// Days grouped by how many trades they had.
    pub trades_per_day: Vec<Bucket>,
    /// Per mood.
    pub emotion: Vec<Bucket>,
    /// Per result (target, stop…).
    pub result: Vec<Bucket>,
}

/// `journal.get_stats` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetStatsInput {
    /// Which trades.
    pub filter: Option<TradeFilter>,
    /// Leave out the equity curve and the per-day breakdown (smaller answers for agents).
    pub compact: Option<bool>,
}

/// `journal.get_stats` output: measured statistics of the closed trades a filter keeps.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalStats {
    /// The breakeven band used (± money).
    pub breakeven_threshold: f64,
    /// The time zone clock times and entry hours are read in (the user’s).
    pub timezone: String,
    /// Headline statistics.
    pub overview: Overview,
    /// The equity curve.
    pub equity: Vec<EquityPoint>,
    /// The ten deepest drawdowns.
    pub drawdowns: Vec<DrawdownPeriod>,
    /// Breakdowns.
    pub by: Breakdowns,
    /// Streaks.
    pub streaks: Streaks,
    /// What follows a win or a loss.
    pub sequences: Sequences,
    /// How stops were placed and managed, from the recorded activity.
    pub behaviour: StopBehaviour,
    /// Per symbol and month (of the trade date), by month then symbol.
    pub by_symbol_month: Vec<SymbolMonth>,
}

/// One symbol's closed trades in one month.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMonth {
    /// Symbol (`NQ`).
    pub symbol: String,
    /// Month of the trade dates, `YYYY-MM`.
    pub month: String,
    /// Net P&L.
    pub net: f64,
    /// Closed trades.
    pub n: u32,
}

/// How the trader's stops were placed and managed, measured from the recorded order activity of
/// the closed trades. Every bucket carries its n; under 20 trades a rate is mostly noise.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StopBehaviour {
    /// Closed trades with recorded activity.
    pub n_activity: u32,
    /// Of those, reconstructed in part (stored orders, the audit, a resync).
    pub n_partial: u32,
    /// Closed trades a stop covered at some time.
    pub n_stop: u32,
    /// Stop widened at least once, never widened (trades with a stop).
    pub widened: Vec<Bucket>,
    /// Never moved, tightened once, tightened twice or more, widened at least once.
    pub management: Vec<Bucket>,
    /// The stop reached the entry (then: stopped there or past it, the target, closed otherwise),
    /// or never did.
    pub breakeven: Vec<Bucket>,
    /// Time open with no working stop.
    pub unprotected: Vec<Bucket>,
    /// How trades ended: stop, target, by hand, liquidation.
    pub ended_by: Vec<Bucket>,
    /// Time from the entry to the first stop move.
    pub first_move: Vec<Bucket>,
    /// Mean initial risk (money).
    pub avg_initial_risk: Option<f64>,
    /// Mean initial risk in ticks.
    pub avg_initial_risk_ticks: Option<f64>,
    /// Mean stop moves per trade with a stop.
    pub avg_moves: Option<f64>,
    /// Mean seconds without a working stop.
    pub avg_unprotected_secs: Option<f64>,
    /// Share of trades open a second or more without a stop, percent.
    pub unprotected_pct: Option<f64>,
    /// The earliest moment from which these trades' accounts are recorded as they change.
    #[ts(type = "number | null")]
    pub recorded_since: Option<Timestamp>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDay {
    /// Trade date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub date: NaiveDate,
    /// Closed trades measured.
    pub stats: Bucket,
    /// The day has a journal entry.
    pub journaled: bool,
    /// Closed trades not yet reviewed.
    pub unreviewed: u32,
}

/// `journal.get_calendar` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetCalendarInput {
    /// First date (default: the first of this month).
    #[ts(as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub from: Option<NaiveDate>,
    /// Last date (default: the end of `from`'s month).
    #[ts(as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub to: Option<NaiveDate>,
    /// Which trades (its dates are replaced by the range).
    pub filter: Option<TradeFilter>,
}

/// `journal.get_calendar` output: the days with trades or an entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CalendarOutput {
    /// First date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub from: NaiveDate,
    /// Last date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub to: NaiveDate,
    /// Days with trades or an entry.
    pub days: Vec<CalendarDay>,
    /// The range measured as one bucket.
    pub total: Bucket,
    /// Trading days in a row journaled, back from the latest (non-trading days skipped).
    pub journal_streak: u32,
}

/// An item of the daily checklist as ticked on a day.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistState {
    /// Item id.
    pub id: String,
    /// Its text.
    pub text: String,
    /// Ticked.
    pub checked: bool,
}

/// `journal.get_day` / `journal.save_day` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DayEntry {
    /// The date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub date: NaiveDate,
    /// The entry (Markdown).
    pub content: String,
    /// When the trader started the day's journal.
    #[ts(type = "number | null")]
    pub started_at: Option<Timestamp>,
    /// Last saved.
    #[ts(type = "number | null")]
    pub updated_at: Option<Timestamp>,
    /// The checklist.
    pub checklist: Vec<ChecklistState>,
    /// The day's trades (by trade date), oldest first.
    pub trades: Vec<JournalTrade>,
    /// The day measured.
    pub stats: Bucket,
    /// Files.
    pub attachments: Vec<AttachmentInfo>,
    /// The trading day before (with trades or an entry).
    #[ts(type = "string | null")]
    #[schemars(with = "Option<String>")]
    pub prev: Option<NaiveDate>,
    /// The one after.
    #[ts(type = "string | null")]
    #[schemars(with = "Option<String>")]
    pub next: Option<NaiveDate>,
}

/// `journal.get_day` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetDayInput {
    /// The date (`YYYY-MM-DD`).
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub date: NaiveDate,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Colour.
    pub color: String,
    /// Group (`Mistake`), or empty.
    pub group: String,
    /// Trades carrying it.
    pub uses: u32,
    /// Net P&L of its closed trades.
    pub net: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetupRule {
    /// Id.
    pub id: String,
    /// Text.
    pub text: String,
    /// `entry`, `exit`, `risk` or `management`.
    pub category: String,
}

/// A setup (TheTraderLog's strategy, a playbook): what it is, how it is entered and exited, and
/// its rules.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// What it is.
    pub description: String,
    /// Colour.
    pub color: String,
    /// When to enter.
    pub entry_criteria: String,
    /// How to exit.
    pub exit_rules: String,
    /// Rules checked per trade.
    pub rules: Vec<SetupRule>,
    /// Shown for new trades.
    pub active: bool,
    /// The Research study it trades (`research.get_study`): set when the analyst traded one, or
    /// when its trades were studied in Research.
    pub study_id: Option<String>,
    /// Created.
    #[ts(type = "number")]
    pub created_at: Timestamp,
    /// Its closed trades measured.
    pub stats: Bucket,
    /// Per rule: trades where it was followed, over trades of the setup.
    pub adherence: Vec<RuleAdherence>,
}

/// How often a rule was followed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RuleAdherence {
    /// Rule id.
    pub rule_id: String,
    /// Trades it was ticked on.
    pub followed: u32,
    /// Trades of the setup.
    pub trades: u32,
}

/// An account the journal holds trades of.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalAccount {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Where its trades come from.
    pub origin: FillOrigin,
    /// The platform of an imported account.
    pub platform: Option<Platform>,
    /// Trades.
    pub trades: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavedFilter {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// The filter.
    pub filter: TradeFilter,
    /// The trades list opens with it (one at most).
    #[serde(default)]
    pub is_default: bool,
}

/// An item of the daily checklist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    /// Id.
    pub id: String,
    /// Text.
    pub text: String,
    /// Shown on new days.
    pub active: bool,
}

/// A trading session, by wall-clock time in its own time zone (`18:00`–`03:00` wraps).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionDef {
    /// Name.
    pub name: String,
    /// Start, `HH:MM`.
    pub start: String,
    /// End, `HH:MM` (exclusive).
    pub end: String,
    /// The IANA time zone its start and end are in (the market's own: `Europe/London` for London).
    pub timezone: String,
}

/// The journal's own settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalSettings {
    /// Net P&L within ± this is breakeven (default $3, TheTraderLog's).
    pub breakeven_threshold: f64,
    /// Sessions, each in its own market's time zone. A trade is in every session its entry falls
    /// in. Clock times and entry hours are read in the user’s time zone
    /// (`display.timeZone`, Settings › App).
    pub sessions: Vec<SessionDef>,
}

impl Default for JournalSettings {
    fn default() -> Self {
        let s = |name: &str, start: &str, end: &str, zone: &str| SessionDef {
            name: name.into(),
            start: start.into(),
            end: end.into(),
            timezone: zone.into(),
        };
        Self {
            breakeven_threshold: 3.0,
            sessions: vec![
                s("Asia", "18:00", "03:00", "America/New_York"),
                s("London", "08:00", "14:30", "Europe/London"),
                s("New York", "09:30", "16:00", "America/New_York"),
                s("After hours", "16:00", "18:00", "America/New_York"),
            ],
        }
    }
}

/// An import done.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportInfo {
    /// Id.
    pub id: String,
    /// Platform.
    pub platform: Platform,
    /// Format read.
    pub format: String,
    /// File name.
    pub filename: Option<String>,
    /// Account it went to.
    pub account_id: String,
    /// When.
    #[ts(type = "number")]
    pub created_at: Timestamp,
    /// Fills added.
    pub fills: u32,
    /// Fills already in the journal.
    pub duplicates: u32,
}

/// A platform the journal imports from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// Id.
    pub id: Platform,
    /// Name.
    pub name: String,
    /// The export to take.
    pub hint: String,
}

/// `journal.get_catalog` output: everything the journal's screens pick from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalCatalog {
    /// Accounts with trades.
    pub accounts: Vec<JournalAccount>,
    /// Symbols traded.
    pub symbols: Vec<String>,
    /// Tags.
    pub tags: Vec<Tag>,
    /// Setups with their measured stats.
    pub setups: Vec<Setup>,
    /// Saved filters.
    pub filters: Vec<SavedFilter>,
    /// The daily checklist.
    pub checklist: Vec<ChecklistItem>,
    /// Settings.
    pub settings: JournalSettings,
    /// Imports done.
    pub imports: Vec<ImportInfo>,
    /// Platforms to import from.
    pub platforms: Vec<PlatformInfo>,
    /// Trades in the journal.
    pub trades: u32,
    /// Trades in the Trash.
    pub trash: u32,
    /// Since when each account's orders are recorded.
    pub activity: Vec<ActivityAccount>,
    /// Changes so far (matches `journal.changes`).
    #[ts(type = "number")]
    pub revision: u64,
}

/// Empty input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

/// `journal.update_trade` input: what the trader adds to a trade. Absent fields stay; `null`
/// clears.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTradeInput {
    /// Trade id.
    pub id: String,
    /// Notes (Markdown).
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub notes: Clearable<String>,
    /// Setup id.
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub setup_id: Clearable<String>,
    /// Rating 1–5.
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<u8>")]
    #[schemars(with = "Option<u8>")]
    pub rating: Clearable<u8>,
    /// Reviewed.
    #[serde(default)]
    #[ts(optional)]
    pub reviewed: Option<bool>,
    /// Mood.
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<Emotion>")]
    #[schemars(with = "Option<Emotion>")]
    pub emotion: Clearable<Emotion>,
    /// Exit reason.
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<ExitReason>")]
    #[schemars(with = "Option<ExitReason>")]
    pub exit_reason: Clearable<ExitReason>,
    /// Planned stop (overrides the order's).
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<f64>")]
    #[schemars(with = "Option<f64>")]
    pub stop_price: Clearable<f64>,
    /// Planned target.
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<f64>")]
    #[schemars(with = "Option<f64>")]
    pub target_price: Clearable<f64>,
    /// The tags (replaces them all).
    #[serde(default)]
    #[ts(optional)]
    pub tag_ids: Option<Vec<String>>,
    /// Rules ticked (rule id → followed).
    #[serde(default)]
    #[ts(optional)]
    pub rules: Option<Vec<RuleTick>>,
}

/// One rule ticked or not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleTick {
    /// Rule id.
    pub rule_id: String,
    /// Followed.
    pub checked: bool,
}

/// `journal.bulk_update` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct BulkUpdateInput {
    /// Trade ids.
    pub ids: Vec<String>,
    /// Mark reviewed or not.
    #[serde(default)]
    pub reviewed: Option<bool>,
    /// Rating (0 clears).
    #[serde(default)]
    pub rating: Option<u8>,
    /// Setup id (empty clears).
    #[serde(default)]
    pub setup_id: Option<String>,
    /// Tags to add.
    #[serde(default)]
    pub add_tags: Option<Vec<String>>,
    /// Tags to remove.
    #[serde(default)]
    pub remove_tags: Option<Vec<String>>,
}

/// How many trades a change touched.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    /// Trades changed.
    pub changed: u32,
}

/// `journal.save_tag` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SaveTagInput {
    /// Id of the tag to change (new without).
    #[serde(default)]
    pub id: Option<String>,
    /// Name.
    pub name: String,
    /// Colour (`#rrggbb`).
    #[serde(default)]
    pub color: Option<String>,
    /// Group (`Mistake`).
    #[serde(default)]
    pub group: Option<String>,
}

/// Input naming one thing by id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdInput {
    /// Id.
    pub id: String,
}

/// A rule as written in `journal.save_setup`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SetupRuleInput {
    /// Id of a rule kept (new without).
    #[serde(default)]
    pub id: Option<String>,
    /// Text.
    pub text: String,
    /// `entry`, `exit`, `risk` or `management` (default `entry`).
    #[serde(default)]
    pub category: Option<String>,
}

/// `journal.save_setup` input. Absent fields stay as they are.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SaveSetupInput {
    /// Id of the setup to change (new without).
    #[serde(default)]
    pub id: Option<String>,
    /// Name.
    #[serde(default)]
    pub name: Option<String>,
    /// What it is.
    #[serde(default)]
    pub description: Option<String>,
    /// Colour.
    #[serde(default)]
    pub color: Option<String>,
    /// When to enter.
    #[serde(default)]
    pub entry_criteria: Option<String>,
    /// How to exit.
    #[serde(default)]
    pub exit_rules: Option<String>,
    /// The rules (replaces them; ticks of rules kept by id stay).
    #[serde(default)]
    pub rules: Option<Vec<SetupRuleInput>>,
    /// Active.
    #[serde(default)]
    pub active: Option<bool>,
    /// The Research study it trades; null unlinks it.
    #[serde(default, deserialize_with = "clearable")]
    #[ts(optional = nullable, as = "Option<String>")]
    #[schemars(with = "Option<String>")]
    pub study_id: Clearable<String>,
}

/// `journal.save_day` input.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SaveDayInput {
    /// The date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub date: NaiveDate,
    /// The entry (Markdown; replaces it).
    #[serde(default)]
    pub content: Option<String>,
    /// Start the day's journal now.
    #[serde(default)]
    pub start: Option<bool>,
    /// Checklist items ticked or not.
    #[serde(default)]
    pub checks: Option<Vec<RuleTick>>,
}

/// `journal.save_checklist` input: the whole checklist, in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveChecklistInput {
    /// Items (ids of items kept; new ones without).
    pub items: Vec<ChecklistItemInput>,
}

/// One checklist item as written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ChecklistItemInput {
    /// Id (kept items).
    #[serde(default)]
    pub id: Option<String>,
    /// Text.
    pub text: String,
    /// Shown on days (default true).
    #[serde(default)]
    pub active: Option<bool>,
}

/// `journal.save_checklist` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistOutput {
    /// The checklist.
    pub items: Vec<ChecklistItem>,
}

/// Where imported trades go: an account the journal has, or a new one by name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ImportAccount {
    /// An imported account's id.
    #[serde(default)]
    pub id: Option<String>,
    /// A new account's name.
    #[serde(default)]
    pub name: Option<String>,
}

/// `journal.preview_import` / `journal.import_csv` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ImportInput {
    /// The file's text.
    pub csv: String,
    /// File name.
    #[serde(default)]
    pub filename: Option<String>,
    /// Platform (detected from the columns when absent).
    #[serde(default)]
    pub platform: Option<Platform>,
    /// Destination (default: a new account named after the platform).
    #[serde(default)]
    pub account: Option<ImportAccount>,
    /// IANA zone of times written without an offset or a named zone (default the user's time zone, `display.timeZone`).
    #[serde(default)]
    pub timezone: Option<String>,
}

/// A trade an import makes, as previewed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTrade {
    /// Symbol.
    pub symbol: String,
    /// Contract.
    pub instrument: String,
    /// Long or short.
    pub side: Side,
    /// Quantity.
    pub qty: f64,
    /// Entry.
    pub entry_price: f64,
    /// Exit.
    pub exit_price: Option<f64>,
    /// Entry time.
    #[ts(type = "number")]
    pub opened_at: Timestamp,
    /// Exit time.
    #[ts(type = "number | null")]
    pub closed_at: Option<Timestamp>,
    /// Net P&L from the contract spec.
    pub net_pnl: f64,
    /// The platform's P&L, when it says.
    pub reported_pnl: Option<f64>,
    /// Price decimals.
    pub price_decimals: u32,
}

/// `journal.preview_import` / `journal.import_csv` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Platform read.
    pub platform: Platform,
    /// Format read.
    pub format: String,
    /// Data rows.
    pub rows: u32,
    /// Fills read.
    pub fills: u32,
    /// Fills new to the journal.
    pub new_fills: u32,
    /// Fills it already has (a file imported twice adds nothing).
    pub duplicates: u32,
    /// Trades the new fills make.
    pub trades: u32,
    /// Rows left out.
    pub skipped: u32,
    /// Rows that could not be read.
    pub errors: Vec<RowError>,
    /// What to know.
    pub warnings: Vec<String>,
    /// The first trades.
    pub preview: Vec<PreviewTrade>,
    /// The import (`journal.import_csv`).
    pub import_id: Option<String>,
    /// The account they went to.
    pub account_id: Option<String>,
    /// Symbols without a known point value (their P&L is in points).
    pub unknown_symbols: Vec<String>,
}

/// `journal.log_trade` input: a trade written by hand.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LogTradeInput {
    /// Account: a journal account id, or a new account's name.
    pub account: String,
    /// Contract (`NQZ6`, `MNQ`, `ES 12-26`, `QQQ`).
    pub symbol: String,
    /// `buy` for a long.
    pub side: Side,
    /// Quantity.
    pub qty: f64,
    /// Entry price.
    pub entry_price: f64,
    /// Entry time (RFC 3339).
    pub entry_time: String,
    /// Exit price.
    #[serde(default)]
    pub exit_price: Option<f64>,
    /// Exit time.
    #[serde(default)]
    pub exit_time: Option<String>,
    /// Fees.
    #[serde(default)]
    pub fees: Option<f64>,
    /// Planned stop.
    #[serde(default)]
    pub stop_price: Option<f64>,
    /// Planned target.
    #[serde(default)]
    pub target_price: Option<f64>,
    /// Setup id.
    #[serde(default)]
    pub setup_id: Option<String>,
    /// Notes.
    #[serde(default)]
    pub notes: Option<String>,
}

/// `journal.add_attachment` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AddAttachmentInput {
    /// The trade it belongs to.
    #[serde(default)]
    pub trade_id: Option<String>,
    /// Or the day.
    #[serde(default)]
    pub date: Option<String>,
    /// File name.
    pub filename: String,
    /// Media type (images and PDF).
    pub media_type: String,
    /// The bytes, base64 (10 MB at most).
    pub data_base64: String,
    /// Caption.
    #[serde(default)]
    pub caption: Option<String>,
}

/// `journal.get_attachment` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentData {
    /// The file.
    pub info: AttachmentInfo,
    /// The bytes, base64.
    pub data_base64: String,
}

/// `journal.save_filter` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SaveFilterInput {
    /// Id of the filter to replace (new without).
    #[serde(default)]
    pub id: Option<String>,
    /// Name.
    pub name: String,
    /// The filter.
    pub filter: TradeFilter,
    /// Make it the default (the others stop being it) or not; absent keeps what it was.
    #[serde(default)]
    pub is_default: Option<bool>,
}

/// `journal.set_settings` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SetSettingsInput {
    /// Breakeven band (± money).
    #[serde(default)]
    pub breakeven_threshold: Option<f64>,
    /// Sessions.
    #[serde(default)]
    pub sessions: Option<Vec<SessionDef>>,
}

/// `journal.export_trades` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ExportInput {
    /// Which trades.
    pub filter: Option<TradeFilter>,
}

/// `journal.export_trades` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutput {
    /// Suggested file name.
    pub filename: String,
    /// The CSV.
    pub csv: String,
    /// Trades in it.
    pub trades: u32,
}

/// `journal.search` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct SearchInput {
    /// Words (two letters or more).
    pub query: String,
    /// Most hits (default 20).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// A note that matched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// `trade` or `day`.
    pub kind: String,
    /// Trade id, or the date.
    pub id: String,
    /// What it is (`NQ long · 2 Oct`, `Fri 2 Oct`).
    pub title: String,
    /// The words around the match.
    pub snippet: String,
    /// Trade date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub date: NaiveDate,
}

/// `journal.search` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutput {
    /// Hits, newest first.
    pub hits: Vec<SearchHit>,
}

/// `journal.changes`: the journal changed (fills arrived, an import, an edit). Read again what
/// is shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalChange {
    /// Changes so far.
    #[ts(type = "number")]
    pub revision: u64,
    /// `fills`, `activity`, `import`, `edit`, `trash`, `drawings`, `snapshot`.
    pub reason: String,
    /// Trades touched (empty: many or none in particular).
    pub trade_ids: Vec<String>,
}

/// `journal.bulk_delete` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkDeleteInput {
    /// Trade ids.
    pub ids: Vec<String>,
}

/// `journal.bulk_delete` output.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkDeleteOutput {
    /// Trades moved to the Trash.
    pub changed: u32,
    /// A connection's trades left where they are (its record of its fills).
    pub skipped: u32,
}

/// A trade in the Trash, as it was.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrashedTrade {
    /// The trade, built again from its fills (its id is the one it had).
    pub trade: JournalTrade,
    /// When it was deleted.
    #[ts(type = "number")]
    pub trashed_at: Timestamp,
}

/// `journal.list_trash` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TrashOutput {
    /// Trades in the Trash, latest deleted first.
    pub trades: Vec<TrashedTrade>,
}

/// `journal.purge_trash` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct PurgeTrashInput {
    /// Trades to delete for good (absent: empty the Trash).
    pub ids: Option<Vec<String>>,
}

/// `journal.get_compliance` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetComplianceInput {
    /// Which trades.
    pub filter: Option<TradeFilter>,
}

/// Rules followed per category, as a fraction (0–1) of the rules checked; null when no rule of
/// the category applied.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComplianceByCategory {
    /// Entry rules.
    pub entry: Option<f64>,
    /// Exit rules.
    pub exit: Option<f64>,
    /// Risk rules.
    pub risk: Option<f64>,
    /// Management rules.
    pub management: Option<f64>,
}

/// A setup rule not followed, and on how many trades.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MissedRule {
    /// Rule id.
    pub rule_id: String,
    /// Its text.
    pub rule_name: String,
    /// `entry`, `exit`, `risk` or `management`.
    pub category: String,
    /// Its setup.
    pub setup_id: String,
    /// The setup's name.
    pub setup_name: String,
    /// Trades it was not ticked on.
    pub count: u32,
}

/// `journal.get_compliance` output: how often setup rules were followed, over the closed trades a
/// filter keeps whose setup has rules (TheTraderLog's rule compliance). Every rule of a trade's
/// setup counts once per trade; a rule not ticked counts as not followed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComplianceOutput {
    /// Rules followed over rules checked, 0–1; null without such trades.
    pub overall: Option<f64>,
    /// Closed trades with a setup that has rules.
    pub trades_with_setups: u32,
    /// Per rule category.
    pub by_category: ComplianceByCategory,
    /// The rules missed most (ten at most), most first.
    pub missed: Vec<MissedRule>,
}

/// `journal.recent_days` input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct RecentDaysInput {
    /// Most days (1 to 100).
    pub limit: u32,
    /// Accounts the days' P&L and trades are counted over (default every account).
    #[serde(default)]
    pub accounts: Option<Vec<String>>,
}

/// A day's journal entry with what was traded that day.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecentDay {
    /// The date.
    #[ts(type = "string")]
    #[schemars(with = "String")]
    pub date: NaiveDate,
    /// The entry (Markdown).
    pub content: String,
    /// Net P&L of the day's closed trades; null without any.
    pub net_pnl: Option<f64>,
    /// The day's trades (by trade date, open ones too).
    pub trades: u32,
}

/// `journal.recent_days` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecentDaysOutput {
    /// Days with an entry, newest first.
    pub days: Vec<RecentDay>,
}

/// `journal.save_trade_drawings` input.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveTradeDrawingsInput {
    /// Trade id.
    pub trade_id: String,
    /// What was drawn on its chart (the chart's own JSON, kept as given; replaces it; empty
    /// removes it).
    pub drawings: Vec<Value>,
}
