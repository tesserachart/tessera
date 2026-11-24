use chrono_tz::Tz;
use rust_decimal::Decimal;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::Timestamp;
use tessera_core::orders::Side;
use ts_rs::TS;

use crate::csv::{self, Row, Table};
use crate::specs::ContractName;

/// A platform whose exports the journal reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    /// ProjectX Trades export.
    Projectx,
    /// TopstepX Trades export (ProjectX with a `TradeDay` column).
    Topstepx,
    /// NinjaTrader executions export.
    Ninjatrader,
    /// Tradovate Orders report or Position History.
    Tradovate,
    /// R | Trader (Rithmic) export, its Completed Orders section.
    Rithmic,
    /// Apex: one of the formats above, detected from the file.
    Apex,
}

impl Platform {
    pub const ALL: [Platform; 6] = [
        Platform::Rithmic,
        Platform::Tradovate,
        Platform::Topstepx,
        Platform::Projectx,
        Platform::Ninjatrader,
        Platform::Apex,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Platform::Projectx => "ProjectX",
            Platform::Topstepx => "TopstepX",
            Platform::Ninjatrader => "NinjaTrader",
            Platform::Tradovate => "Tradovate",
            Platform::Rithmic => "R | Trader",
            Platform::Apex => "Apex",
        }
    }

    pub fn export_hint(self) -> &'static str {
        match self {
            Platform::Projectx => "Trades export",
            Platform::Topstepx => "Trades export",
            Platform::Ninjatrader => "Executions export (Control Center, Executions, Export)",
            Platform::Tradovate => "Position History (carries P&L) or the Orders report",
            Platform::Rithmic => "Orders window export (its Completed Orders section is read)",
            Platform::Apex => "the export of the platform the account trades on",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Platform::Projectx => "projectx",
            Platform::Topstepx => "topstepx",
            Platform::Ninjatrader => "ninjatrader",
            Platform::Tradovate => "tradovate",
            Platform::Rithmic => "rithmic",
            Platform::Apex => "apex",
        }
    }

    fn matches(self, headers: &[String]) -> bool {
        match self {
            Platform::Projectx => csv::has_headers(
                headers,
                &[
                    "Id",
                    "ContractName",
                    "EnteredAt",
                    "ExitedAt",
                    "EntryPrice",
                    "ExitPrice",
                    "Size",
                    "Type",
                ],
            ),
            Platform::Topstepx => {
                Platform::Projectx.matches(headers) && csv::has_headers(headers, &["TradeDay"])
            }
            Platform::Ninjatrader => csv::has_headers(
                headers,
                &[
                    "Instrument",
                    "Action",
                    "Quantity",
                    "Price",
                    "Time",
                    "ID",
                    "E/X",
                ],
            ),
            Platform::Tradovate => {
                is_position_history(headers)
                    || (csv::has_headers(headers, &["orderId", "B/S", "Contract", "Status"])
                        && (csv::has_headers(headers, &["Fill Time"])
                            || csv::has_headers(headers, &["Timestamp"])))
            }
            Platform::Rithmic => csv::has_headers(
                headers,
                &[
                    "Account",
                    "Status",
                    "Remarks",
                    "Buy/Sell",
                    "Symbol",
                    "Avg Fill Price",
                    "Qty Filled",
                ],
            ),
            Platform::Apex => [
                Platform::Rithmic,
                Platform::Tradovate,
                Platform::Topstepx,
                Platform::Projectx,
                Platform::Ninjatrader,
            ]
            .iter()
            .any(|p| p.matches(headers)),
        }
    }
}

fn is_position_history(headers: &[String]) -> bool {
    csv::has_headers(headers, &["Position ID", "Buy Price", "Sell Price", "P/L"])
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawFill {
    pub contract: ContractName,
    pub raw_symbol: String,
    pub side: Side,
    pub qty: Decimal,
    pub price: Decimal,
    pub ts: Timestamp,
    pub fee: Option<Decimal>,
    pub external_id: Option<String>,
    pub reported_pnl: Option<Decimal>,
    pub line: usize,
}

/// A row that could not be read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RowError {
    /// 1-based line in the file.
    pub line: usize,
    /// The column at fault, as the export names it.
    pub field: Option<String>,
    /// What is wrong.
    pub message: String,
}

#[derive(Clone, Debug, Default)]
pub struct ParsedImport {
    pub format: String,
    pub fills: Vec<RawFill>,
    pub rows: usize,
    pub skipped: usize,
    pub errors: Vec<RowError>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ImportFailure {
    #[error(
        "this file's columns match no export the journal reads (ProjectX, TopstepX, NinjaTrader, Tradovate, R | Trader)"
    )]
    Unrecognized,
    #[error("this is not a {0} export: {1}")]
    WrongPlatform(&'static str, String),
    #[error("the file has no rows")]
    Empty,
}

const HEADER_SEARCH_LINES: usize = 40;

/// R | Trader puts several sections in one file, each with its own header.
fn header_candidates(content: &str) -> Vec<(usize, Vec<String>)> {
    csv::rows(content)
        .take_while(|r| r.line <= HEADER_SEARCH_LINES)
        .filter(|r| r.raw.contains(','))
        .map(|r| (r.line, r.fields))
        .collect()
}

pub fn detect(content: &str) -> Option<Platform> {
    let candidates = header_candidates(content);
    [
        Platform::Rithmic,
        Platform::Tradovate,
        Platform::Topstepx,
        Platform::Projectx,
        Platform::Ninjatrader,
    ]
    .into_iter()
    .find(|p| candidates.iter().any(|(_, h)| p.matches(h)))
}

pub fn parse(
    content: &str,
    platform: Option<Platform>,
    tz: Tz,
) -> Result<(Platform, ParsedImport), ImportFailure> {
    if content.trim().is_empty() {
        return Err(ImportFailure::Empty);
    }
    let detected = detect(content).ok_or(ImportFailure::Unrecognized)?;
    let platform = match platform {
        None | Some(Platform::Apex) => detected,
        Some(p) if p == detected || (p == Platform::Projectx && detected == Platform::Topstepx) => {
            p
        }
        Some(p) => {
            return Err(ImportFailure::WrongPlatform(
                p.name(),
                format!("its columns are {}'s", detected.name()),
            ));
        }
    };
    let mut out = match platform {
        Platform::Projectx | Platform::Topstepx => {
            let mut out = trades_projectx(&csv::table(content), tz);
            if platform == Platform::Topstepx {
                out.format = "TopstepX trades".into();
            }
            out
        }
        Platform::Ninjatrader => fills_ninjatrader(&csv::table(content), tz),
        Platform::Tradovate => {
            let t = csv::table(content);
            if is_position_history(&t.headers) {
                trades_tradovate(&t, tz)
            } else {
                fills_tradovate(&t, tz)
            }
        }
        Platform::Rithmic | Platform::Apex => fills_rithmic(content, tz),
    };
    if out.rows == 0 {
        return Err(ImportFailure::Empty);
    }
    if !out.errors.is_empty() {
        out.warnings.push(format!(
            "{} row{} could not be read and {} left out.",
            out.errors.len(),
            if out.errors.len() == 1 { "" } else { "s" },
            if out.errors.len() == 1 { "was" } else { "were" }
        ));
    }
    Ok((platform, out))
}

struct Reader<'a> {
    out: &'a mut ParsedImport,
}

impl Reader<'_> {
    fn fail(&mut self, line: usize, field: &str, message: impl Into<String>) {
        self.out.errors.push(RowError {
            line,
            field: Some(field.to_owned()),
            message: message.into(),
        });
        self.out.skipped += 1;
    }
}

#[allow(clippy::too_many_arguments)]
fn legs(
    out: &mut ParsedImport,
    line: usize,
    raw_symbol: &str,
    long: bool,
    qty: Decimal,
    entry: (Decimal, Timestamp),
    exit: Option<(Decimal, Timestamp)>,
    fee: Option<Decimal>,
    pnl: Option<Decimal>,
    id: Option<&str>,
) {
    let year = entry
        .1
        .to_datetime()
        .format("%Y")
        .to_string()
        .parse()
        .unwrap_or(2026);
    let Some(contract) = ContractName::parse(raw_symbol, year) else {
        out.errors.push(RowError {
            line,
            field: Some("symbol".into()),
            message: format!("cannot read the contract {raw_symbol:?}"),
        });
        out.skipped += 1;
        return;
    };
    let (open_side, close_side) = if long {
        (Side::Buy, Side::Sell)
    } else {
        (Side::Sell, Side::Buy)
    };
    out.fills.push(RawFill {
        contract: contract.clone(),
        raw_symbol: raw_symbol.to_owned(),
        side: open_side,
        qty,
        price: entry.0,
        ts: entry.1,
        fee: exit.is_none().then_some(fee).flatten(),
        external_id: id.map(|i| format!("{i}:in")),
        reported_pnl: None,
        line,
    });
    if let Some((price, ts)) = exit {
        out.fills.push(RawFill {
            contract,
            raw_symbol: raw_symbol.to_owned(),
            side: close_side,
            qty,
            price,
            ts,
            fee,
            external_id: id.map(|i| format!("{i}:out")),
            reported_pnl: pnl,
            line,
        });
    }
}

fn trades_projectx(t: &Table, tz: Tz) -> ParsedImport {
    let mut out = ParsedImport {
        format: "ProjectX trades".into(),
        rows: t.rows.len(),
        ..ParsedImport::default()
    };
    let mut open = 0usize;
    for (line, row) in &t.rows {
        let line = *line;
        let mut r = Reader { out: &mut out };
        let Some(symbol) = csv::field(row, &["ContractName"]) else {
            r.fail(line, "ContractName", "no contract");
            continue;
        };
        let long = match csv::field(row, &["Type"])
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("long") => true,
            Some("short") => false,
            _ => {
                r.fail(line, "Type", "Type must be Long or Short");
                continue;
            }
        };
        let Some(qty) = csv::decimal(csv::field(row, &["Size"])).filter(|q| *q > Decimal::ZERO)
        else {
            r.fail(line, "Size", "Size must be a positive number");
            continue;
        };
        let (Some(entry_px), Some(entry_t)) = (
            csv::decimal(csv::field(row, &["EntryPrice"])),
            csv::instant(csv::field(row, &["EnteredAt"]), tz),
        ) else {
            r.fail(line, "EnteredAt", "no entry price or time");
            continue;
        };
        let exit = match (
            csv::decimal(csv::field(row, &["ExitPrice"])),
            csv::instant(csv::field(row, &["ExitedAt"]), tz),
        ) {
            (Some(p), Some(t)) => Some((p, t)),
            _ => {
                open += 1;
                None
            }
        };
        let fee = match (
            csv::decimal(csv::field(row, &["Fees"])),
            csv::decimal(csv::field(row, &["Commissions"])),
        ) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or_default() + b.unwrap_or_default()),
        };
        legs(
            &mut out,
            line,
            symbol,
            long,
            qty,
            (entry_px, entry_t),
            exit,
            fee,
            csv::decimal(csv::field(row, &["PnL"])),
            csv::field(row, &["Id"]),
        );
    }
    if open > 0 {
        out.warnings.push(format!(
            "{open} trade{} had no exit yet and {} open.",
            if open == 1 { "" } else { "s" },
            if open == 1 { "stays" } else { "stay" }
        ));
    }
    out
}

fn trades_tradovate(t: &Table, tz: Tz) -> ParsedImport {
    let mut out = ParsedImport {
        format: "Tradovate position history".into(),
        rows: t.rows.len(),
        ..ParsedImport::default()
    };
    let mut open = 0usize;
    for (line, row) in &t.rows {
        let line = *line;
        let Some(symbol) = csv::field(row, &["Contract", "Product"]).map(str::to_owned) else {
            Reader { out: &mut out }.fail(line, "Product", "no contract");
            continue;
        };
        let buy = csv::decimal(csv::field(row, &["Buy Price", "Avg. Buy"]));
        let sell = csv::decimal(csv::field(row, &["Sell Price", "Avg. Sell"]));
        let bought = csv::instant(csv::field(row, &["Bought Timestamp"]), tz);
        let sold = csv::instant(csv::field(row, &["Sold Timestamp"]), tz);
        let (Some(buy), Some(sell), Some(bought), Some(sold)) = (buy, sell, bought, sold) else {
            out.skipped += 1;
            open += 1;
            continue;
        };
        let Some(qty) = csv::decimal(csv::field(row, &["Paired Qty", "Bought", "Sold"]))
            .filter(|q| *q > Decimal::ZERO)
        else {
            Reader { out: &mut out }.fail(line, "Paired Qty", "quantity must be positive");
            continue;
        };
        let long = bought <= sold;
        let (entry, exit) = if long {
            ((buy, bought), (sell, sold))
        } else {
            ((sell, sold), (buy, bought))
        };
        let id = csv::field(row, &["Pair ID", "Position ID"]).map(str::to_owned);
        legs(
            &mut out,
            line,
            &symbol,
            long,
            qty,
            entry,
            Some(exit),
            None,
            csv::decimal(csv::field(row, &["P/L"])),
            id.as_deref(),
        );
    }
    if open > 0 {
        out.warnings.push(format!(
            "{open} open position{} left out.",
            if open == 1 { " was" } else { "s were" }
        ));
    }
    out
}

fn push_fill(out: &mut ParsedImport, line: usize, raw: &str, f: Fill1) {
    let year =
        f.ts.to_datetime()
            .format("%Y")
            .to_string()
            .parse()
            .unwrap_or(2026);
    let Some(contract) = ContractName::parse(raw, year) else {
        out.errors.push(RowError {
            line,
            field: Some("symbol".into()),
            message: format!("cannot read the contract {raw:?}"),
        });
        out.skipped += 1;
        return;
    };
    out.fills.push(RawFill {
        contract,
        raw_symbol: raw.to_owned(),
        side: f.side,
        qty: f.qty,
        price: f.price,
        ts: f.ts,
        fee: f.fee,
        external_id: f.id,
        reported_pnl: None,
        line,
    });
}

struct Fill1 {
    side: Side,
    qty: Decimal,
    price: Decimal,
    ts: Timestamp,
    fee: Option<Decimal>,
    id: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn read_fill(
    r: &mut Reader<'_>,
    line: usize,
    row: &Row,
    side: (&str, &[&str]),
    qty: (&str, &[&str]),
    price: (&str, &[&str]),
    time: (&str, &[&str]),
    tz: Tz,
) -> Option<(Side, Decimal, Decimal, Timestamp)> {
    let Some(s) = csv::side(csv::field(row, side.1)) else {
        r.fail(line, side.0, "must be a buy or a sell");
        return None;
    };
    let Some(q) = csv::decimal(csv::field(row, qty.1)).filter(|q| *q > Decimal::ZERO) else {
        r.fail(line, qty.0, "must be a positive number");
        return None;
    };
    let Some(p) = csv::decimal(csv::field(row, price.1)) else {
        r.fail(line, price.0, "must be a number");
        return None;
    };
    let Some(t) = csv::instant(csv::field(row, time.1), tz) else {
        r.fail(line, time.0, "must be a date and time");
        return None;
    };
    Some((s, q, p, t))
}

fn fills_ninjatrader(t: &Table, tz: Tz) -> ParsedImport {
    let mut out = ParsedImport {
        format: "NinjaTrader executions".into(),
        rows: t.rows.len(),
        ..ParsedImport::default()
    };
    for (line, row) in &t.rows {
        let line = *line;
        let mut r = Reader { out: &mut out };
        let Some(symbol) = csv::field(row, &["Instrument"]).map(str::to_owned) else {
            r.fail(line, "Instrument", "no instrument");
            continue;
        };
        let ex = csv::field(row, &["E/X"]).map(str::to_ascii_lowercase);
        if !matches!(ex.as_deref(), Some("entry" | "exit")) {
            r.fail(line, "E/X", "must be Entry or Exit");
            continue;
        }
        let Some((side, qty, price, ts)) = read_fill(
            &mut r,
            line,
            row,
            ("Action", &["Action"]),
            ("Quantity", &["Quantity"]),
            ("Price", &["Price"]),
            ("Time", &["Time"]),
            tz,
        ) else {
            continue;
        };
        let fee = csv::decimal(csv::field(row, &["Commission"]));
        let id = csv::field(row, &["ID", "Order ID"]).map(str::to_owned);
        push_fill(
            &mut out,
            line,
            &symbol,
            Fill1 {
                side,
                qty,
                price,
                ts,
                fee,
                id,
            },
        );
    }
    out
}

fn fills_tradovate(t: &Table, tz: Tz) -> ParsedImport {
    let mut out = ParsedImport {
        format: "Tradovate orders".into(),
        rows: t.rows.len(),
        ..ParsedImport::default()
    };
    let mut unfilled = 0usize;
    for (line, row) in &t.rows {
        let line = *line;
        if !csv::is_filled(csv::field(row, &["Status"])) {
            out.skipped += 1;
            unfilled += 1;
            continue;
        }
        let mut r = Reader { out: &mut out };
        let Some(symbol) = csv::field(row, &["Contract", "Product"]).map(str::to_owned) else {
            r.fail(line, "Contract", "no contract");
            continue;
        };
        let Some((side, qty, price, ts)) = read_fill(
            &mut r,
            line,
            row,
            ("B/S", &["B/S", "Buy/Sell"]),
            ("filledQty", &["filledQty", "Filled Qty", "Quantity"]),
            (
                "avgPrice",
                &["avgPrice", "Avg Fill Price", "decimalFillAvg"],
            ),
            ("Fill Time", &["Fill Time", "Timestamp", "Date"]),
            tz,
        ) else {
            continue;
        };
        let fee = csv::decimal(csv::field(row, &["commission", "Commission"]));
        let id = csv::field(row, &["orderId", "Order ID"]).map(str::to_owned);
        push_fill(
            &mut out,
            line,
            &symbol,
            Fill1 {
                side,
                qty,
                price,
                ts,
                fee,
                id,
            },
        );
    }
    if unfilled > 0 {
        out.warnings.push(format!(
            "{unfilled} unfilled or cancelled order{} left out.",
            if unfilled == 1 { " was" } else { "s were" }
        ));
    }
    out
}

fn zone_of_abbreviation(abbreviation: &str) -> Option<Tz> {
    use chrono_tz::{America, Asia, Australia, Europe};
    Some(match abbreviation.to_ascii_uppercase().as_str() {
        "EDT" | "EST" | "ET" => America::New_York,
        "CDT" | "CST" | "CT" => America::Chicago,
        "MDT" | "MST" | "MT" => America::Denver,
        "PDT" | "PST" | "PT" => America::Los_Angeles,
        "BST" | "GMT" => Europe::London,
        "CET" | "CEST" => Europe::Berlin,
        "JST" => Asia::Tokyo,
        "HKT" => Asia::Hong_Kong,
        "SGT" => Asia::Singapore,
        "AEST" | "AEDT" => Australia::Sydney,
        "UTC" => Tz::UTC,
        _ => return None,
    })
}

fn rithmic_time_column(headers: &[String], tz: Tz) -> (String, Tz) {
    let named = |prefix: &str| {
        headers.iter().find_map(|h| {
            let zone = h
                .trim()
                .strip_prefix(prefix)?
                .strip_prefix('(')?
                .strip_suffix(')')?;
            Some((
                h.trim().to_owned(),
                zone_of_abbreviation(zone).unwrap_or(tz),
            ))
        })
    };
    named("Update Time ")
        .or_else(|| named("Create Time "))
        .unwrap_or_else(|| ("Update Time".to_owned(), tz))
}

fn fills_rithmic(content: &str, tz: Tz) -> ParsedImport {
    let header = header_candidates(content)
        .into_iter()
        .find(|(_, h)| Platform::Rithmic.matches(h));
    let Some((at, _)) = header else {
        return ParsedImport::default();
    };
    let t = csv::table_at(content, at, true);
    let mut out = ParsedImport {
        format: "R | Trader completed orders".into(),
        rows: t.rows.len(),
        ..ParsedImport::default()
    };
    let (time_column, written_in) = rithmic_time_column(&t.headers, tz);
    let mut unfilled = 0usize;
    for (line, row) in &t.rows {
        let line = *line;
        if !csv::is_filled(csv::field(row, &["Status"])) {
            out.skipped += 1;
            unfilled += 1;
            continue;
        }
        let mut r = Reader { out: &mut out };
        let Some(symbol) = csv::field(row, &["Symbol"]).map(str::to_owned) else {
            r.fail(line, "Symbol", "no symbol");
            continue;
        };
        let Some((side, qty, price, ts)) = read_fill(
            &mut r,
            line,
            row,
            ("Buy/Sell", &["Buy/Sell"]),
            ("Qty Filled", &["Qty Filled", "Qty To Fill"]),
            ("Avg Fill Price", &["Avg Fill Price"]),
            (time_column.as_str(), &[time_column.as_str()]),
            written_in,
        ) else {
            continue;
        };
        let fee = csv::decimal(csv::field(row, &["Commission"])).or_else(|| {
            csv::decimal(csv::field(row, &["Commission Fill Rate"])).map(|rate| rate * qty)
        });
        let id = csv::field(
            row,
            &[
                "Order Number",
                "Current Sequence Number",
                "Original Sequence Number",
            ],
        )
        .map(str::to_owned);
        push_fill(
            &mut out,
            line,
            &symbol,
            Fill1 {
                side,
                qty,
                price,
                ts,
                fee,
                id,
            },
        );
    }
    if unfilled > 0 {
        out.warnings.push(format!(
            "{unfilled} order{} not filled (cancelled or working) and left out.",
            if unfilled == 1 { " was" } else { "s were" }
        ));
    }
    out
}
