use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tessera_core::Timestamp;
use tessera_core::capabilities::IntelCapabilities;
use tessera_core::conversion::ConversionRecord;
use tessera_core::health::ProviderHealth;
use tessera_core::levels::{ConceptAnnotation, Level};
use ts_rs::TS;

use crate::source::spec::{LevelSourceSpec, StyleHint};

/// `intel.get_levels` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetLevelsInput {
    /// Instrument id or symbol (`QQQ`, `NDX`, `NQ`).
    pub instrument: String,
    /// Point-in-time request: the snapshot in effect at this instant (latest when omitted).
    /// Fails closed with `not_found` when no snapshot exists at or before it.
    #[serde(default)]
    pub as_of: Option<Timestamp>,
    /// Provider id (a spec's id, `acme`); the first connected provider covering the
    /// instrument when omitted.
    #[serde(default)]
    pub provider: Option<String>,
}

/// `intel.get_conversion` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct GetConversionInput {
    /// Source price space, as written in a level's `source.basis` (`NDX`).
    pub from: String,
    /// Target instrument id or symbol (`NQ`, `NQZ6`, `MNQZ6.CME`).
    pub to: String,
    /// Provider id; the first connected provider with the conversion when omitted.
    #[serde(default)]
    pub provider: Option<String>,
}

/// `intel.list_providers` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListIntelProvidersInput {}

/// One configured market-intelligence provider: who it is, what it offers and how it is doing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntelProviderEntry {
    /// Provider id (a spec's id, `acme`).
    pub provider_id: String,
    /// Display name.
    pub display_name: String,
    /// What the user's entitlement covers.
    pub capabilities: IntelCapabilities,
    /// Current health.
    pub health: ProviderHealth,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListIntelProvidersOutput {
    /// Configured providers; empty when the user has connected none.
    pub providers: Vec<IntelProviderEntry>,
}

/// One level a source declares: what it is called and how it is drawn until the user says
/// otherwise. Settings list sources from these, never from hard-coded names.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredLevel {
    /// The level key (`acme.classic.zero_gamma`); level settings are kept by it.
    pub key: String,
    /// The vendor's field, verbatim (`zero_gamma`).
    pub field: String,
    /// The vendor's own name for it (`Zero Gamma`).
    pub label: String,
    /// Short tag (`ZG`).
    pub short: Option<String>,
    /// Group.
    pub group: String,
    /// The vendor request it comes from (`classic/gex_full`).
    pub endpoint: Option<String>,
    /// What the vendor says it means.
    pub description: Option<String>,
    /// A normalized-concept annotation (never a replacement of the field).
    pub concept: Option<ConceptAnnotation>,
    /// How it is drawn by default.
    pub style: Option<StyleHint>,
}

/// A vendor package of a source and the levels it declares.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredPackage {
    /// `<source>.<package>` (`acme.classic`): every level key of the package starts with it.
    pub key: String,
    /// The vendor, verbatim.
    pub vendor: String,
    /// The package, verbatim (`Classic`).
    pub package: String,
    /// Its declared levels.
    pub levels: Vec<DeclaredLevel>,
    /// The package also names levels in its responses (a list of levels), beyond those declared.
    pub open: bool,
}

/// Requests made today against one quota pool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PoolCalls {
    /// The pool (`default`).
    pub pool: String,
    /// Requests made since the day's reset.
    pub used: u32,
    /// Tessera's own cap for the day, when the source sets one.
    pub cap: Option<u32>,
}

/// One levels source as `intel.list_sources` reports it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LevelSourceInfo {
    /// Provider id (a spec's id, `acme`).
    pub provider_id: String,
    /// Display name.
    pub display_name: String,
    /// The vendor, verbatim.
    pub vendor: String,
    /// Its packages and the levels each declares.
    pub packages: Vec<DeclaredPackage>,
    /// Tessera roots or symbols it covers (`NQ`, `ES`).
    pub instruments: Vec<String>,
    /// When it asks, in plain words (`Every 2 min, US market hours`).
    pub schedule: Option<String>,
    /// Requests made today, per quota pool.
    pub calls_today: Vec<PoolCalls>,
    /// The spec it runs (never with a secret: secrets live in the keyring).
    pub spec: Option<LevelSourceSpec>,
    /// Its spec is the user's, edited in place (`connections.add_level_source` with the same id);
    /// false for a source an earlier Tessera saved without a spec, which is added again instead.
    pub editable: bool,
    /// It sends a secret (an API key) kept in the secret store.
    pub sends_secret: bool,
    /// The vendor's own history API, when its spec declares one (`intel.backfill_level_history`).
    pub history: Option<HistoryReach>,
    /// Current health.
    pub health: ProviderHealth,
}

/// One ticker a vendor's history API serves and the instrument its values are filed under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTicker {
    /// The vendor's ticker (`NDX`, a futures-scale `NQ_NDX`).
    pub ticker: String,
    /// The Tessera root or symbol it is filed under (`NDX`, `NQ`), its price space kept.
    pub instrument: String,
}

/// What a vendor's own history API reaches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryReach {
    /// How many days back it keeps.
    pub days_back: u32,
    /// The vendor's quota pool it counts against (`history`).
    pub pool: String,
    /// Tessera's own cap on it a day.
    pub daily_cap: u32,
    /// The tickers it serves.
    pub tickers: Vec<HistoryTicker>,
}

/// `intel.list_sources` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListLevelSourcesInput {}

/// `intel.list_sources` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListLevelSourcesOutput {
    /// Every connected source of levels.
    pub sources: Vec<LevelSourceInfo>,
}

/// `intel.test_source` input: a dry run of a spec.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct TestSourceInput {
    /// The spec to try.
    pub spec: LevelSourceSpec,
    /// Sample responses by request id (`{"main": {...}}`; the conversion request is `convert`).
    /// A request with a sample is read from it, without a network call.
    #[serde(default)]
    pub samples: BTreeMap<String, Value>,
    /// The root or symbol to try (default: the first mapped).
    #[serde(default)]
    pub instrument: Option<String>,
}

/// One request of a dry run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestedRequest {
    /// Request id (`convert` for the conversion's).
    pub id: String,
    /// What was asked, without the secret (`/NDX/classic/gex_full`), or `sample`.
    pub url: String,
    /// HTTP status of a live request.
    pub status: Option<u16>,
    /// What went wrong, in plain words.
    pub message: Option<String>,
    /// The vendor's snapshot time.
    pub as_of: Option<Timestamp>,
    /// The levels it gives, in the vendor's price space.
    pub levels: Vec<Level>,
}

/// `intel.test_source` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestSourceOutput {
    /// Every request read, and at least one level has a price.
    pub ok: bool,
    /// Problems with the spec or what the responses held, in plain words.
    pub problems: Vec<String>,
    /// Each request.
    pub requests: Vec<TestedRequest>,
    /// The conversion to the instrument's price, when it has one and its terms were read.
    pub conversion: Option<ConversionRecord>,
}

/// `intel.draft_source` input: a spec the analyst drafted, for the user to review and save.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields)]
pub struct DraftSourceInput {
    /// The spec (never a secret: the user types the key when saving).
    pub spec: LevelSourceSpec,
    /// The sample responses it was tried on, by request id, so the user's dry run reads them too.
    #[serde(default)]
    pub samples: BTreeMap<String, Value>,
    /// What the user should know before saving it (what was assumed, what to check), in one or two
    /// sentences.
    #[serde(default)]
    pub note: Option<String>,
}

/// A drafted source, waiting for the user in Settings › Connections.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceDraft {
    /// The spec's id.
    pub id: String,
    /// The spec.
    pub spec: LevelSourceSpec,
    /// The samples it was tried on.
    pub samples: BTreeMap<String, Value>,
    /// What to know before saving it.
    pub note: Option<String>,
    /// Problems the spec still has, in plain words (none when it is ready to try).
    pub problems: Vec<String>,
    /// When it was drafted.
    pub drafted_at: Timestamp,
}

/// `intel.list_source_drafts` input. It takes no parameters; `{}` is the only valid value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListSourceDraftsInput {}

/// `intel.list_source_drafts` output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListSourceDraftsOutput {
    /// Drafts waiting for the user, newest first.
    pub drafts: Vec<SourceDraft>,
}

/// `intel.discard_source_draft` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscardSourceDraftInput {
    /// The draft's id.
    pub id: String,
}

/// `intel.discard_source_draft` output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscardSourceDraftOutput {
    /// A draft was there and is gone.
    pub discarded: bool,
}
