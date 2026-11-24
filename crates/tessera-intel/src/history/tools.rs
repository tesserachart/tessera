use std::sync::Arc;

use async_trait::async_trait;
use tessera_protocol::tools::RiskTier;
use tessera_tools::{Tool, ToolCtx, ToolError, ToolMeta};

use super::LevelHistory;
use super::io::{
    BackfillLevelHistoryInput, BackfillLevelHistoryOutput, GetLevelHistoryInput,
    GetLevelHistoryOutput, ImportLevelHistoryInput, ImportLevelHistoryOutput,
    ListLevelHistoryInput, ListLevelHistoryOutput, PreviewFileInput, PreviewFileOutput,
    UndoLevelImportInput, UndoLevelImportOutput,
};
use crate::service::IntelService;

fn failed(e: String) -> ToolError {
    if e.starts_with("no history")
        || e.contains("no such file")
        || e.starts_with("no import")
        || e.starts_with("not found")
    {
        ToolError::not_found(e)
    } else if e.contains("outside your home") {
        ToolError::permission_denied(e)
    } else if e.contains("does not have")
        || e.contains("no connected provider")
        || e.contains("no real source")
    {
        ToolError::unsupported(e)
    } else {
        ToolError::invalid_input(e)
    }
}

const NAMES: &str = "Every vendor's levels share one history: a series is one vendor's level on one instrument, its names verbatim (vendor, package, level), named vendor.level (acme.major_long_gamma) or vendor.package.level (acme.state.major_long_gamma) where the vendor key is its name in lower case (Acme → acme). Values come from live snapshots recorded as providers deliver them (origin live), imported files (import) or a vendor's history API (backfill). knownAt is when Tessera could first have known a value: its arrival when live, the vendor's own time for a file.";

const FLOW: &str = "To import a file the user names: (1) intel.preview_file {path} shows its head, each column's kind and time format, and any adapter that recognises it; (2) propose how to read it: a saved one ({kind:'saved', vendor}), a mapping ({kind:'mapping', mapping:{vendor, package?, time, timeFormat?, timeZone?, instrument | instrumentValue, instruments?, level+value (a row per value) | levels:[{column, level?, package?}] (a column per level), naIf?, vocabulary?}}), or JavaScript for a format a mapping cannot say ({kind:'script', vendor, code} exporting records(text, file), run by Tessera's own engine on every platform); (3) call intel.import_level_history with dryRun true (the default) and show the user what would be stored: records, instruments, level names, dates covered, samples, unreadable rows; (4) only when the user says go, call it again with dryRun false (and save true to keep the mapping under the vendor's name). Level names stay exactly as the vendor writes them; never rename them to concepts.";

pub struct GetLevelHistory {
    pub(crate) history: Arc<LevelHistory>,
    pub(crate) intel: Arc<IntelService>,
}

#[async_trait]
impl Tool for GetLevelHistory {
    type Input = GetLevelHistoryInput;
    type Output = GetLevelHistoryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.get_level_history", "Get level history", RiskTier::Read)
            .description(format!("The stored history of market-intelligence levels on an instrument: for each series, its values over a range (vendor time, when it was known, value, the vendor's value before a conversion, not-applicable reason, origin) and its coverage (first and last date, days, values by origin). levels names the series (vendor.level or vendor.package.level); a dated contract also finds its root's series. With nothing stored it says so, and since when recording runs. {NAMES}"))
            .activity("Read level history")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        i: GetLevelHistoryInput,
    ) -> Result<GetLevelHistoryOutput, ToolError> {
        let instrument = match self.intel.resolve(&i.instrument).await {
            Ok(id) => id.to_string(),
            Err(_) => i.instrument.trim().to_ascii_uppercase(),
        };
        let limit = i.limit.unwrap_or(500).clamp(1, 5000) as usize;
        self.history
            .get(&instrument, i.levels.as_deref(), i.from, i.to, limit)
            .map_err(failed)
    }

    fn summarize(&self, out: &GetLevelHistoryOutput) -> Option<String> {
        let n: usize = out.series.iter().map(|s| s.observations.len()).sum();
        Some(format!(
            "{} series, {n} values on {}",
            out.series.len(),
            out.instrument
        ))
    }
}

pub struct ListLevelHistory(pub(crate) Arc<LevelHistory>);

#[async_trait]
impl Tool for ListLevelHistory {
    type Input = ListLevelHistoryInput;
    type Output = ListLevelHistoryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.list_level_history", "List level history", RiskTier::Read)
            .description(format!("What level history Tessera holds: every series with its coverage (first and last New York date, days with values, values by origin), the providers recorded live and since when, every import and backfill (undo one with intel.undo_level_import), and the adapters files can be read with (built-in, and mappings or JavaScript adapters saved under a vendor's name). Studies can only use levels covered here. {NAMES}"))
            .activity("Listed level history")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        _i: ListLevelHistoryInput,
    ) -> Result<ListLevelHistoryOutput, ToolError> {
        self.0.list().map_err(failed)
    }

    fn summarize(&self, out: &ListLevelHistoryOutput) -> Option<String> {
        Some(format!(
            "{} series, {} imports",
            out.series.len(),
            out.imports.len()
        ))
    }
}

pub struct PreviewFile(pub(crate) Arc<LevelHistory>);

#[async_trait]
impl Tool for PreviewFile {
    type Input = PreviewFileInput;
    type Output = PreviewFileOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.preview_file", "Preview a file", RiskTier::Read)
            .description(format!("The head of a file the user names (inside their home or Tessera's data directory; .gz read through), never the whole of it: its format (csv, json, jsonl), header, first 20 rows, each column's kind (number, time, text) with the time format guessed and whether it carries a zone, the first JSON record with long lists cut, and the built-in or saved adapters that recognise it. The first step of an import. {FLOW}"))
            .activity("Previewed a file")
            .result_view("table")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        i: PreviewFileInput,
    ) -> Result<PreviewFileOutput, ToolError> {
        let h = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || h.preview(&i.path))
            .await
            .map_err(|e| ToolError::internal(e.to_string()))?
            .map_err(failed)
    }

    fn summarize(&self, out: &PreviewFileOutput) -> Option<String> {
        Some(format!(
            "{} · {} · {} columns",
            out.file_name,
            out.format,
            out.header.len()
        ))
    }
}

pub struct ImportLevelHistory(pub(crate) Arc<LevelHistory>);

#[async_trait]
impl Tool for ImportLevelHistory {
    type Input = ImportLevelHistoryInput;
    type Output = ImportLevelHistoryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.import_level_history", "Import level history", RiskTier::Modify)
            .description(format!("Imports a vendor's level history from a file (path inside the user's home or Tessera's data directory, or its text) into the one level history, read by an adapter: saved under a vendor's name, a mapping given now, or JavaScript run by Tessera's own engine. dryRun defaults to true: it stores nothing and returns what would be stored (values read and new, duplicates, unreadable rows with why, each series with its dates, instruments, New York dates covered, samples). Only dryRun false writes, deduplicated by series and vendor time; save true then keeps the mapping or JavaScript adapter under the vendor's name. Imported values are known at the vendor's own time. everySeconds keeps the last value of each interval per series. Undo with intel.undo_level_import. {FLOW} {NAMES}"))
            .activity("Imported level history")
            .timeout_ms(600_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: ImportLevelHistoryInput,
    ) -> Result<ImportLevelHistoryOutput, ToolError> {
        self.0
            .import(&i, &ctx.origin.to_string())
            .await
            .map_err(failed)
    }

    fn summarize(&self, out: &ImportLevelHistoryOutput) -> Option<String> {
        let what = if out.dry_run { "would store" } else { "stored" };
        Some(format!(
            "{} {what} {} values in {} series{}",
            out.vendor,
            out.imported,
            out.series.len(),
            match (&out.first_date, &out.last_date) {
                (Some(a), Some(b)) => format!(", {a} to {b}"),
                _ => String::new(),
            }
        ))
    }
}

pub struct UndoLevelImport(pub(crate) Arc<LevelHistory>);

#[async_trait]
impl Tool for UndoLevelImport {
    type Input = UndoLevelImportInput;
    type Output = UndoLevelImportOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.undo_level_import", "Undo a level import", RiskTier::Modify)
            .description("Removes every value an import or a backfill stored (its id from intel.list_level_history or the import's answer), and the import's record. Values recorded live or by other imports stay.")
            .activity("Undid a level import")
    }

    async fn call(
        &self,
        _ctx: &ToolCtx,
        i: UndoLevelImportInput,
    ) -> Result<UndoLevelImportOutput, ToolError> {
        Ok(UndoLevelImportOutput {
            removed: self.0.undo(&i.import_id).map_err(failed)?,
        })
    }
}

pub struct BackfillLevelHistory(pub(crate) Arc<LevelHistory>);

#[async_trait]
impl Tool for BackfillLevelHistory {
    type Input = BackfillLevelHistoryInput;
    type Output = BackfillLevelHistoryOutput;

    fn meta(&self) -> ToolMeta {
        ToolMeta::new("intel.backfill_level_history", "Backfill level history", RiskTier::Modify)
            .description(format!("Reads a vendor's own history API into the level history, for a connected source whose spec declares one in its history block (intel.list_providers: capabilities.history; intel.list_sources: history, with the days it keeps and its tickers). One file per vendor ticker (NDX, or a futures-scale NQ_NDX filed under NQ), package and trading day, each spending one request of the vendor's history quota: dryRun defaults to true and only lists the files; dryRun false asks for up to 20 a call, skipping days stored before. Each file is a day of snapshots shaped like the package's live response, read with its request; the last of each minute is kept. Values stay in the ticker's price space. Never call it without the user asking for a backfill. {NAMES}"))
            .activity("Backfilled level history")
            .timeout_ms(1_800_000)
    }

    async fn call(
        &self,
        ctx: &ToolCtx,
        i: BackfillLevelHistoryInput,
    ) -> Result<BackfillLevelHistoryOutput, ToolError> {
        super::backfill::backfill(&self.0, &i, &ctx.origin.to_string())
            .await
            .map_err(failed)
    }

    fn summarize(&self, out: &BackfillLevelHistoryOutput) -> Option<String> {
        Some(if out.dry_run {
            format!(
                "{} files would be asked",
                out.files.iter().filter(|f| f.status == "would_ask").count()
            )
        } else {
            format!(
                "{} values stored from {} {}",
                out.imported, out.provider, out.ticker
            )
        })
    }
}
