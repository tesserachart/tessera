use objc2::MainThreadOnly as _;
use objc2_app_kit::{
    NSApplication, NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
};
use tauri::{Runtime, Window};

// AppKit lists only titled windows in the Window menu and the Dock, and adds one only as it is ordered in or retitled;
// an undecorated Tauri window is borderless, and already on screen when Tauri reports it ready.
pub fn hide_title_bar<R: Runtime>(window: &Window<R>) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(handle) = target.ns_window() else {
            return;
        };
        // SAFETY: Tauri hands out the window's live NSWindow, and this runs on the main thread AppKit requires.
        let ns_window = unsafe { &*handle.cast::<NSWindow>() };
        let mask = ns_window.styleMask();
        if mask.contains(NSWindowStyleMask::Titled) {
            return;
        }
        ns_window.setStyleMask(
            mask | NSWindowStyleMask::Titled
                | NSWindowStyleMask::FullSizeContentView
                | NSWindowStyleMask::Closable,
        );
        ns_window.setTitlebarAppearsTransparent(true);
        ns_window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
        for button in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(button) = ns_window.standardWindowButton(button) {
                button.setHidden(true);
            }
        }
        NSApplication::sharedApplication(ns_window.mtm()).addWindowsItem_title_filename(
            ns_window,
            &ns_window.title(),
            false,
        );
    });
}
