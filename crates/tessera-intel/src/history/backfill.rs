use chrono::{Datelike, NaiveDate, Weekday};
use tessera_store::level_history::origin;

use super::file;
use super::import::{self, Plan};
use super::io::{BackfillFile, BackfillLevelHistoryInput, BackfillLevelHistoryOutput};
use super::snapshots;
use super::{Adapted, LevelHistory};
use crate::IntelError;
use crate::source::LevelSourceSpec;

pub const MAX_FILES: usize = 20;
pub const MAX_DAYS: i64 = 400;

#[derive(Clone, Debug, PartialEq, Eq)]
struct AskedByABackfill;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRequest {
    pub ticker: String,
    pub package: String,
    pub date: NaiveDate,
    asked: AskedByABackfill,
}

fn date(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|_| format!("{s:?} is not a date (YYYY-MM-DD)"))
}

struct Read {
    spec: LevelSourceSpec,
    package: String,
    instrument: String,
    ticker: String,
}

impl Read {
    fn file(&self, name: &str, bytes: Vec<u8>) -> Result<Adapted, String> {
        let req = self
            .spec
            .requests
            .iter()
            .find(|r| r.package.eq_ignore_ascii_case(&self.package))
            .ok_or_else(|| format!("{} has no {} package", self.spec.vendor, self.package))?;
        let fd = file::from_bytes(name, bytes)?;
        snapshots::read(
            &self.spec,
            req,
            &self.instrument,
            &self.ticker,
            &fd,
            snapshots::EVERY_SECONDS,
        )
    }
}

pub async fn backfill(
    svc: &LevelHistory,
    input: &BackfillLevelHistoryInput,
    by: &str,
) -> Result<BackfillLevelHistoryOutput, String> {
    let providers: Vec<_> = svc
        .router()
        .providers()
        .into_iter()
        .filter(|p| p.capabilities().history)
        .filter(|p| input.provider.as_deref().is_none_or(|id| id == p.id()))
        .collect();
    let Some(p) = providers.first() else {
        let connected: Vec<String> = svc
            .router()
            .providers()
            .iter()
            .filter(|p| p.capabilities().levels)
            .map(|p| format!("{} ({})", p.display_name(), p.id()))
            .collect();
        return Err(if connected.is_empty() {
            "no source of levels is connected; a backfill reads a vendor's own history API".into()
        } else {
            format!(
                "no connected provider's plan includes a history API ({} connected); a vendor's history files are imported with intel.import_level_history",
                connected.join(", ")
            )
        });
    };
    let caps = p.capabilities();
    let info = p.level_source();
    let reach = info.as_ref().and_then(|i| i.history.clone());
    let spec = info
        .as_ref()
        .and_then(|i| i.spec.clone())
        .ok_or_else(|| format!("{} runs no spec to read its history files with", p.id()))?;
    let from = date(&input.from)?;
    let to = input.to.as_deref().map(date).transpose()?.unwrap_or(from);
    if to < from {
        return Err("the last day is before the first".into());
    }
    if (to - from).num_days() > MAX_DAYS {
        return Err(format!("ask for at most {MAX_DAYS} days at a time"));
    }
    let packages = input
        .packages
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| caps.packages.clone());
    let ticker = input.ticker.trim().to_ascii_uppercase();
    if ticker.is_empty() {
        return Err("name the vendor's ticker".into());
    }
    let instrument = input
        .instrument
        .clone()
        .filter(|i| !i.trim().is_empty())
        .or_else(|| {
            reach
                .as_ref()?
                .tickers
                .iter()
                .find(|t| t.ticker.eq_ignore_ascii_case(&ticker))
                .map(|t| t.instrument.clone())
        })
        .unwrap_or_else(|| ticker.clone());
    let dry_run = input.dry_run.unwrap_or(true);
    let done: Vec<String> = svc
        .store()
        .level_history()
        .imports()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|i| i.adapter == format!("backfill:{}", p.id()))
        .filter_map(|i| i.file_name)
        .collect();
    let mut out = BackfillLevelHistoryOutput {
        dry_run,
        provider: p.id().to_owned(),
        ticker: ticker.clone(),
        instrument: instrument.clone(),
        files: Vec::new(),
        imported: 0,
        notes: Vec::new(),
    };
    let mut asked = 0usize;
    let mut day = from;
    while day <= to {
        if matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
            day = day.succ_opt().unwrap_or(to + chrono::Days::new(1));
            continue;
        }
        for pkg in &packages {
            let prefix = format!(
                "{}_{ticker}_{}_",
                day.format("%Y-%m-%d"),
                pkg.to_ascii_lowercase()
            );
            let mut f = BackfillFile {
                date: day.format("%Y-%m-%d").to_string(),
                package: pkg.clone(),
                status: String::new(),
                imported: 0,
                message: None,
            };
            if done.iter().any(|n| n.starts_with(&prefix)) {
                f.status = "already".into();
            } else if dry_run {
                f.status = "would_ask".into();
            } else if asked >= MAX_FILES {
                f.status = "later".into();
            } else {
                asked += 1;
                let req = HistoryRequest {
                    ticker: ticker.clone(),
                    package: pkg.clone(),
                    date: day,
                    asked: AskedByABackfill,
                };
                match p.history_file(&req).await {
                    Ok(hf) => {
                        let read = Read {
                            spec: spec.clone(),
                            package: pkg.clone(),
                            instrument: instrument.clone(),
                            ticker: ticker.clone(),
                        };
                        let plan = Plan {
                            adapter: format!("backfill:{}", p.id()),
                            file_name: Some(format!("{}.gz", hf.name.trim_end_matches(".gz"))),
                            dry_run: false,
                            origin: origin::BACKFILL,
                            instrument: Some(instrument.clone()),
                            by: by.to_owned(),
                            now: svc.now(),
                        };
                        let store = svc.store().clone();
                        let r = tokio::task::spawn_blocking(move || {
                            let a = read.file(&hf.name, hf.bytes)?;
                            import::store(&store, a, &plan)
                        })
                        .await
                        .map_err(|e| e.to_string())
                        .and_then(|r| r);
                        match r {
                            Ok(o) => {
                                f.status = "stored".into();
                                f.imported = o.imported;
                                out.imported += o.imported;
                            }
                            Err(e) => {
                                f.status = "failed".into();
                                f.message = Some(e);
                            }
                        }
                    }
                    Err(e) => {
                        f.status = "failed".into();
                        f.message = Some(match e {
                            IntelError::NotCovered(s)
                            | IntelError::Unsupported(s)
                            | IntelError::Unavailable(s) => s,
                            IntelError::NoSnapshot(t) => format!("nothing at {t}"),
                        });
                    }
                }
            }
            out.files.push(f);
        }
        day = day.succ_opt().unwrap_or(to + chrono::Days::new(1));
    }
    let would = out.files.iter().filter(|f| f.status == "would_ask").count();
    if dry_run {
        let pool = reach
            .as_ref()
            .map(|r| format!(" ({}, Tessera's cap {} a day)", r.pool, r.daily_cap))
            .unwrap_or_default();
        out.notes.push(format!(
            "a dry run: nothing was asked. {would} files would each spend one request of {}'s history quota{pool}; the same call with dryRun false asks for up to {MAX_FILES} of them",
            caps.vendor
        ));
    }
    if out.files.iter().any(|f| f.status == "later") {
        out.notes.push(format!(
            "{MAX_FILES} files a call: ask again for the ones marked later"
        ));
    }
    let keeps = reach.as_ref().map_or_else(
        || " keeps a limited past".into(),
        |r| format!(" keeps the last {} days", r.days_back),
    );
    out.notes.push(format!(
        "{}{keeps}; a day it no longer keeps answers not found. Values are filed under {instrument} in {ticker}'s price space.",
        caps.vendor
    ));
    Ok(out)
}

#[cfg(test)]
mod tests;
