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
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
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
    /// Crop for the AI window only: no clipboard write, no auto-save. Mirrors
    /// the reference tool, where an AI action only sends the request and
    /// nothing else touches the user's clipboard or disk.
    Ask,
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
    /// Draft a socially adept reply to the conversation shown in the
    /// screenshot (the reference dialog's "高情商回复" action).
    Reply,
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

/// One extraction engine card in the 识别方式 picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrProviderInfo {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    /// Download size shown on model cards, e.g. "30 MB".
    pub size_label: Option<String>,
    /// False where the engine cannot run (model cards on unsupported
    /// machines); the UI hides those cards entirely.
    pub available: bool,
    /// Model assets present in the local data dir (always true for cloud and
    /// the system engine).
    pub downloaded: bool,
    pub current: bool,
}

/// Result of one local extraction run, returned by `ocr_extract`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrExtractResult {
    pub request_id: String,
    pub provider: String,
    pub text: String,
    pub elapsed_ms: u64,
}

/// Emitted as `ocr://download` while a model artifact streams in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrDownloadProgress {
    pub provider: String,
    pub filename: String,
    pub downloaded: u64,
    pub total: Option<u64>,
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
    /// Persist every finished capture to the gallery, not only on ⌘S.
    ///
    /// `#[serde(default)]` keeps old `settings.json` files (written before this
    /// field existed) loading instead of falling back to all-defaults.
    #[serde(default = "default_true")]
    pub auto_save: bool,
    /// Global capture hotkey, as a `global-hotkey` accelerator string
    /// (`CmdOrControl+Shift+KeyA`). Registered by the backend; rebinding goes
    /// through `save_settings_cmd`, which re-registers it.
    #[serde(default = "default_capture_shortcut")]
    pub capture_shortcut: String,
    /// Global 长截图 hotkey: boots the overlay in scroll mode, so framing a
    /// selection starts the scroll session directly. Empty disables it.
    #[serde(default = "default_scroll_shortcut")]
    pub scroll_shortcut: String,
    /// Global 贴图 hotkey: boots the overlay in pin mode, so framing a
    /// selection pins it straight away. Empty disables it.
    #[serde(default = "default_pin_shortcut")]
    pub pin_shortcut: String,
    /// Where "check for updates" downloads installers from: the CNB mirror
    /// (default, mainland-friendly) or GitHub Releases.
    #[serde(default = "default_update_source")]
    pub update_source: String,
    /// Which extraction engine 提取文字 uses: cloud | system | ppocr | qota.
    ///
    /// Like `auto_save`, the serde default keeps settings files written before
    /// this field existed loading instead of falling back to all-defaults.
    #[serde(default = "default_ocr_provider")]
    pub ocr_provider: String,
    /// API key for the vision model, stored beside the rest of the settings
    /// (same `settings.json`, same directory) instead of the OS credential
    /// store — the macOS Keychain proved unreliable for this app. Plain file
    /// storage, exactly like every other persisted value.
    #[serde(default)]
    pub api_key: String,
}

fn default_true() -> bool {
    true
}

pub fn default_capture_shortcut() -> String {
    "CmdOrControl+Shift+KeyA".into()
}

pub fn default_scroll_shortcut() -> String {
    "CmdOrControl+Shift+KeyL".into()
}

pub fn default_pin_shortcut() -> String {
    "CmdOrControl+Shift+KeyR".into()
}

pub fn default_update_source() -> String {
    "cnb".into()
}

/// The system Vision engine — zero downloads, works out of the box.
pub fn default_ocr_provider() -> String {
    "system".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            translate_lang: "简体中文".into(),
            save_dir: None,
            copy_after_capture: true,
            auto_save: true,
            capture_shortcut: default_capture_shortcut(),
            scroll_shortcut: default_scroll_shortcut(),
            pin_shortcut: default_pin_shortcut(),
            update_source: default_update_source(),
            ocr_provider: default_ocr_provider(),
            api_key: String::new(),
        }
    }
}

/// One screenshot on disk, as shown in the gallery.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// Seconds since the Unix epoch, from the file's mtime.
    pub created_at: i64,
}

/// An on-screen window, for the overlay's hover-to-select.
///
/// Coordinates follow the [`MonitorInfo`] contract: **logical points** in the
/// global display space (top-left origin, y-down), so the frontend maps a
/// window onto a monitor by subtracting the monitor origin — no scaling.
/// The list is ordered front-to-back as the window server reports it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Owning process name, e.g. "Safari" (what the highlight chip shows).
    pub owner: String,
    /// Window title, when the system exposes one (needs Screen Recording).
    pub title: String,
}

/// Well-known OpenAI-compatible endpoints offered in the settings UI.
///
/// These are only suggestions: any endpoint that accepts the OpenAI chat
/// completions shape with image parts will work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub label: &'static str,
    pub base_url: &'static str,
    pub model: &'static str,
    pub note: &'static str,
}

pub fn presets() -> Vec<Preset> {
    vec![
        Preset {
            label: "DeepSeek",
            base_url: "https://api.deepseek.com",
            model: "deepseek-flash",
            note: "官方视觉模型，支持图片输入",
        },
        Preset {
            label: "通义千问 (DashScope 兼容模式)",
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            model: "qwen-vl-max",
            note: "需选择带 -vl- 的视觉模型",
        },
        Preset {
            label: "OpenAI",
            base_url: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            note: "任意支持 image_url 的模型",
        },
        Preset {
            label: "本地 Ollama",
            base_url: "http://127.0.0.1:11434/v1",
            model: "llava",
            note: "本地推理，数据不出机器",
        },
    ]
}
