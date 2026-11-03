//! Screen enumeration and raw frame capture.

use crate::types::{MonitorInfo, WindowInfo};
use anyhow::{Context, Result};
use image::RgbaImage;
use xcap::Monitor;

/// A monitor that can be captured, plus the descriptor the frontend sees.
///
/// This deliberately borrows the live `xcap::Monitor` for a single call rather
/// than storing it in the session: on Windows that type wraps an `HMONITOR`
/// (`*mut c_void`) and is therefore `!Send`, which would make any struct
/// holding it unusable as Tauri managed state.
pub struct Display {
    pub info: MonitorInfo,
    monitor: Monitor,
}

impl Display {
    /// Capture the whole monitor at physical resolution.
    pub fn capture(&self) -> Result<RgbaImage> {
        let frame = self
            .monitor
            .capture_image()
            .with_context(|| format!("capture monitor {}", self.info.id))?;
        Ok(frame)
    }
}

/// Enumerate every active display, with both logical and physical dimensions.
pub fn displays() -> Result<Vec<Display>> {
    let monitors = Monitor::all().context("enumerate monitors")?;
    let mut out = Vec::with_capacity(monitors.len());

    for monitor in monitors {
        let scale = monitor.scale_factor().unwrap_or(1.0) as f64;
        let width = monitor.width().unwrap_or(0);
        let height = monitor.height().unwrap_or(0);
        if width == 0 || height == 0 {
            continue;
        }
        let info = MonitorInfo {
            id: monitor.id().unwrap_or(0),
            name: monitor
                .friendly_name()
                .or_else(|_| monitor.name())
                .unwrap_or_else(|_| format!("Display {}", out.len() + 1)),
            x: monitor.x().unwrap_or(0),
            y: monitor.y().unwrap_or(0),
            width,
            height,
            pixel_width: (width as f64 * scale).round() as u32,
            pixel_height: (height as f64 * scale).round() as u32,
            scale_factor: scale,
            is_primary: monitor.is_primary().unwrap_or(false),
        };
        out.push(Display { info, monitor });
    }

    out.sort_by_key(|d| (!d.info.is_primary, d.info.x, d.info.y));
    Ok(out)
}

/// Find one display by id. Callers that capture repeatedly (the scroll
/// worker) should resolve this once on their own thread and reuse the
/// `Display`, so the per-frame path never re-enumerates monitors.
pub fn find_display(id: u32) -> Result<Display> {
    displays()?
        .into_iter()
        .find(|d| d.info.id == id)
        .ok_or_else(|| anyhow::anyhow!("显示器 {id} 不可用"))
}

/// Enumerate the displays and capture every one, returning plain data only.
///
/// The live `xcap::Monitor` handles are created and dropped inside this
/// synchronous function, so the caller only ever receives `Send` values and
/// can safely store the result in Tauri managed state.
pub fn capture_all() -> Result<(Vec<MonitorInfo>, Vec<(u32, RgbaImage)>)> {
    let displays = displays()?;
    let mut frames = Vec::with_capacity(displays.len());
    for display in &displays {
        frames.push((display.info.id, display.capture()?));
    }
    let monitors = displays.into_iter().map(|d| d.info).collect();
    Ok((monitors, frames))
}

/// One entry of the window server's on-screen list, before any filtering.
#[cfg(target_os = "macos")]
pub(crate) struct RawWindow {
    pub(crate) layer: i32,
    pub(crate) owner: String,
    pub(crate) title: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// The raw CGWindowListCopyWindowInfo dump: every on-screen window except
/// desktop elements, in the window server's front-to-back order (higher
/// layers first, front-to-back within a layer — the visual stacking order).
#[cfg(target_os = "macos")]
pub(crate) fn raw_windows() -> Vec<RawWindow> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    // Raw CGWindowListCopyWindowInfo: core-graphics declares the function but
    // not the option constants, and those are stable ABI values.
    const OPTION_ON_SCREEN_ONLY: u32 = 1;
    const OPTION_EXCLUDE_DESKTOP_ELEMENTS: u32 = 4;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *const std::ffi::c_void;
    }

    type Dict = CFDictionary<CFString, CFType>;

    let mut out = Vec::new();

    // The result is owned (Copy), so wrap_under_create_rule is correct.
    let array = unsafe {
        let ptr = CGWindowListCopyWindowInfo(
            OPTION_ON_SCREEN_ONLY | OPTION_EXCLUDE_DESKTOP_ELEMENTS,
            0, // kCGNullWindowID
        );
        if ptr.is_null() {
            return out;
        }
        CFArray::<Dict>::wrap_under_create_rule(ptr.cast())
    };

    for window in array.iter() {
        let window: &Dict = &window;
        let number = |dict: &Dict, key: &str| -> Option<CFNumber> {
            dict.find(CFString::new(key))
                .and_then(|v| v.clone().downcast_into::<CFNumber>())
        };
        let string = |dict: &Dict, key: &str| -> String {
            dict.find(CFString::new(key))
                .and_then(|v| v.clone().downcast_into::<CFString>())
                .map(|s| s.to_string())
                .unwrap_or_default()
        };

        // The bounds sub-dictionary is only known to the runtime as a CFType;
        // borrow it as the dictionary it is (get-rule: no extra retain, the
        // parent window dict keeps it alive for the whole loop body).
        let bounds: Dict = match window.find(CFString::new("kCGWindowBounds")) {
            Some(v) => unsafe {
                let raw = v.as_CFTypeRef();
                if raw.is_null() {
                    continue;
                }
                CFDictionary::<CFString, CFType>::wrap_under_get_rule(raw.cast())
            },
            None => continue,
        };
        let coord = |k: &str| -> f64 {
            bounds
                .find(CFString::new(k))
                .and_then(|v| v.clone().downcast_into::<CFNumber>())
                .and_then(|n| n.to_f64())
                .unwrap_or(0.0)
        };

        out.push(RawWindow {
            layer: number(window, "kCGWindowLayer").and_then(|n| n.to_i32()).unwrap_or(0),
            owner: string(window, "kCGWindowOwnerName"),
            title: string(window, "kCGWindowName"),
            x: coord("X"),
            y: coord("Y"),
            width: coord("Width"),
            height: coord("Height"),
        });
    }
    out
}

/// On-screen windows, front-to-back, for hover-to-select.
///
/// Called at capture time — before the overlay windows exist — and cached in
/// the session, so the list matches the frozen frame exactly: a context menu
/// that macOS dismisses when the overlay takes focus stays selectable, and
/// Shutter's own main/AI/pin windows are listed like any other window.
///
/// Layers 0..=101 are kept: normal windows (0), floating panels (3), the Dock
/// (20), the menu bar (24) and popup menus (101) are all things the user can
/// see and may want as "the topmost thing under my cursor". Higher layers
/// (screen-saver shields and friends) are not capture targets. The window
/// server orders the list top-to-bottom across layers, so the first hit at a
/// point is the visually topmost window. Titles need Screen Recording
/// permission, which capture already requires — without it the `title` field
/// is simply empty and the chip shows the owner.
/// A window above the normal layer that (nearly) covers a whole monitor is a
/// gesture shield: visually transparent click zones like the Dock's full-screen
/// swipe area, which every Mac has. Left in the selection list it contains
/// every point on screen and wins every hover hit-test before a real window is
/// reached — nothing but the whole screen could ever be preselected. A layer-0
/// window of the same size is a genuine fullscreen app and stays selectable,
/// and a high-layer window smaller than the monitor (menus, popovers, the Dock
/// strip) is visible content worth selecting.
#[cfg(target_os = "macos")]
fn is_gesture_shield(
    layer: i32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    monitors: &[(f64, f64, f64, f64)],
) -> bool {
    layer > 0
        && monitors.iter().any(|&(mx, my, mw, mh)| {
            x <= mx + mw * 0.05
                && y <= my + mh * 0.05
                && w >= mw * 0.95
                && h >= mh * 0.95
        })
}

#[cfg(target_os = "macos")]
pub fn list_windows() -> Result<Vec<WindowInfo>> {
    // kCGPopUpMenuWindowLevel: keep popup menus, drop screen-saver shields.
    const MAX_LAYER: i32 = 101;
    let monitors: Vec<(f64, f64, f64, f64)> = displays()?
        .into_iter()
        .map(|d| (d.info.x as f64, d.info.y as f64, d.info.width as f64, d.info.height as f64))
        .collect();
    let mut out = Vec::new();
    for raw in raw_windows() {
        if !(0..=MAX_LAYER).contains(&raw.layer) {
            continue;
        }
        // Cursor-sized tray leftovers and 1px helpers are noise for selection.
        if raw.width < 50.0 || raw.height < 50.0 {
            continue;
        }
        if is_gesture_shield(raw.layer, raw.x, raw.y, raw.width, raw.height, &monitors) {
            continue;
        }
        out.push(WindowInfo {
            id: out.len() as u64,
            x: raw.x,
            y: raw.y,
            width: raw.width,
            height: raw.height,
            owner: raw.owner,
            title: raw.title,
        });
        if out.len() >= 200 {
            break;
        }
    }
    Ok(out)
}

/// Non-macOS: window auto-detection is not wired yet; the overlay degrades to
/// free-hand selection and no highlight is shown.
#[cfg(not(target_os = "macos"))]
pub fn list_windows() -> Result<Vec<WindowInfo>> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test for the real capture path. Run with:
    ///   cargo test --lib capture::tests::capture_works -- --ignored --nocapture
    ///
    /// Requires Screen Recording permission for the test binary's parent
    /// terminal; without it macOS returns a black frame rather than an error,
    /// so the assertion checks dimensions, not content.
    #[test]
    #[ignore]
    fn capture_works() {
        let displays = displays().expect("enumerate displays");
        assert!(!displays.is_empty(), "expected at least one display");
        for d in &displays {
            println!(
                "monitor {} '{}' logical {}x{} @{}x{} scale {}",
                d.info.id, d.info.name, d.info.width, d.info.height, d.info.x, d.info.y, d.info.scale_factor
            );
            let frame = d.capture().expect("capture frame");
            println!("  frame {}x{}", frame.width(), frame.height());
            assert_eq!(frame.width(), d.info.pixel_width);
            assert_eq!(frame.height(), d.info.pixel_height);
        }
    }

    /// Dump the window server's on-screen list next to what `list_windows`
    /// keeps, so "why is window X not preselected" can be answered from the
    /// terminal. Run with:
    ///   cargo test --lib capture::tests::dump_windows -- --ignored --nocapture
    #[test]
    #[ignore]
    fn dump_windows() {
        #[cfg(target_os = "macos")]
        for w in raw_windows() {
            let shield = is_gesture_shield(
                w.layer,
                w.x,
                w.y,
                w.width,
                w.height,
                &[(0.0, 0.0, 1440.0, 900.0)],
            );
            let kept = (0..=101).contains(&w.layer)
                && w.width >= 50.0
                && w.height >= 50.0
                && !shield;
            println!(
                "{:>3} layer {:>4} ({:>5.0},{:>5.0}) {:>5.0}x{:<5.0} {:<24.24} {}",
                if kept { "in" } else { "OUT" },
                w.layer,
                w.x,
                w.y,
                w.width,
                w.height,
                w.owner,
                w.title
            );
        }
    }

    /// The Dock's full-screen swipe zone (layer 20, whole monitor) must not be
    /// selectable: it contains every point on screen and would win every
    /// hover hit-test before a real window is reached.
    #[test]
    #[cfg(target_os = "macos")]
    fn fullscreen_dock_shield_is_not_selectable() {
        let monitors = [(0.0, 0.0, 1440.0, 900.0)];
        // The exact window the Dock exposes on a 1440x900 display.
        assert!(is_gesture_shield(20, 0.0, 0.0, 1440.0, 900.0, &monitors));
        // A fullscreen app at the normal layer stays selectable.
        assert!(!is_gesture_shield(0, 0.0, 0.0, 1440.0, 900.0, &monitors));
        // The Dock strip and menus are smaller than the monitor: selectable.
        assert!(!is_gesture_shield(20, 0.0, 820.0, 1440.0, 80.0, &monitors));
        assert!(!is_gesture_shield(101, 503.0, 180.0, 434.0, 172.0, &monitors));
        // A high-layer window merely overlapping the monitor origin, but
        // offset like a real panel, is not a shield.
        assert!(!is_gesture_shield(3, 120.0, 90.0, 1200.0, 800.0, &monitors));
        // Multi-monitor: matching any one monitor's full size is enough.
        assert!(is_gesture_shield(
            20,
            1440.0,
            0.0,
            1920.0,
            1080.0,
            &[(0.0, 0.0, 1440.0, 900.0), (1440.0, 0.0, 1920.0, 1080.0)]
        ));
    }
}
