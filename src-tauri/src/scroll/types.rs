//! IPC payload types for the long-screenshot feature (mirrors `ipc.ts`).

use serde::{Deserialize, Serialize};

/// Which phase a scroll-capture session is in.
///
/// `Armed` mirrors the reference's `isStart` window: the session exists, the
/// first frame is captured, but scrolling has not begun — the user must move
/// the pointer INTO the selection (the frontend mask) to start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollPhase {
    Idle,
    Armed,
    Recording,
    Paused,
    Finished,
    Failed,
}

/// Live state of the scroll-capture session, pushed via `scroll://state`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollStatus {
    pub session_id: Option<String>,
    pub phase: ScrollPhase,
    /// Total height of the stitched image, in physical px.
    pub height: u32,
    /// Selection width, in physical px.
    pub width: u32,
    /// Whether the auto-scroller is injecting wheel events (vs manual mode).
    pub auto_scroll: bool,
    /// Why the auto-scroller stopped, in user-facing Chinese.
    pub note: Option<String>,
}

impl Default for ScrollStatus {
    fn default() -> Self {
        Self {
            session_id: None,
            phase: ScrollPhase::Idle,
            height: 0,
            width: 0,
            auto_scroll: false,
            note: None,
        }
    }
}

/// Preview update payload, via `scroll://preview`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollPreview {
    pub session_id: String,
    /// Atomic-replaced PNG of the stitched image so far.
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// Transient hint shown over the selection, via `scroll://tip`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollTip {
    pub session_id: String,
    /// Kind selects styling/urgency, matching the reference's state machine.
    pub kind: &'static str,
    pub text: String,
}

/// How `scroll_stop` should dispose of the stitched image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollFinishAction {
    Save,
    Copy,
    Cancel,
}

/// Result of finishing a scroll capture, via `scroll://done`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollDone {
    pub session_id: String,
    pub ok: bool,
    /// Stitched dimensions in physical px.
    pub width: u32,
    pub height: u32,
    pub message: Option<String>,
    pub saved_path: Option<String>,
}
