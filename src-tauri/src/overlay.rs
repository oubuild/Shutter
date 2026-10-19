//! Overlay windows: one per monitor, created on demand and reused afterwards.
//!
//! Each window covers exactly one monitor (`position` = logical origin,
//! `inner_size` = logical size) and loads the SPA at `index.html#/overlay`.

use anyhow::Result;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WebviewWindow};

pub fn label_for(monitor_id: u32) -> String {
    format!("overlay-{monitor_id}")
}

/// Create (or reuse) the overlay window for one monitor.
pub fn ensure(
    app: &AppHandle,
    monitor_id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<WebviewWindow> {
    let label = label_for(monitor_id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        let _ = win.set_size(tauri::LogicalSize::new(width, height));
        return Ok(win);
    }

    let win = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?view=overlay&monitor={monitor_id}").into()),
    )
    .title("cap-photo")
    .position(x as f64, y as f64)
    .inner_size(width as f64, height as f64)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .accept_first_mouse(true)
    .focused(true)
    .visible(false)
    .build()?;

    Ok(win)
}

/// Show an overlay and put it in front of everything else.
pub fn show(win: &WebviewWindow) -> Result<()> {
    win.show()?;
    // Re-assert always-on-top after showing: full-screen apps otherwise cover it.
    win.set_always_on_top(true)?;
    win.set_focus()?;
    Ok(())
}

pub fn hide_all(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.hide();
        }
    }
}

pub fn close_all(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.close();
        }
    }
}
