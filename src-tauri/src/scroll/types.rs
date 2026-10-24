//! IPC payloads for the long-screenshot feature — the reference command
//! surface (`open_scroll_screenshot_event`, `start_scroll_screenshot_event`,
//! `cancel_scroll_screenshot_event`, `save_scroll_screenshot`) as recovered
//! from `assets_scrollScreen-Bo1n5gwJ.js` / `index-DwzZEF1Z.js`.

use serde::{Deserialize, Serialize};

/// `open_scroll_screenshot_event`: the screenshot overlay's selection, handed
/// over 100ms after the overlay closes so the scroll panel opens onto the
/// live screen. All values are CSS px in the target monitor's coordinate
/// space; `monitor_ids` is the id of the monitor the selection lives on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenScroll {    pub x: f64,
    pub y: f64,
    pub bounds_width: f64,
    pub bounds_height: f64,
    pub monitor_ids: u32,
    pub selection_scale_factor: f64,
}

/// `start_scroll_screenshot_event`: the capture region, inset per edge (the
/// panel's `Pe` rejects the 3px outer ring) and still in CSS px.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartScroll {    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

/// `save_scroll_screenshot`: dispose of the stitched image. `action_type`
/// "copy" puts it on the clipboard (plus `auto_save_path` when set);
/// "saveAs" writes `file_path` chosen by the frontend's dialog plugin.
///
/// `monitor_id` is the stale-bar guard (reference SCROLL_BAR_OWNER_EPOCH):
/// `None` skips the check.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveScroll {    #[serde(default)]
    pub monitor_id: Option<u32>,
    pub action_type: String,
    pub file_path: String,
    pub auto_save_path: String,
}

/// `scroll_screenshot_data` → panel: window geometry plus the seeded
/// selection. `width`/`height` are the monitor's physical pixel dimensions
/// (the panel multiplies by its scale factor to size its CSS surface).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollScreenshotData {
    pub width: u32,
    pub height: u32,
    pub monitor_id: u32,
    pub bounds_width: f64,
    pub bounds_height: f64,
    pub x: f64,
    pub y: f64,
    pub selection_scale_factor: f64,
}

/// `start_screen_recording_event` → control bar: which monitor's session is
/// live. The bar stores the id and echoes it back in `save_scroll_screenshot`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StartRecordingEvent {
    pub monitor_id: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_scroll_payload_field_names_match_the_frontend() {
        // The invoke arguments arrive as camelCase; serde must accept them.
        let raw = r#"{
            "x": 10.0, "y": 20.0,
            "boundsWidth": 300.0, "boundsHeight": 400.0,
            "monitorIds": 1, "selectionScaleFactor": 2.0
        }"#;
        let v: OpenScroll = serde_json::from_str(raw).unwrap();
        assert_eq!(v.monitor_ids, 1);
        assert_eq!(v.bounds_width, 300.0);
    }

    #[test]
    fn start_scroll_payload_has_no_reference_relics() {
        // The invoke arguments arrive as camelCase; serde must accept them
        // without the reference's `label`/`screenId` fields.
        let raw = r#"{
            "x": 10.0, "y": 20.0, "width": 300.0, "height": 400.0,
            "scaleFactor": 2.0
        }"#;
        let v: StartScroll = serde_json::from_str(raw).unwrap();
        assert_eq!(v.scale_factor, 2.0);
    }

    #[test]
    fn save_scroll_accepts_reference_casing() {
        let raw = r#"{
            "monitorId": 1, "actionType": "copy",
            "filePath": "", "autoSavePath": "/tmp/a.png"
        }"#;
        let v: SaveScroll = serde_json::from_str(raw).unwrap();
        assert_eq!(v.monitor_id, Some(1));
        assert_eq!(v.action_type, "copy");
        assert_eq!(v.auto_save_path, "/tmp/a.png");
        // A bar that never learned its monitor skips the stale-guard.
        let raw = r#"{ "monitorId": null, "actionType": "copy", "filePath": "", "autoSavePath": "" }"#;
        let v: SaveScroll = serde_json::from_str(raw).unwrap();
        assert_eq!(v.monitor_id, None);
    }
}
