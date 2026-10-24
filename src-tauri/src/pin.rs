//! Pin windows: a borderless always-on-top image viewer.
//!
//! Reference `assets_index-CM6hgQ3v.js` (`pin_panel_*`): a padded, rounded
//! image card floating over a transparent window — the 20px frame is part of
//! the window, the image fills the rest, and the card carries its own CSS
//! shadow. Resizing is done by the webview's aspect-locked edge zones, so the
//! native window must not offer its own resize handles or shadow.

use anyhow::Result;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::types::Rect;

/// Transparent margin around the image card on every side (reference `p-20`).
pub const FRAME_PAD: f64 = 20.0;

pub fn ensure(app: &AppHandle, pin_id: &str, rect: Rect) -> Result<WebviewWindow> {
    let label = format!("pin-{pin_id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(win);
    }

    let win = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?view=pin&id={pin_id}").into()),
    )
    .title("Shutter pin")
    .position(rect.x, rect.y)
    .inner_size(rect.width.max(80.0), rect.height.max(80.0))
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    // The pin must not steal focus from the page it was taken of (reference
    // pins only react to Escape once the user has actually focused them).
    .focused(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .build()?;

    Ok(win)
}

/// The pin source is kept in the asset protocol scope, so the frontend can
/// load it with `convertFileSrc` rather than a data URL.
pub fn scope_path(app: &AppHandle, path: &str) {
    use tauri::Manager;
    let _ = app.asset_protocol_scope().allow_file(path);
}

pub fn close(app: &AppHandle, pin_id: &str) {
    if let Some(win) = app.get_webview_window(&format!("pin-{pin_id}")) {
        let _ = win.close();
    }
}
