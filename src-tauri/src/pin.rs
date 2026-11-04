//! Pin windows: a borderless always-on-top image viewer.
//!
//! Reference `assets_index-CM6hgQ3v.js` (`pin_panel_*`): a padded, rounded
//! image card floating over a transparent window — the 20px frame is part of
//! the window, the image fills the rest, and the card carries its own CSS
//! shadow. Resizing is done by the webview's aspect-locked edge zones, so the
//! native window must not offer its own resize handles or shadow.

use anyhow::Result;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::types::{MonitorInfo, Rect};

/// Transparent margin around the image card on every side (reference `p-20`).
pub const FRAME_PAD: f64 = 20.0;

/// Share of the monitor a pin may cover at most (reference behaviour: big
/// pins shrink instead of overflowing the screen).
const FIT_FRACTION: f64 = 0.8;

/// Window rect (image + `FRAME_PAD`) for pinning a selection.
///
/// `rect` is logical and monitor-local; the result is a global window rect. A
/// 1:1 pin of a near-fullscreen selection would make the padded window larger
/// than the monitor — macOS then clamps it back on screen, displacing the
/// image into a misaligned "ghost of the desktop". Oversized selections are
/// therefore scaled down (towards the selection centre, capped at
/// [`FIT_FRACTION`] of the monitor) and the whole card is kept on screen.
pub fn frame_for(monitor: &MonitorInfo, rect: Rect) -> Rect {
    let (mw, mh) = (monitor.width as f64, monitor.height as f64);
    let fit = ((mw * FIT_FRACTION) / rect.width)
        .min((mh * FIT_FRACTION) / rect.height)
        .min(1.0);
    let width = rect.width * fit + FRAME_PAD * 2.0;
    let height = rect.height * fit + FRAME_PAD * 2.0;
    // Shrink towards the selection centre, then keep the padded card onscreen.
    let x = (monitor.x as f64 + rect.x + (rect.width - rect.width * fit) / 2.0 - FRAME_PAD)
        .clamp(monitor.x as f64, monitor.x as f64 + mw - width);
    let y = (monitor.y as f64 + rect.y + (rect.height - rect.height * fit) / 2.0 - FRAME_PAD)
        .clamp(monitor.y as f64, monitor.y as f64 + mh - height);
    Rect { x, y, width, height }
}

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
    // Floating (3) sits below the Dock (20); a pin dragged near the screen
    // edge would otherwise be covered by it.
    crate::windows::raise_above_dock(&win);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> MonitorInfo {
        MonitorInfo {
            id: 1,
            name: "Main".into(),
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
            pixel_width: 2880,
            pixel_height: 1800,
            scale_factor: 2.0,
            is_primary: true,
        }
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, width: w, height: h }
    }

    #[test]
    fn small_selection_pins_one_to_one_in_place() {
        let m = monitor();
        let frame = frame_for(&m, rect(100.0, 120.0, 400.0, 300.0));
        assert_eq!(frame, rect(80.0, 100.0, 440.0, 340.0));
    }

    #[test]
    fn fullscreen_selection_shrinks_and_stays_onscreen() {
        let m = monitor();
        // The whole monitor: a 1:1 padded pin would be 1480x940 and overflow.
        let frame = frame_for(&m, rect(0.0, 0.0, 1440.0, 900.0));
        let img_w = frame.width - FRAME_PAD * 2.0;
        let img_h = frame.height - FRAME_PAD * 2.0;
        // 80% of the monitor, aspect preserved (same ratio as the selection).
        assert!((img_w - 1440.0 * 0.8).abs() < 1.0, "img_w {img_w}");
        assert!((img_h - 900.0 * 0.8).abs() < 1.0, "img_h {img_h}");
        assert!(frame.x >= 0.0 && frame.y >= 0.0, "offscreen origin {frame:?}");
        assert!(
            frame.x + frame.width <= 1440.0 && frame.y + frame.height <= 900.0,
            "overflows monitor {frame:?}"
        );
    }

    #[test]
    fn oversized_selection_near_the_edge_is_pulled_back_onscreen() {
        let m = monitor();
        let frame = frame_for(&m, rect(1000.0, 700.0, 500.0, 300.0));
        assert!(frame.x + frame.width <= 1440.0, "right edge offscreen {frame:?}");
        assert!(frame.y + frame.height <= 900.0, "bottom edge offscreen {frame:?}");
    }
}
