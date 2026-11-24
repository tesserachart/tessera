use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::Sidecar;

pub const CHECK_MENU_ID: &str = "tessera.check-updates";

pub const EVENT: &str = "tessera://update";

pub trait Versioned {
    fn version(&self) -> &str;
}

impl Versioned for Update {
    fn version(&self) -> &str {
        &self.version
    }
}

pub struct Pending<U = Update> {
    held: Mutex<Option<Held<U>>>,
    check_in_flight: tokio::sync::Mutex<()>,
    download_in_flight: tokio::sync::Mutex<()>,
}

impl<U> Default for Pending<U> {
    fn default() -> Self {
        Self {
            held: Mutex::new(None),
            check_in_flight: tokio::sync::Mutex::new(()),
            download_in_flight: tokio::sync::Mutex::new(()),
        }
    }
}

struct Held<U> {
    update: U,
    bytes: Option<Vec<u8>>,
}

impl<U: Versioned + Clone> Pending<U> {
    fn held(&self) -> MutexGuard<'_, Option<Held<U>>> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn hold_found(&self, update: Option<U>) {
        let mut held = self.held();
        let bytes = held
            .take()
            .zip(update.as_ref())
            .filter(|(old, new)| old.update.version() == new.version())
            .and_then(|(old, _)| old.bytes);
        *held = update.map(|update| Held { update, bytes });
    }

    fn update_to_download(&self) -> Result<Option<U>, String> {
        match self.held().as_ref() {
            None => Err("no update has been found".into()),
            Some(Held { bytes: Some(_), .. }) => Ok(None),
            Some(Held {
                update,
                bytes: None,
            }) => Ok(Some(update.clone())),
        }
    }

    fn hold_downloaded(&self, version: &str, bytes: Vec<u8>) -> Result<(), String> {
        match self.held().as_mut() {
            Some(held) if held.update.version() == version => {
                held.bytes = Some(bytes);
                Ok(())
            }
            _ => Err("the update changed while it was downloading".into()),
        }
    }

    fn install_downloaded(
        &self,
        apply: impl FnOnce(&U, &[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut held = self.held();
        let Some(Held {
            update,
            bytes: Some(bytes),
        }) = held.as_ref()
        else {
            return Err("no update has been downloaded".into());
        };
        apply(update, bytes)?;
        *held = None;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFound {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum UpdateEvent {
    Downloading {
        version: String,
        downloaded: u64,
        total: Option<u64>,
    },
    Check,
}

fn progress_step(downloaded: u64, total: Option<u64>) -> u64 {
    match total {
        Some(total) if total > 0 => downloaded.min(total) * 100 / total,
        _ => downloaded >> 20,
    }
}

async fn check<R: Runtime>(
    app: &AppHandle<R>,
    pending: &Pending,
) -> Result<Option<UpdateFound>, String> {
    let _check_in_flight = pending.check_in_flight.lock().await;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let found = update.as_ref().map(|update| UpdateFound {
        version: update.version.clone(),
        notes: update.body.clone(),
    });
    pending.hold_found(update);
    Ok(found)
}

async fn download<R: Runtime>(app: &AppHandle<R>, pending: &Pending) -> Result<(), String> {
    let _download_in_flight = pending.download_in_flight.lock().await;
    let Some(update) = pending.update_to_download()? else {
        return Ok(());
    };
    let version = update.version.clone();
    let downloading = |downloaded, total| UpdateEvent::Downloading {
        version: version.clone(),
        downloaded,
        total,
    };
    let _ = app.emit(EVENT, downloading(0, None));
    let (mut downloaded, mut step) = (0_u64, None);
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let now = progress_step(downloaded, total);
                if step != Some(now) {
                    step = Some(now);
                    let _ = app.emit(EVENT, downloading(downloaded, total));
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    pending.hold_downloaded(&version, bytes)
}

fn install<R: Runtime>(app: &AppHandle<R>, pending: &Pending) -> Result<(), String> {
    pending.install_downloaded(|update, bytes| update.install(bytes).map_err(|e| e.to_string()))?;
    if let Some(sidecar) = app.try_state::<Arc<Sidecar>>() {
        sidecar.stop_updated(Duration::from_secs(30));
    }
    app.restart()
}

pub fn ask_window_to_check<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(EVENT, UpdateEvent::Check);
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, Pending>,
) -> Result<Option<UpdateFound>, String> {
    check(&app, &pending).await
}

#[tauri::command]
pub async fn update_download(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    download(&app, &pending).await
}

#[tauri::command]
pub fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    install(&app, &pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_is_heard_on_each_whole_per_cent_or_each_mib() {
        assert_eq!(progress_step(0, Some(1_000)), 0);
        assert_eq!(progress_step(9, Some(1_000)), 0);
        assert_eq!(progress_step(10, Some(1_000)), 1);
        assert_eq!(progress_step(1_000, Some(1_000)), 100);
        assert_eq!(progress_step(1_200, Some(1_000)), 100);
        assert_eq!(progress_step((1 << 20) - 1, None), 0);
        assert_eq!(progress_step(3 << 20, None), 3);
        assert_eq!(progress_step(5 << 20, Some(0)), 5);
    }

    #[test]
    fn the_window_hears_kind_tagged_events() {
        let downloading = UpdateEvent::Downloading {
            version: "0.2.0-alpha.1".into(),
            downloaded: 512,
            total: Some(2_048),
        };
        assert_eq!(
            serde_json::to_value(&downloading).unwrap(),
            serde_json::json!({"kind": "downloading", "version": "0.2.0-alpha.1", "downloaded": 512, "total": 2048})
        );
        assert_eq!(
            serde_json::to_value(&UpdateEvent::Check).unwrap(),
            serde_json::json!({"kind": "check"})
        );
    }

    #[test]
    fn a_found_update_is_sent_with_its_version_and_notes() {
        let found = UpdateFound {
            version: "0.2.0-alpha.1".into(),
            notes: None,
        };
        assert_eq!(
            serde_json::to_value(&found).unwrap(),
            serde_json::json!({"version": "0.2.0-alpha.1", "notes": null})
        );
    }

    #[derive(Clone)]
    struct Found(&'static str);

    impl Versioned for Found {
        fn version(&self) -> &str {
            self.0
        }
    }

    #[test]
    fn a_failed_install_keeps_the_downloaded_update_for_another_try() {
        let pending: Pending<Found> = Pending::default();
        pending.hold_found(Some(Found("0.2.0")));
        pending.hold_downloaded("0.2.0", vec![1, 2, 3]).unwrap();
        let failed = pending.install_downloaded(|_, _| Err("the disk is full".into()));
        assert_eq!(failed, Err("the disk is full".into()));
        assert!(
            pending.update_to_download().unwrap().is_none(),
            "nothing to download again"
        );
        let mut installed = None;
        pending
            .install_downloaded(|u, bytes| {
                installed = Some((u.0, bytes.to_vec()));
                Ok(())
            })
            .unwrap();
        assert_eq!(installed, Some(("0.2.0", vec![1, 2, 3])));
        assert!(pending.install_downloaded(|_, _| Ok(())).is_err());
    }
}
