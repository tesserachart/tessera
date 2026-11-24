use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::Timestamp;
use tessera_core::accounts::Environment;
use tessera_core::orders::Side;
use ts_rs::TS;

/// A card the chat shows where a tool call made it, kept and updated by the runtime: its body
/// changes live (topic `cards`), and each action is a tool call that goes through the same
/// permission gate as any other.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    /// Its id (`card-…`): the same card updates in place.
    pub id: String,
    /// What it shows.
    pub body: CardBody,
    /// What can be done from it, in order.
    #[serde(default)]
    pub actions: Vec<CardAction>,
    /// When it last changed.
    #[ts(type = "number")]
    pub updated_at: Timestamp,
}

/// A card's content, by kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CardBody {
    /// Which trading days of a market have their prints and bars on this machine.
    DataCoverage(DataCoverage),
    /// A trading session the analyst ran on its own: its trades, its log and what went wrong.
    TradingSession(TradingSessionReport),
}

/// One thing a card offers: a tool call made as the user when pressed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CardAction {
    /// Its words (`Download 12 days`).
    pub label: String,
    /// The tool it calls.
    pub tool: String,
    /// The tool's input.
    pub input: Value,
    /// The card's main action.
    #[serde(default)]
    pub primary: bool,
}

/// Saved and missing days of one market over a span of trade dates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DataCoverage {
    /// The market as asked (`NQ` follows the roll; `NQZ6.CME` is one contract).
    pub symbol: String,
    /// The part of each day counted: `rth` or `session`.
    pub scope: String,
    /// First trade date, `YYYY-MM-DD`.
    pub from: String,
    /// Last trade date.
    pub to: String,
    /// Every trading day of the span, oldest first.
    pub days: Vec<CoverageDay>,
    /// The download of its missing prints, once one is asked for.
    #[serde(default)]
    pub download: Option<CoverageDownload>,
}

/// A download of a market's missing prints through the connection's tick replay, one day at a
/// time in the background, following the roll for a root.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoverageDownload {
    /// The pull it is (`market.list_pulls`, `market.cancel_pull`).
    pub pull_id: String,
    /// `running`, `cancelled` or `done`.
    pub state: String,
    /// Trading days it covers.
    pub days: u32,
    /// Days with an answer: fetched, found already saved, or without trades.
    pub done: u32,
    /// Days that failed (a resume asks them once more).
    pub failed: u32,
    /// Days older than the connection keeps history for.
    pub out_of_reach: u32,
    /// The day being fetched, `YYYY-MM-DD`.
    pub current: Option<String>,
    /// Its half-hour pieces answered so far.
    pub pieces_done: u32,
    /// The pieces it needs.
    pub pieces: u32,
    /// Seconds left at the pace so far.
    #[ts(type = "number | null")]
    pub eta_seconds: Option<u64>,
    /// The connection it waits for, while it waits.
    pub waiting_for: Option<String>,
    /// Why that connection cannot answer now, in a few plain words; none while it is only not
    /// connected yet.
    #[serde(default)]
    pub waiting_why: Option<String>,
    /// Days of the span it fetches: the days not saved whole when it reached them.
    #[serde(default)]
    pub fetching: u32,
    /// Of those, the days fetched and saved.
    #[serde(default)]
    pub fetched: u32,
    /// Days the connection has not sent all of yet (asked again later).
    #[serde(default)]
    pub later: u32,
    /// Started by Tessera itself (setting `market.autoDownload`), not by a press.
    #[serde(default)]
    pub auto: bool,
}

/// One trading day's data on this machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CoverageDay {
    /// The trade date, `YYYY-MM-DD`.
    pub date: String,
    /// The dated contract that day (the front month, for a root).
    pub contract: String,
    /// Its prints (each trade with its aggressor side).
    pub prints: Held,
    /// Its 1-minute bars.
    pub bars: Held,
    /// Older than the connection keeps: no download can fetch it.
    #[serde(default)]
    pub out_of_reach: bool,
    /// Why its prints are not saved whole, in a few plain words (`older than Rithmic keeps`,
    /// `today's session is still open`).
    #[serde(default)]
    pub note: Option<String>,
}

/// How much of a day is held.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Held {
    /// All of the day's part.
    Saved,
    /// Some of it.
    Partial,
    /// None of it.
    Missing,
}

/// The report of one trading session the analyst ran for the user (Settings › Analyst › Trading
/// sessions): written into the session's chat and the journal's day when it ends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TradingSessionReport {
    /// The trade date, `YYYY-MM-DD`.
    pub date: String,
    /// The account it traded.
    pub account_id: String,
    /// The account as the user knows it.
    pub account_name: String,
    /// Its environment.
    pub environment: Environment,
    /// When it started.
    #[ts(type = "number")]
    pub started_at: Timestamp,
    /// When it ended.
    #[ts(type = "number")]
    pub ended_at: Timestamp,
    /// The trades it opened, from the journal, oldest first.
    pub trades: Vec<SessionTrade>,
    /// Their net P&L, in the account's currency.
    pub net_pnl: f64,
    /// What the analyst did and why, in its own words (Markdown).
    pub log: String,
    /// What went wrong or slowed it down, each filed as an issue when the user named a repository.
    pub issues: Vec<SessionIssue>,
}

/// One trade of a trading session, as the journal has it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionTrade {
    /// The journal's trade id.
    pub id: String,
    /// What it is grouped by (`MNQ`).
    pub symbol: String,
    /// `buy` for a long, `sell` for a short.
    pub side: Side,
    /// Contracts entered.
    pub qty: f64,
    /// Average entry.
    pub entry_price: f64,
    /// Average exit; none while open.
    pub exit_price: Option<f64>,
    /// Decimals its prices show with.
    pub price_decimals: u32,
    /// Net P&L.
    pub net_pnl: f64,
    /// Net P&L in units of its risk at the stop.
    pub r_multiple: Option<f64>,
    /// First entry.
    #[ts(type = "number")]
    pub opened_at: Timestamp,
    /// Last exit.
    #[ts(type = "number | null")]
    pub closed_at: Option<Timestamp>,
}

/// A failure or a friction of a trading session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionIssue {
    /// One line.
    pub title: String,
    /// What happened.
    pub detail: String,
    /// Who found it: `analyst` (its log) or `tessera` (a tool that failed, the runner itself).
    pub from: String,
    /// The GitHub issue it was filed as, or added to.
    pub url: Option<String>,
    /// Why it was not filed.
    pub not_filed: Option<String>,
}

/// `cards` topic params: one card's updates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CardParams {
    /// The card.
    pub card_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetCardInput {
    /// The card.
    pub card_id: String,
}
