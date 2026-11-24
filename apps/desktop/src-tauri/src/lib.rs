mod login_path;
#[cfg(target_os = "macos")]
mod mac_windows;
mod placement;
mod sidecar;
mod updates;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub use sidecar::{
    RuntimeConnection, Sidecar, SidecarConfig, SidecarStatus, parse_ready_line, resolve_runtime,
};

const MAX_PICK_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
async fn runtime_connection(sidecar: State<'_, Arc<Sidecar>>) -> Result<RuntimeConnection, String> {
    sidecar.connection(Duration::from_secs(90)).await
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn ask_desk_to_quit<R: Runtime>(handle: &AppHandle<R>) -> bool {
    match handle.get_webview_window("main") {
        Some(main) => main.close().is_ok(),
        None => false,
    }
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: Option<String>) -> bool {
    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    builder.show().is_ok()
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
    {
        return Err(format!(
            "refusing to open {url}: only http, https and mailto URLs are allowed"
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
async fn save_file(
    app: AppHandle,
    suggested_name: String,
    data_base64: String,
    filters: Vec<FileFilter>,
) -> Result<bool, String> {
    let bytes = BASE64
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("invalid payload: {e}"))?;
    let mut dialog = app.dialog().file().set_file_name(&suggested_name);
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&f.name, &exts);
    }
    let Some(target) = dialog.blocking_save_file() else {
        return Ok(false);
    };
    let path = target.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    name: String,
    path: String,
    data_base64: String,
}

#[tauri::command]
async fn pick_files(
    app: AppHandle,
    multiple: bool,
    filters: Vec<FileFilter>,
) -> Result<Vec<PickedFile>, String> {
    let mut dialog = app.dialog().file();
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&f.name, &exts);
    }
    let picked = if multiple {
        dialog.blocking_pick_files().unwrap_or_default()
    } else {
        dialog.blocking_pick_file().into_iter().collect()
    };
    picked
        .into_iter()
        .map(|fp| {
            let path: PathBuf = fp.into_path().map_err(|e| e.to_string())?;
            let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if len > MAX_PICK_BYTES {
                return Err(format!("{} is larger than 64 MB", path.display()));
            }
            let bytes = std::fs::read(&path)
                .map_err(|e| format!("could not read {}: {e}", path.display()))?;
            Ok(PickedFile {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                data_base64: BASE64.encode(bytes),
            })
        })
        .collect()
}

fn start_sidecar() -> Arc<Sidecar> {
    let env: Vec<(String, String)> = login_path::runtime_path()
        .map(|path| vec![("PATH".to_string(), path)])
        .unwrap_or_default();
    match resolve_runtime() {
        Ok((program, args)) => Sidecar::start(SidecarConfig {
            program,
            args,
            ready_timeout: Duration::from_secs(60),
            max_restarts: 5,
            env,
        }),
        Err(reason) => {
            eprintln!("[tessera-desktop] {reason}");
            Sidecar::failed(
                SidecarConfig {
                    program: PathBuf::new(),
                    args: vec![],
                    ready_timeout: Duration::ZERO,
                    max_restarts: 0,
                    env: vec![],
                },
                reason,
            )
        }
    }
}

pub fn webview_data_dir(var: Option<OsString>) -> Option<PathBuf> {
    let dir = PathBuf::from(var?);
    dir.is_absolute().then_some(dir)
}

const CLOSE_WINDOW_ID: &str = "tessera.close-window";
const QUIT_ID: &str = "tessera.quit";

/// AppKit offers a key to the menu bar before the page, so the default menu's ⌘W Close Window would
/// close the window instead of letting ⌘W reach the page.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn desk_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = handle.package_info();
    let config = handle.config();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let close_window = MenuItem::with_id(
        handle,
        CLOSE_WINDOW_ID,
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    let check_updates = MenuItem::with_id(
        handle,
        updates::CHECK_MENU_ID,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let app_menu = Submenu::with_items(
        handle,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about))?,
            &check_updates,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                QUIT_ID,
                format!("Quit {}", pkg.name),
                true,
                Some("CmdOrCtrl+Q"),
            )?,
        ],
    )?;
    let file_menu = Submenu::with_items(handle, "File", true, &[&close_window])?;
    // the edit items carry the clipboard keys into the webview's fields
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;
    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
        ],
    )?;
    Menu::with_items(
        handle,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

fn on_menu<R: Runtime>(handle: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() == updates::CHECK_MENU_ID {
        updates::ask_window_to_check(handle);
        return;
    }
    if event.id().as_ref() == QUIT_ID {
        if !ask_desk_to_quit(handle) {
            handle.exit(0);
        }
        return;
    }
    if event.id().as_ref() != CLOSE_WINDOW_ID {
        return;
    }
    let focused = handle
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));
    if let Some(window) = focused {
        let _ = window.close();
    }
}

fn open_main_window<R: Runtime>(handle: &AppHandle<R>) {
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let config = handle
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main");
    let preferred = config.map_or((1600.0, 1000.0), |w| (w.width, w.height));
    let minimum = config.map_or((0.0, 0.0), |w| {
        (w.min_width.unwrap_or(0.0), w.min_height.unwrap_or(0.0))
    });
    placement::fit_and_show(&window, preferred, minimum);
}

pub fn run() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if let Some(dir) = webview_data_dir(std::env::var_os("TESSERA_WEBVIEW_DATA_DIR")) {
        use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides};
        eprintln!("[tessera-desktop] webview data in {}", dir.display());
        // The app's local data directory is the webviews' default data directory on Linux and Windows.
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Directories(AppDirectoryOverrides {
                local_data: Some(dir),
                ..AppDirectoryOverrides::default()
            }));
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(desk_menu).plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("mac-windows")
            .on_window_ready(|window| mac_windows::hide_title_bar(&window))
            .build(),
    );
    let app = builder
        .on_menu_event(on_menu)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            open_main_window(app.handle());
            app.manage(start_sidecar());
            app.manage(<updates::Pending>::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_connection,
            quit,
            notify,
            open_external,
            save_file,
            pick_files,
            updates::update_check,
            updates::update_download,
            updates::update_install
        ])
        .build(context)
        .expect("failed to build the Tessera shell");

    app.run(|handle, event| match event {
        RunEvent::ExitRequested {
            code: None, api, ..
        } => {
            if ask_desk_to_quit(handle) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            if let Some(sidecar) = handle.try_state::<Arc<Sidecar>>() {
                sidecar.stop(Duration::from_secs(3));
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_data_dir_is_an_absolute_path_or_nothing() {
        assert_eq!(webview_data_dir(None), None);
        assert_eq!(webview_data_dir(Some("".into())), None);
        assert_eq!(webview_data_dir(Some("relative/webview".into())), None);
        assert_eq!(
            webview_data_dir(Some(
                "/home/u/.local/share/tessera-dev/repo-1234abcd/webview".into()
            )),
            Some(PathBuf::from(
                "/home/u/.local/share/tessera-dev/repo-1234abcd/webview"
            ))
        );
    }
}
