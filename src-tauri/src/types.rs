//! Shared data types crossing the IPC boundary.
//!
//! Coordinate contract (important, read before touching capture code):
//! * `MonitorInfo.width/height` are **logical points** as reported by the OS
//!   (`CGDisplayBounds`), which is also what CSS px map to inside a webview that
//!   covers exactly that monitor.
//! * `MonitorInfo.pixel_width/pixel_height` are **physical pixels**
//!   (`bounds * scale_factor`), which is the size of the captured `RgbaImage`.
//! * The webview sends `Rect` in CSS px relative to the monitor's top-left.
//!   Rust multiplies by `scale_factor` exactly once, in [`crate::compose`].

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    /// Logical origin in the global display space (can be negative).
    pub x: i32,
    pub y: i32,
    /// Logical size in points.
    pub width: u32,
    pub height: u32,
    /// Physical size in pixels.
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSession {
    pub session_id: String,
    pub monitors: Vec<MonitorInfo>,
}

/// Selection rectangle in CSS px, relative to the monitor origin.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the user asked for when confirming a screenshot.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureAction {
    Copy,
    Save,
    Pin,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// Handle for [`crate::ai::ai_ask`]; the PNG bytes stay in Rust.
    pub crop_id: String,
    /// Small PNG data URL for immediate display in the UI.
    pub preview_data_url: String,
    pub width: u32,
    pub height: u32,
    /// Present when the action wrote a file or the clipboard.
    pub message: Option<String>,
    /// Absolute path when the image was persisted to disk.
    pub saved_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiAction {
    /// Transcribe the text in the image verbatim.
    Extract,
    /// Translate the text into `lang`.
    Translate,
    /// Explain what the screenshot shows.
    Explain,
    /// Free-form instruction supplied by the user.
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub crop_id: String,
    pub action: AiAction,
    /// Target language for [`AiAction::Translate`].
    #[serde(default)]
    pub lang: Option<String>,
    /// User instruction for [`AiAction::Ask`].
    #[serde(default)]
    pub question: Option<String>,
}

/// Emitted as `ai://delta` while streaming.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDelta {
    pub request_id: String,
    pub text: String,
}

/// Emitted once as `ai://done`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDone {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// OpenAI-compatible base URL, e.g. `https://api.deepseek.com`.
    pub base_url: String,
    /// Model name, e.g. `deepseek-flash`.
    pub model: String,
    /// Default target language for the translate action.
    pub translate_lang: String,
    pub save_dir: Option<String>,
    pub copy_after_capture: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            translate_lang: "简体中文".into(),
            save_dir: None,
            copy_after_capture: true,
        }
    }
}
