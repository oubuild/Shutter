//! Overlay windows: one per monitor, created on demand and torn down afterwards.
//!
//! Each window covers exactly one monitor (`position` = logical origin,
//! `inner_size` = logical size) and loads the SPA at `index.html?view=overlay`.
//!
//! Two macOS quirks shape this module:
//! * A transparent, borderless window created with `visible(false)` and later
//!   revealed with `show()` stays off-screen (`kCGWindowIsOnscreen` stays -1),
//!   so windows are created visible and *closed* rather than hidden.
//! * Creating the window before capturing means the overlay can appear in its
//!   own screenshot, so capture happens first and windows are built after.

use anyhow::Result;
use tauri::{AppHandle, Manager, WebviewWindow};

/// URL for an overlay window; `CAP_PHOTO_DEBUG_BOX` preselects a region so the
/// toolbar can be driven without a mouse during automation.
fn overlay_url(monitor_id: u32) -> String {
    let debug = std::env::var("CAP_PHOTO_DEBUG_BOX").is_ok();
    if debug {
        format!("index.html?view=overlay&monitor={monitor_id}&debug=box")
    } else {
        format!("index.html?view=overlay&monitor={monitor_id}")
    }
}

pub fn label_for(monitor_id: u32) -> String {
    format!("overlay-{monitor_id}")
}

/// Create the overlay window for one monitor (replacing any stale one).
pub fn create(
    app: &AppHandle,
    monitor_id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<WebviewWindow> {
    let label = label_for(monitor_id);
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.close();
    }

    log::info!("creating overlay window {label} at {x},{y} {width}x{height}");
    let win = crate::windows::layer_window(
        app,
        &label,
        &overlay_url(monitor_id),
        "Shutter",
        x as f64,
        y as f64,
        width as f64,
        height as f64,
        true,
    )?;

    log::info!("overlay window {label} created");
    Ok(win)
}

/// Bring an overlay to the front and confirm it landed on screen.
pub fn reveal(win: &WebviewWindow) -> Result<()> {
    let label = win.label().to_string();
    win.set_always_on_top(true)
        .map_err(|e| anyhow::anyhow!("always-on-top {label}: {e}"))?;
    let _ = win.set_focus();

    // A transparent borderless window can be attached to the window server with
    // the "not on screen" bit still set. Toggling alpha and ordering front is
    // what actually makes macOS composite it.
    // The overlay is a borderless opaque-to-inputs window in an Accessory app:
    // without an explicit activation the first click/keystroke only activates
    // the window and is swallowed, which reads as "the toolbar does nothing".
    crate::windows::focus_when_ready(win.clone());

    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(_) = win.app_handle().get_webview_window(&label) {
            win.set_ignore_cursor_events(false).ok();
            win.show().ok();
            // Nudge the frame: some macOS versions ignore the first show of a
            // window created with a non-standard level.
            let pos = win.outer_position().unwrap_or_default();
            let _ = win.set_position(tauri::LogicalPosition::new(pos.x, pos.y + 1));
            let _ = win.set_position(tauri::LogicalPosition::new(pos.x, pos.y));
        }
    }
    let size = win.inner_size().map(|s| (s.width, s.height)).unwrap_or((0, 0));
    let pos = win.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    log::info!(
        "overlay {label} revealed: visible={:?} size={size:?} pos={pos:?}",
        win.is_visible()
    );
    Ok(())
}

/// Destroy every overlay window. Closing is deliberate: `hide()` + `show()`
/// leaves a transparent macOS window off-screen on the next reveal.
pub fn destroy_all(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            if let Err(e) = win.close() {
                log::warn!("close {label}: {e}");
            }
        }
    }
}
