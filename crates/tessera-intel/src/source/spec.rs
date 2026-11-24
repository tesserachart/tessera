use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_core::ids::slug;
use tessera_core::levels::ConceptAnnotation;
use ts_rs::TS;

use super::select::Selector;
use crate::io::HistoryTicker;

pub const SPEC_VERSION: u32 = 1;

fn yes() -> bool {
    true
}

/// A levels source: one HTTP API that returns levels, declared as data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LevelSourceSpec {
    /// Spec format version (1).
    pub version: u32,
    /// Stable id, lower case letters, digits and `-` (`acme-levels`). It is the provider id and
    /// the first part of every level key (`acme-levels.main.call_wall`).
    pub id: String,
    /// Display name (`Acme levels`).
    pub name: String,
    /// The vendor, as the vendor writes its name (`Acme`). Every level keeps it verbatim.
    pub vendor: String,
    /// Base URL every request path is joined to (`https://api.acme.com/v1`). `https://` (plain
    /// `http://` only to this machine): the request carries the secret.
    pub base_url: String,
    /// Where the source's secret goes; none for an open API.
    #[serde(default)]
    pub auth: Option<AuthSpec>,
    /// Headers sent with every request (`Accept`, `User-Agent`). Never the secret: that is
    /// `auth`'s.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// The Tessera instruments it covers and the vendor ticker for each.
    pub instruments: Vec<InstrumentMapping>,
    /// The requests made for an instrument, and how each response becomes levels.
    pub requests: Vec<RequestSpec>,
    /// When to ask.
    #[serde(default)]
    pub schedule: ScheduleSpec,
    /// Quotas, timeouts and backoff.
    #[serde(default)]
    pub limits: LimitsSpec,
    /// The vendor's own history API, when the user's plan includes one. `intel.backfill_level_history`
    /// asks it for past days and reads each file with the package's request.
    #[serde(default)]
    pub history: Option<HistoryApiSpec>,
    /// Keep every raw response in the blob store (content-addressed: identical responses are kept
    /// once). On by default, so a parsing mistake can be fixed after the fact.
    #[serde(default = "yes")]
    pub record_raw: bool,
}

/// Where the secret is placed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuthPlacement {
    /// A request header (`Authorization: Bearer <secret>`).
    Header,
    /// A query parameter (`?apikey=<secret>`).
    Query,
}

/// How the source's secret is sent. The secret itself is never part of the spec: it is given once
/// when the source is added and kept in the OS keyring.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct AuthSpec {
    /// A header or a query parameter.
    #[serde(rename = "in")]
    #[ts(rename = "in")]
    pub placement: AuthPlacement,
    /// Header or parameter name (`Authorization`, `apikey`).
    pub name: String,
    /// Written before the secret (`Bearer `).
    #[serde(default)]
    pub prefix: String,
}

/// One Tessera instrument (by root or symbol) and the vendor ticker that serves it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct InstrumentMapping {
    /// Tessera futures root or symbol (`NQ`, `MNQ`, `ES`, `QQQ`, `NDX`). A root covers each of its
    /// dated contracts, on every connection.
    pub root: String,
    /// The vendor's ticker (`{ticker}` in paths and queries).
    pub ticker: String,
    /// The price space the vendor's values are in (default: the ticker).
    #[serde(default)]
    pub basis: Option<String>,
    /// How the vendor's prices become the instrument's; none when they already are.
    #[serde(default)]
    pub convert: Option<ConvertSpec>,
}

/// A price conversion from the vendor's price space to the instrument's: `target = source ×
/// multiplier + additive`, rounded to the instrument's tick. Prices only, never magnitudes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "model", rename_all = "snake_case")]
pub enum ConvertSpec {
    /// `target = source × ratio`.
    Ratio {
        /// The ratio.
        ratio: f64,
    },
    /// `target = source + additive`.
    Additive {
        /// Points added.
        additive: f64,
    },
    /// `target = source × multiplier + additive`.
    Affine {
        /// The multiplier.
        multiplier: f64,
        /// Points added after it.
        additive: f64,
    },
    /// The terms from another request (the vendor's own conversion endpoint).
    Request(ConvertRequest),
}

/// A request whose response holds the conversion's terms.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ConvertRequest {
    /// Path, joined to the base URL (`/futures/conversion`).
    pub path: String,
    /// Query parameters (templates: `{ticker}`, `{root}`, `{instrument}`).
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    /// Selector of the multiplier (`multiplier`).
    pub multiplier: String,
    /// Selector of the additive term (`additive`); none for a pure ratio.
    #[serde(default)]
    pub additive: Option<String>,
    /// Selector of the vendor's code for the target contract (`future_contract`).
    #[serde(default)]
    pub contract: Option<String>,
    /// The model's name as the vendor gives it, recorded on the conversion (`additive`).
    #[serde(default)]
    pub method: Option<String>,
    /// How often to refresh the terms, in seconds (default: the schedule's interval).
    #[serde(default)]
    pub every_seconds: Option<u32>,
    /// Quota pool it counts against (default `default`).
    #[serde(default)]
    pub pool: Option<String>,
}

/// One request made for an instrument, and how its response becomes levels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct RequestSpec {
    /// Id within the source (`classic`).
    pub id: String,
    /// The vendor's package or product, verbatim (`Classic`). Levels are grouped and keyed by it.
    pub package: String,
    /// What the vendor calls this request, kept on every level it gives (`classic/gex_full`);
    /// default: the id.
    #[serde(default)]
    pub endpoint: Option<String>,
    /// Path, joined to the base URL (`/{ticker}/classic/gex_full`).
    pub path: String,
    /// Query parameters (templates, as the path).
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    /// How often to ask, in seconds (default: the schedule's interval).
    #[serde(default)]
    pub every_seconds: Option<u32>,
    /// Quota pool it counts against (default `default`).
    #[serde(default)]
    pub pool: Option<String>,
    /// The vendor's snapshot time in the response (default: when Tessera received it).
    #[serde(default)]
    pub as_of: Option<TimeField>,
    /// Selector of the underlying's price at snapshot time, for `offset` values.
    #[serde(default)]
    pub spot: Option<String>,
    /// Group of its levels (default `levels`).
    #[serde(default)]
    pub group: Option<String>,
    /// Named fields of the response that are levels.
    #[serde(default)]
    pub fields: Vec<FieldSpec>,
    /// A list in the response whose items are levels (each naming its own field).
    #[serde(default)]
    pub items: Option<ItemsSpec>,
}

/// A time in the response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TimeField {
    /// Selector (`timestamp`).
    pub path: String,
    /// How it is written (default `seconds`).
    #[serde(default)]
    pub unit: TimeUnit,
}

/// How a time is written.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimeUnit {
    /// Unix seconds.
    #[default]
    Seconds,
    /// Unix milliseconds.
    Millis,
    /// Unix nanoseconds.
    Nanos,
    /// An RFC 3339 string.
    Rfc3339,
}

/// What a value is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ValueUnit {
    /// A price in the basis' price space.
    #[default]
    Price,
    /// Points from the request's `spot` (the level is `spot + value`).
    Offset,
}

/// The swatches a level may be drawn with by default (Settings › Chart › Levels' own).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LevelColor {
    Mist,
    /// Grey.
    T2,
    /// The up colour.
    Up,
    /// The down colour.
    Down,
    Brass,
    Teal,
}

/// Line styles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LevelLine {
    Solid,
    /// Dashed.
    Dash,
    /// Dotted.
    Dot,
}

/// How a level is drawn until the user sets it otherwise.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct StyleHint {
    /// Its colour.
    #[serde(default)]
    pub color: Option<LevelColor>,
    /// Its line.
    #[serde(default)]
    pub line: Option<LevelLine>,
    /// Drawn by default (default true).
    #[serde(default)]
    pub on: Option<bool>,
}

/// One named field of a response that is a level.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct FieldSpec {
    /// The vendor's field name, verbatim (`zero_gamma`). The level's key ends with it.
    pub field: String,
    /// Selector of the value (default: the field name at the top of the response).
    #[serde(default)]
    pub path: Option<String>,
    /// Label, the vendor's own name for it (default: the field).
    #[serde(default)]
    pub label: Option<String>,
    /// Short tag at the chart's edge (`ZG`).
    #[serde(default)]
    pub short: Option<String>,
    /// Group (default: the request's).
    #[serde(default)]
    pub group: Option<String>,
    /// What the vendor says it means.
    #[serde(default)]
    pub description: Option<String>,
    /// A price or an offset from spot.
    #[serde(default)]
    pub unit: ValueUnit,
    /// Multiplies the value (before `offset`).
    #[serde(default)]
    pub scale: Option<f64>,
    /// Added to the value (after `scale`).
    #[serde(default)]
    pub offset: Option<f64>,
    /// Values the vendor uses for "not applicable" (`[0]`): the level has no price, never price 0.
    #[serde(default)]
    pub na_if: Vec<f64>,
    /// Why, in the vendor's words, when a value is not applicable.
    #[serde(default)]
    pub na_reason: Option<String>,
    /// A normalized concept it relates to: an annotation, never a replacement of the field.
    #[serde(default)]
    pub concept: Option<ConceptAnnotation>,
    /// How it is drawn by default.
    #[serde(default)]
    pub style: Option<StyleHint>,
}

/// A list in the response whose items are levels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ItemsSpec {
    /// Selector of the list (`levels`).
    pub path: String,
    /// Selector, within an item, of the vendor's name for the level (`type`): its field.
    pub field: String,
    /// Selector, within an item, of the value (`price`).
    pub price: String,
    /// Selector, within an item, of its label (default: the field).
    #[serde(default)]
    pub label: Option<String>,
    /// A price or an offset from spot.
    #[serde(default)]
    pub unit: ValueUnit,
    /// Multiplies each value.
    #[serde(default)]
    pub scale: Option<f64>,
    /// Added to each value.
    #[serde(default)]
    pub offset: Option<f64>,
    /// Values meaning "not applicable".
    #[serde(default)]
    pub na_if: Vec<f64>,
}

/// When a source is asked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct ScheduleSpec {
    /// Seconds between requests inside the window (at least 5; default 60). A request is only
    /// made while something is shown or asked for.
    #[serde(default = "default_every")]
    pub every_seconds: u32,
    /// When the vendor's data moves; always when absent.
    #[serde(default)]
    pub window: Option<WindowSpec>,
    /// What happens outside the window.
    #[serde(default)]
    pub off_hours: OffHours,
    /// Seconds between requests outside the window, with `offHours: poll` (default: 15 minutes).
    #[serde(default)]
    pub off_hours_every_seconds: Option<u32>,
}

fn default_every() -> u32 {
    60
}

impl Default for ScheduleSpec {
    fn default() -> Self {
        Self {
            every_seconds: default_every(),
            window: None,
            off_hours: OffHours::default(),
            off_hours_every_seconds: None,
        }
    }
}

/// A session window: a named session, or a daily time range in a time zone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct WindowSpec {
    /// A named session: `us_rth` (US cash hours, 09:30–16:00 New York, 13:00 on early closes,
    /// trading days only).
    #[serde(default)]
    pub session: Option<SessionName>,
    /// IANA time zone of `start` and `end` (default `America/New_York`).
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Start, `HH:MM`.
    #[serde(default)]
    pub start: Option<String>,
    /// End, `HH:MM` (exclusive).
    #[serde(default)]
    pub end: Option<String>,
    /// Weekdays only (default true).
    #[serde(default)]
    pub weekdays_only: Option<bool>,
}

/// Named session windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionName {
    /// US cash hours: 09:30–16:00 New York (13:00 on early closes), NYSE trading days.
    UsRth,
}

/// Outside the window.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OffHours {
    /// Ask once for the last snapshot, then keep it (default).
    #[default]
    Once,
    /// Never ask: only what was received inside the window is shown.
    Never,
    /// Keep asking, every `offHoursEverySeconds`.
    Poll,
}

/// A vendor's history API: one file per ticker, package and day, a list of snapshots each shaped
/// like the live response of the package's request (JSON list, JSON lines, or gzip of either).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct HistoryApiSpec {
    /// Path, joined to the base URL (`/hist/{ticker}/{endpoint}/{date}`). Templates: `{ticker}`,
    /// `{package}` (the request's package, lower case), `{endpoint}` (the request's endpoint),
    /// `{request}` (its id) and `{date}` (`YYYY-MM-DD`).
    pub path: String,
    /// Query parameters, sent as written.
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    /// Selector of a download link in the answer, when the vendor answers with a link to the file
    /// instead of the file (`url`). The link must be `https://`; it is fetched without the secret.
    #[serde(default)]
    pub link: Option<String>,
    /// How many days back the vendor keeps.
    pub days_back: u32,
    /// Quota pool it counts against (default `history`).
    #[serde(default)]
    pub pool: Option<String>,
    /// Requests a day Tessera allows itself on it.
    pub daily_cap: u32,
    /// Tickers it serves besides the instruments' own (`NQ_NDX`), with the instrument each is filed
    /// under.
    #[serde(default)]
    pub tickers: Vec<HistoryTicker>,
}

pub const DEFAULT_HISTORY_POOL: &str = "history";

const HISTORY_VARS: [&str; 5] = ["ticker", "package", "endpoint", "request", "date"];

impl HistoryApiSpec {
    pub fn pool(&self) -> &str {
        self.pool.as_deref().unwrap_or(DEFAULT_HISTORY_POOL)
    }
}

/// Quotas, timeouts and backoff.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct LimitsSpec {
    /// Requests a day Tessera allows itself per pool (none: no cap of its own).
    #[serde(default)]
    pub daily_quota: Option<u32>,
    /// Per-pool caps that differ from `dailyQuota`.
    #[serde(default)]
    pub pools: BTreeMap<String, u32>,
    /// When the day's counts reset, `HH:MM` (default `00:00`).
    #[serde(default)]
    pub reset_at: Option<String>,
    /// Time zone of the reset and of the window (default `America/New_York`).
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Per-request timeout, ms (default 8000).
    #[serde(default)]
    pub timeout_ms: Option<u32>,
    /// First wait after a failure, seconds (default 2), doubling.
    #[serde(default)]
    pub backoff_seconds: Option<u32>,
    /// Longest wait, seconds (default 900: a rate limit can last 15 minutes).
    #[serde(default)]
    pub backoff_max_seconds: Option<u32>,
    /// Selector of the vendor's message in an error body (`error`).
    #[serde(default)]
    pub error_message: Option<String>,
}

pub const DEFAULT_POOL: &str = "default";

pub const MIN_EVERY_SECONDS: u32 = 5;

const VARS: [&str; 3] = ["ticker", "instrument", "root"];

pub fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

fn is_loopback_http(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        authority.rsplit_once(':').map_or(authority, |(h, _)| h)
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn check_template(what: &str, t: &str, problems: &mut Vec<String>) {
    check_vars(what, t, &VARS, problems);
}

fn check_vars(what: &str, t: &str, vars: &[&str], problems: &mut Vec<String>) {
    let mut rest = t;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            problems.push(format!("{what}: an unclosed {{ in {t:?}"));
            return;
        };
        let var = &after[..close];
        if !vars.contains(&var) {
            let known: Vec<String> = vars.iter().map(|v| format!("{{{v}}}")).collect();
            problems.push(format!(
                "{what}: unknown {{{var}}} in {t:?} (use {})",
                known.join(", ")
            ));
        }
        rest = &after[close + 1..];
    }
}

fn check_selector(what: &str, s: &str, problems: &mut Vec<String>) {
    if let Err(e) = Selector::parse(s) {
        problems.push(format!("{what}: {e}"));
    }
}

fn header_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
}

impl LevelSourceSpec {
    pub fn package_key(&self, package: &str) -> String {
        format!("{}.{}", self.id, slug(package))
    }

    pub fn problems(&self) -> Vec<String> {
        let mut p = Vec::new();
        if self.version != SPEC_VERSION {
            p.push(format!(
                "version {} is not supported (this build reads version {SPEC_VERSION})",
                self.version
            ));
        }
        let id_ok = !self.id.is_empty()
            && self.id.len() <= 40
            && self
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && self.id.starts_with(|c: char| c.is_ascii_lowercase());
        if !id_ok {
            p.push(
                "id: lower case letters, digits and -, starting with a letter (acme-levels)".into(),
            );
        }
        if self.name.trim().is_empty() {
            p.push("name is required".into());
        }
        if self.vendor.trim().is_empty() {
            p.push("vendor is required".into());
        }
        let url = self.base_url.trim();
        if !(url.starts_with("https://") || is_loopback_http(url)) {
            p.push("baseUrl must be https:// (plain http:// only to this machine)".into());
        } else if url.contains('?') || url.contains('#') {
            p.push("baseUrl takes no query or fragment: put parameters on the requests".into());
        }
        if let Some(a) = &self.auth {
            if a.name.trim().is_empty() {
                p.push("auth.name is required (the header or parameter the secret goes in)".into());
            }
            if a.placement == AuthPlacement::Header && !header_name_ok(a.name.trim()) {
                p.push(format!("auth.name {:?} is not a header name", a.name));
            }
        }
        for (k, v) in &self.headers {
            if !header_name_ok(k) {
                p.push(format!("header {k:?} is not a header name"));
            }
            let lk = k.to_ascii_lowercase();
            if lk == "authorization"
                || lk.contains("api-key")
                || lk.contains("apikey")
                || lk.contains("token")
            {
                p.push(format!(
                    "header {k}: the secret belongs in auth (kept in the keyring), not in the spec"
                ));
            }
            if v.contains('\n') || v.contains('\r') {
                p.push(format!("header {k}: one line only"));
            }
        }
        if self.instruments.is_empty() {
            p.push("instruments: name at least one (root NQ → ticker NDX)".into());
        }
        let mut roots = std::collections::BTreeSet::new();
        for (i, m) in self.instruments.iter().enumerate() {
            let what = format!("instruments[{i}]");
            if m.root.trim().is_empty() || m.ticker.trim().is_empty() {
                p.push(format!("{what}: root and ticker are required"));
            }
            if !roots.insert(m.root.trim().to_ascii_uppercase()) {
                p.push(format!("{what}: {} is mapped twice", m.root));
            }
            match &m.convert {
                Some(ConvertSpec::Ratio { ratio }) if !(ratio.is_finite() && *ratio > 0.0) => {
                    p.push(format!("{what}.convert: the ratio must be positive"));
                }
                Some(ConvertSpec::Affine {
                    multiplier,
                    additive,
                }) if !(multiplier.is_finite() && *multiplier > 0.0 && additive.is_finite()) => {
                    p.push(format!(
                        "{what}.convert: the multiplier must be positive and both finite"
                    ));
                }
                Some(ConvertSpec::Additive { additive }) if !additive.is_finite() => {
                    p.push(format!("{what}.convert: the additive must be finite"));
                }
                Some(ConvertSpec::Request(r)) => {
                    let w = format!("{what}.convert");
                    if !r.path.starts_with('/') {
                        p.push(format!("{w}.path must start with /"));
                    }
                    check_template(&format!("{w}.path"), &r.path, &mut p);
                    for v in r.query.values() {
                        check_template(&format!("{w}.query"), v, &mut p);
                    }
                    check_selector(&format!("{w}.multiplier"), &r.multiplier, &mut p);
                    for s in [&r.additive, &r.contract].into_iter().flatten() {
                        check_selector(&w, s, &mut p);
                    }
                    if r.every_seconds.is_some_and(|s| s < MIN_EVERY_SECONDS) {
                        p.push(format!("{w}.everySeconds: at least {MIN_EVERY_SECONDS}"));
                    }
                }
                _ => {}
            }
        }
        if self.requests.is_empty() {
            p.push("requests: at least one".into());
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut keys = std::collections::BTreeSet::new();
        for (i, r) in self.requests.iter().enumerate() {
            let what = format!("requests[{i}]");
            if r.id.trim().is_empty() || !ids.insert(r.id.clone()) {
                p.push(format!("{what}: a unique id is required"));
            }
            if slug(&r.package).is_empty() {
                p.push(format!(
                    "{what}: package is required (the vendor's product name)"
                ));
            }
            if !r.path.starts_with('/') {
                p.push(format!("{what}.path must start with /"));
            }
            check_template(&format!("{what}.path"), &r.path, &mut p);
            for v in r.query.values() {
                check_template(&format!("{what}.query"), v, &mut p);
            }
            if r.every_seconds.is_some_and(|s| s < MIN_EVERY_SECONDS) {
                p.push(format!("{what}.everySeconds: at least {MIN_EVERY_SECONDS}"));
            }
            if let Some(t) = &r.as_of {
                check_selector(&format!("{what}.asOf"), &t.path, &mut p);
            }
            if let Some(s) = &r.spot {
                check_selector(&format!("{what}.spot"), s, &mut p);
            }
            if r.fields.is_empty() && r.items.is_none() {
                p.push(format!(
                    "{what}: map at least one field (or items) of the response to a level"
                ));
            }
            for (j, f) in r.fields.iter().enumerate() {
                let w = format!("{what}.fields[{j}]");
                if f.field.trim().is_empty() {
                    p.push(format!("{w}: the vendor's field name is required"));
                } else if !keys.insert(format!("{}.{}", slug(&r.package), f.field)) {
                    p.push(format!(
                        "{w}: {} is mapped twice in package {}",
                        f.field, r.package
                    ));
                }
                if let Some(s) = &f.path {
                    check_selector(&w, s, &mut p);
                }
                if f.unit == ValueUnit::Offset && r.spot.is_none() {
                    p.push(format!("{w}: an offset needs the request's spot"));
                }
                if [f.scale, f.offset].iter().flatten().any(|x| !x.is_finite()) {
                    p.push(format!("{w}: scale and offset must be finite"));
                }
            }
            if let Some(it) = &r.items {
                let w = format!("{what}.items");
                for s in [
                    Some(&it.path),
                    Some(&it.field),
                    Some(&it.price),
                    it.label.as_ref(),
                ]
                .into_iter()
                .flatten()
                {
                    check_selector(&w, s, &mut p);
                }
                if it.unit == ValueUnit::Offset && r.spot.is_none() {
                    p.push(format!("{w}: an offset needs the request's spot"));
                }
            }
        }
        let s = &self.schedule;
        if s.every_seconds < MIN_EVERY_SECONDS {
            p.push(format!(
                "schedule.everySeconds: at least {MIN_EVERY_SECONDS}"
            ));
        }
        if s.off_hours_every_seconds
            .is_some_and(|x| x < MIN_EVERY_SECONDS)
        {
            p.push(format!(
                "schedule.offHoursEverySeconds: at least {MIN_EVERY_SECONDS}"
            ));
        }
        if let Some(w) = &s.window {
            match (&w.session, &w.start, &w.end) {
                (Some(_), None, None) => {}
                (None, Some(a), Some(b)) => match (parse_hhmm(a), parse_hhmm(b)) {
                    (Some(a), Some(b)) if a != b => {}
                    _ => p.push("schedule.window: start and end as HH:MM, not equal".into()),
                },
                _ => p.push(
                    "schedule.window: a session (us_rth), or a start and an end (HH:MM)".into(),
                ),
            }
            if let Some(tz) = &w.time_zone
                && tz.parse::<chrono_tz::Tz>().is_err()
            {
                p.push(format!(
                    "schedule.window.timeZone: unknown time zone {tz:?}"
                ));
            }
        }
        let l = &self.limits;
        if let Some(r) = &l.reset_at
            && parse_hhmm(r).is_none()
        {
            p.push("limits.resetAt: HH:MM".into());
        }
        if let Some(tz) = &l.time_zone
            && tz.parse::<chrono_tz::Tz>().is_err()
        {
            p.push(format!("limits.timeZone: unknown time zone {tz:?}"));
        }
        if l.timeout_ms.is_some_and(|t| !(100..=60_000).contains(&t)) {
            p.push("limits.timeoutMs: between 100 and 60000".into());
        }
        if let Some(s) = &l.error_message {
            check_selector("limits.errorMessage", s, &mut p);
        }
        if let Some(h) = &self.history {
            if !h.path.starts_with('/') {
                p.push("history.path must start with /".into());
            }
            check_vars("history.path", &h.path, &HISTORY_VARS, &mut p);
            if let Some(s) = &h.link {
                check_selector("history.link", s, &mut p);
            }
            if h.days_back == 0 {
                p.push("history.daysBack: at least 1".into());
            }
            if h.daily_cap == 0 {
                p.push("history.dailyCap: at least 1".into());
            }
            for (i, t) in h.tickers.iter().enumerate() {
                if t.ticker.trim().is_empty() || t.instrument.trim().is_empty() {
                    p.push(format!(
                        "history.tickers[{i}]: ticker and instrument are required"
                    ));
                }
            }
        }
        p
    }

    pub fn history_tickers(&self) -> Vec<HistoryTicker> {
        let Some(h) = &self.history else {
            return Vec::new();
        };
        let mut out = h.tickers.clone();
        for m in &self.instruments {
            let ticker = m.ticker.trim().to_ascii_uppercase();
            if !out.iter().any(|t| t.ticker.eq_ignore_ascii_case(&ticker)) {
                out.push(HistoryTicker {
                    instrument: ticker.clone(),
                    ticker,
                });
            }
        }
        out
    }

    pub fn mapping(&self, root: Option<&str>, symbol: &str) -> Option<&InstrumentMapping> {
        let eq = |a: &str, b: &str| a.trim().eq_ignore_ascii_case(b.trim());
        self.instruments
            .iter()
            .find(|m| eq(&m.root, symbol))
            .or_else(|| root.and_then(|r| self.instruments.iter().find(|m| eq(&m.root, r))))
    }
}

impl FieldSpec {
    pub fn value_path(&self) -> String {
        self.path
            .clone()
            .unwrap_or_else(|| format!("[{:?}]", self.field))
    }
}

impl RequestSpec {
    pub fn endpoint(&self) -> String {
        self.endpoint.clone().unwrap_or_else(|| self.id.clone())
    }

    pub fn pool(&self) -> &str {
        self.pool.as_deref().unwrap_or(DEFAULT_POOL)
    }
}

pub fn fill(template: &str, ticker: &str, instrument: &str, root: &str) -> String {
    template
        .replace("{ticker}", ticker)
        .replace("{instrument}", instrument)
        .replace("{root}", root)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample() -> LevelSourceSpec {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "id": "acme",
            "name": "Acme levels",
            "vendor": "Acme",
            "baseUrl": "https://api.acme.test/v1",
            "auth": {"in": "header", "name": "Authorization", "prefix": "Bearer "},
            "headers": {"Accept": "application/json"},
            "instruments": [
                {"root": "NQ", "ticker": "NDX", "convert": {"model": "additive", "additive": 40.5}},
                {"root": "QQQ", "ticker": "QQQ"}
            ],
            "requests": [{
                "id": "main", "package": "Main", "path": "/levels/{ticker}",
                "asOf": {"path": "ts"},
                "fields": [{"field": "call_wall", "label": "Call Wall", "path": "data.cw", "naIf": [0]}]
            }],
            "schedule": {"everySeconds": 120, "window": {"session": "us_rth"}}
        }))
        .unwrap()
    }

    #[test]
    fn a_spec_reads_and_checks() {
        let s = sample();
        assert!(s.problems().is_empty(), "{:?}", s.problems());
        assert_eq!(s.package_key("Main"), "acme.main");
        assert_eq!(s.schedule.off_hours, OffHours::Once);
        assert!(s.record_raw);
        assert!(matches!(
            s.instruments[0].convert,
            Some(ConvertSpec::Additive { additive }) if additive == 40.5
        ));
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["auth"]["in"], "header");
        let back: LevelSourceSpec = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
        assert_eq!(s.mapping(Some("NQ"), "NQZ6").unwrap().ticker, "NDX");
        assert_eq!(s.mapping(None, "qqq").unwrap().ticker, "QQQ");
        assert!(s.mapping(Some("ES"), "ESZ6").is_none());
    }

    #[test]
    fn problems_are_said_in_plain_words() {
        let mut s = sample();
        s.id = "Acme Levels".into();
        s.base_url = "http://api.acme.test".into();
        s.headers.insert("Authorization".into(), "Bearer x".into());
        s.requests[0].path = "/levels/{symbol}".into();
        s.requests[0].fields[0].path = Some("data[".into());
        s.schedule.every_seconds = 1;
        let p = s.problems().join("\n");
        for want in [
            "id:",
            "baseUrl must be https://",
            "the secret belongs in auth",
            "unknown {symbol}",
            "fields[0]",
            "everySeconds: at least 5",
        ] {
            assert!(p.contains(want), "{want} not in {p}");
        }
        let mut local = sample();
        local.base_url = "http://127.0.0.1:8080/api".into();
        assert!(local.problems().is_empty());
        let mut v = serde_json::to_value(sample()).unwrap();
        v["apiKey"] = serde_json::json!("x");
        assert!(serde_json::from_value::<LevelSourceSpec>(v).is_err());
    }

    #[test]
    fn times_and_paths() {
        assert_eq!(parse_hhmm("09:30"), Some(570));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(
            fill("/{ticker}/x/{root}", "NDX", "NQZ6.CME", "NQ"),
            "/NDX/x/NQ"
        );
    }
}
