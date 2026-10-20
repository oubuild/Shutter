//! Screen enumeration and raw frame capture.

use crate::types::MonitorInfo;
use anyhow::{Context, Result};
use image::RgbaImage;
use xcap::Monitor;

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
