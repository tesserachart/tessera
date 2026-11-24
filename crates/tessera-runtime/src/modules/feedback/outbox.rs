use std::collections::BTreeMap;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tessera_cloud::FeedbackReport;
use tessera_core::backoff::Backoff;

pub const RETRY: Backoff = Backoff::new(Duration::from_secs(30), Duration::from_secs(15 * 60));

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Queued {
    pub report: FeedbackReport,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
}

struct Entry {
    queued: Queued,
    next_at: Instant,
}

pub struct Outbox {
    dir: Option<PathBuf>,
    items: Mutex<BTreeMap<String, Entry>>,
}

impl std::fmt::Debug for Outbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Outbox")
            .field("dir", &self.dir)
            .field("queued", &self.items.lock().len())
            .finish()
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    tessera_core::private::owner_only(&mut options);
    let mut f = options.create(true).write(true).truncate(true).open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

impl Outbox {
    pub fn open(dir: Option<PathBuf>) -> Self {
        let outbox = Self {
            dir: dir.map(|d| d.join("outbox")),
            items: Mutex::new(BTreeMap::new()),
        };
        outbox.load();
        outbox
    }

    fn load(&self) {
        let Some(dir) = &self.dir else { return };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let now = Instant::now();
        let mut items = self.items.lock();
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|b| serde_json::from_slice::<Queued>(&b).map_err(|e| e.to_string()))
            {
                Ok(q) => {
                    items.insert(
                        q.report.id.clone(),
                        Entry {
                            queued: q,
                            next_at: now,
                        },
                    );
                }
                Err(why) => tracing::warn!(%why, "a queued feedback report could not be read"),
            }
        }
    }

    fn path(&self, id: &str) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(format!("{id}.json")))
    }

    fn save(&self, q: &Queued) -> io::Result<()> {
        let (Some(dir), Some(path)) = (&self.dir, self.path(&q.report.id)) else {
            return Ok(());
        };
        tessera_core::private::private_dir(dir)?;
        let bytes = serde_json::to_vec(q).map_err(io::Error::other)?;
        write_private(&path, &bytes)
    }

    pub fn put(&self, report: FeedbackReport) -> io::Result<()> {
        let queued = Queued {
            report,
            attempts: 0,
            last_error: None,
        };
        self.save(&queued)?;
        self.items.lock().insert(
            queued.report.id.clone(),
            Entry {
                queued,
                next_at: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Queued> {
        self.items.lock().get(id).map(|e| e.queued.clone())
    }

    pub fn due(&self, now: Instant) -> Vec<Queued> {
        self.items
            .lock()
            .values()
            .filter(|e| e.next_at <= now)
            .map(|e| e.queued.clone())
            .collect()
    }

    pub fn list(&self) -> Vec<Queued> {
        self.items
            .lock()
            .values()
            .map(|e| e.queued.clone())
            .collect()
    }

    pub fn sent(&self, id: &str) {
        self.items.lock().remove(id);
        if let Some(path) = self.path(id)
            && let Err(e) = std::fs::remove_file(&path)
            && e.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(error = %e, "a sent feedback report stays on disk");
        }
    }

    pub fn refused(&self, id: &str, why: &str) {
        let Some(q) = self.items.lock().remove(id).map(|e| e.queued) else {
            return;
        };
        tracing::warn!(report = %id, %why, "Tessera Cloud refused a feedback report: it is kept aside, not sent again");
        let (Some(dir), Some(path)) = (&self.dir, self.path(id)) else {
            return;
        };
        let aside = dir.with_file_name("refused");
        let moved = tessera_core::private::private_dir(&aside)
            .and_then(|()| std::fs::rename(&path, aside.join(format!("{}.json", q.report.id))));
        if let Err(e) = moved {
            tracing::warn!(error = %e, "a refused feedback report could not be set aside");
        }
    }

    pub fn failed(&self, id: &str, why: String, now: Instant) {
        let saved = {
            let mut items = self.items.lock();
            let Some(e) = items.get_mut(id) else { return };
            e.queued.attempts = e.queued.attempts.saturating_add(1);
            e.queued.last_error = Some(why);
            e.next_at = now + RETRY.delay(e.queued.attempts);
            e.queued.clone()
        };
        if let Err(e) = self.save(&saved) {
            tracing::warn!(error = %e, "a queued feedback report's attempt was not saved");
        }
    }

    pub fn wake(&self, now: Instant) {
        for e in self.items.lock().values_mut() {
            e.next_at = e.next_at.min(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(id: &str) -> FeedbackReport {
        FeedbackReport {
            id: id.into(),
            kind: "bug".into(),
            title: "The DOM froze".into(),
            text: "after a fill".into(),
            steps: Vec::new(),
            expected: None,
            actual: None,
            written_up: false,
            context: Vec::new(),
            screenshot: None,
            app_version: "0.2.0".into(),
            created_at: "2026-10-02T18:42:00Z".into(),
        }
    }

    #[test]
    fn a_queued_report_survives_a_restart_and_backs_off_until_sent() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Outbox::open(Some(dir.path().to_path_buf()));
        outbox.put(report("fb-aaaaaaaaaaaa")).unwrap();
        let now = Instant::now();
        assert_eq!(outbox.due(now).len(), 1);
        outbox.failed("fb-aaaaaaaaaaaa", "offline".into(), now);
        assert!(outbox.due(now).is_empty(), "waits before the next try");
        assert_eq!(outbox.due(now + RETRY.delay(1)).len(), 1);

        let again = Outbox::open(Some(dir.path().to_path_buf()));
        let kept = again.list();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].attempts, 1);
        assert_eq!(kept[0].last_error.as_deref(), Some("offline"));
        assert_eq!(
            again.due(Instant::now()).len(),
            1,
            "a restart tries at once"
        );
        #[cfg(unix)]
        assert!(tessera_core::private::is_private(
            &dir.path().join("outbox/fb-aaaaaaaaaaaa.json")
        ));

        again.sent("fb-aaaaaaaaaaaa");
        assert!(
            Outbox::open(Some(dir.path().to_path_buf()))
                .list()
                .is_empty()
        );
    }

    #[test]
    fn a_refused_report_is_set_aside_and_never_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Outbox::open(Some(dir.path().to_path_buf()));
        outbox.put(report("fb-bbbbbbbbbbbb")).unwrap();
        outbox.refused("fb-bbbbbbbbbbbb", "bad_request");
        assert!(outbox.list().is_empty());
        assert!(dir.path().join("refused/fb-bbbbbbbbbbbb.json").is_file());
        assert!(
            Outbox::open(Some(dir.path().to_path_buf()))
                .list()
                .is_empty()
        );
    }

    #[test]
    fn retries_double_up_to_a_quarter_hour() {
        assert_eq!(RETRY.delay(1), Duration::from_secs(30));
        assert_eq!(RETRY.delay(2), Duration::from_secs(60));
        assert_eq!(RETRY.delay(5), Duration::from_secs(480));
        assert_eq!(RETRY.delay(40), Duration::from_secs(15 * 60));
    }
}
