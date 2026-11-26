use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tessera_protocol::agent::Epistemic;
use tessera_protocol::io::ChartChangeOutput;
use tessera_protocol::layout::Layout;
use tessera_protocol::templates::ChartTemplates;
use ts_rs::TS;

/// `share.preview_conversation` and `share.conversation` input: which analyst conversation, and
/// whether its money amounts stay in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareConversationInput {
    /// The analyst session (`S15`).
    pub session_id: String,
    /// Keep P/L and other money amounts in the text; position sizes are hidden either way.
    #[serde(default)]
    pub show_pnl: bool,
}

/// The public page of a shared conversation, exactly as it will read: what was said and what the
/// analyst did, never what a tool returned, with every account's id and name, links, hosts and
/// secrets taken out, position sizes hidden, and money amounts hidden unless `amounts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedConversation {
    /// The page format; 1.
    pub v: u32,
    /// The conversation's title, scrubbed.
    pub title: String,
    /// Whether money amounts were left in (`showPnl`).
    pub amounts: bool,
    /// The messages, oldest first.
    pub turns: Vec<SharedTurn>,
}

/// One message on a shared conversation's page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "role", rename_all = "snake_case", deny_unknown_fields)]
pub enum SharedTurn {
    /// What the trader wrote.
    User {
        /// The message, scrubbed.
        text: String,
        /// How many pictures or files were attached; they are not shared.
        files: u32,
    },
    /// One analyst turn: the steps it took, then its answer.
    Analyst {
        /// The tool steps, in order, folded under "Worked for …" on the page.
        work: Vec<SharedWork>,
        /// How long the turn worked, in milliseconds, when known.
        #[serde(rename = "workedMs")]
        #[ts(type = "number | null")]
        worked_ms: Option<u64>,
        /// The answer, Markdown, scrubbed.
        answer: String,
        /// The answer's result blocks (measured, observed, hypothesis, interpretation).
        blocks: Vec<SharedBlock>,
    },
}

/// One step the analyst took, as its card reads in the chat: never its arguments or its answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedWork {
    /// The tool's namespace (`chart`, `market`), which picks the card's icon.
    pub ns: String,
    /// The card's words (`Read bars`): the tool's own title for a tool that touches an account.
    pub label: String,
    /// The card's quiet second line, such as its duration (`1.2 s`).
    pub meta: Option<String>,
    /// The step failed or was refused.
    pub failed: bool,
}

/// A result block of an analyst answer, labelled with what kind of claim it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedBlock {
    /// Measured, observed, hypothesis or interpretation.
    pub kind: Epistemic,
    /// Its heading, scrubbed.
    pub title: Option<String>,
    /// Its text, Markdown, scrubbed.
    pub text: String,
    /// Its label and value pairs, scrubbed.
    pub rows: Vec<(String, String)>,
}

/// `share.setup` input: the indicator, template or workspace to share by its settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ShareSetupInput {
    /// An indicator on a chart, with that chart's settings for it.
    Indicator {
        /// The workspace (`default`).
        #[serde(rename = "layoutId")]
        layout_id: String,
        /// The chart tile (`chart-1`).
        #[serde(rename = "tileId")]
        tile_id: String,
        /// The indicator's layer id on that chart.
        #[serde(rename = "layerId")]
        layer_id: String,
    },
    /// A custom indicator from the Indicators area, at its default settings.
    CustomIndicator {
        /// Its id (`ci_…`).
        id: String,
    },
    /// One of the user's chart templates.
    Template {
        /// Its id.
        id: String,
    },
    /// A workspace: its charts, their indicators and how the desk is arranged.
    Layout {
        /// The workspace (`default`).
        #[serde(rename = "layoutId")]
        layout_id: String,
    },
}

/// What a shared indicator, template or workspace is, in words for its page and for the dialog
/// that offers to add it. Every string is plain text; nothing here is run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupDisplay {
    /// What it is (`RSI`, `Order flow`, `Scalping desk`).
    pub name: String,
    /// One line on what kind of thing it is (`Indicator`, `Chart template · 4 indicators`).
    pub about: String,
    /// Its own settings, in order (`Length` `14`); a colour is `#rrggbb`.
    pub lines: Vec<SetupLine>,
    /// What it holds: a template's indicators, a workspace's charts, each with its settings.
    pub parts: Vec<SetupPart>,
    /// The code of each custom indicator it brings.
    pub code: Vec<SetupCode>,
}

/// One setting in words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupLine {
    /// The setting's name (`Length`).
    pub label: String,
    /// Its value (`14`, `Close`, `#8ed1fc`).
    pub value: String,
}

/// One indicator of a template, or one chart of a workspace, with its settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupPart {
    /// Its name (`VWAP`, `NQ · 5m`).
    pub name: String,
    /// Its settings, or a chart's indicators by name.
    pub lines: Vec<SetupLine>,
}

/// A custom indicator's source, shown on the page so anyone can read what it runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupCode {
    /// The custom indicator's name.
    pub name: String,
    /// Its JavaScript source.
    pub code: String,
}

/// `share.open` input: a link someone shared, as pasted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareOpenInput {
    /// The link (`https://account.tesserachart.com/s/Ab3dE6gH9jK0`).
    pub url: String,
}

/// The kinds of share that carry settings Tessera can add.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SetupKind {
    /// An indicator with its settings, and its code when it is a custom one.
    Indicator,
    /// A chart template: a chart type and indicators.
    Template,
    /// A workspace: charts with their indicators, and the desk's arrangement.
    Layout,
}

/// `share.open` output: what the link holds, before anything is added.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    /// The share's id, the last part of the link.
    pub id: String,
    /// The link, normalised.
    pub url: String,
    /// Indicator, template or workspace.
    pub kind: SetupKind,
    /// What its page calls it.
    pub title: String,
    /// What it is, in words.
    pub display: SetupDisplay,
}

/// `share.add` input: add what a shared link holds to this Tessera.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareAddInput {
    /// The link, as `share.open` read it.
    pub url: String,
    /// The workspace of the chart an indicator or template goes on.
    #[serde(default)]
    pub layout_id: Option<String>,
    /// The chart an indicator or template goes on; a template without one is only saved.
    #[serde(default)]
    pub tile_id: Option<String>,
}

/// `share.add` output: what was added, for the desk to show at once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShareAddOutput {
    /// The indicator is on the chart.
    Indicator {
        /// The chart after the indicator was added.
        chart: ChartChangeOutput,
    },
    /// The template is in the user's templates, and on the chart when one was named.
    Template {
        /// Every template, with the new one.
        templates: ChartTemplates,
        /// The new template's id.
        #[serde(rename = "templateId")]
        template_id: String,
        /// The chart after the template was applied, when a chart was named.
        applied: Option<ChartChangeOutput>,
    },
    /// The workspace is saved as a new one of the user's.
    Layout {
        /// The new workspace.
        layout: Layout,
    },
}
