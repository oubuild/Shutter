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

/// On-screen standard-layer windows, front-to-back, for hover-to-select.
///
/// Only normal app windows (`kCGWindowLayer == 0`) of other processes are
/// listed; menus, the Dock and the overlay's own windows stay out. Window
/// titles need Screen Recording permission, which capture already requires —
/// without it the `title` field is simply empty and the chip shows the owner.
#[cfg(target_os = "macos")]
pub fn list_windows() -> Result<Vec<WindowInfo>> {
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
    let pid = std::process::id() as i32;

    // The result is owned (Copy), so wrap_under_create_rule is correct.
    let array = unsafe {
        let ptr = CGWindowListCopyWindowInfo(
            OPTION_ON_SCREEN_ONLY | OPTION_EXCLUDE_DESKTOP_ELEMENTS,
            0, // kCGNullWindowID
        );
        if ptr.is_null() {
            return Ok(out);
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

        // Layer 0 = normal windows; menus (24), Dock (20), overlays (101+) out.
        if number(window, "kCGWindowLayer").and_then(|n| n.to_i32()) != Some(0) {
            continue;
        }
        // Skip our own overlay/frame windows.
        if number(window, "kCGWindowOwnerPID").and_then(|n| n.to_i32()) == Some(pid) {
            continue;
        }

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
        let (x, y) = (coord("X"), coord("Y"));
        let (w, h) = (coord("Width"), coord("Height"));
        // Cursor-sized tray leftovers and 1px helpers are noise for selection.
        if w < 50.0 || h < 50.0 {
            continue;
        }

        out.push(WindowInfo {
            id: out.len() as u64,
            x,
            y,
            width: w,
            height: h,
            owner: string(window, "kCGWindowOwnerName"),
            title: string(window, "kCGWindowName"),
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
}
